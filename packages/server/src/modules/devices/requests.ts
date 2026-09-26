/**
 * Capability requests: something asks one of a person's devices for its location, a photo, the
 * clipboard …, the device shows its consent sheet and answers (contract decision §14, §74).
 *
 * - **A request is a job** (`device_request`): `createRequest` answers `202 {job_id,
 *   request_id}` at once and the job ends when the device answers — succeeded when it fulfils,
 *   failed when it declines, fails or does not answer in time, cancelled when someone cancels
 *   the job. The job carries only the request's id and outcome: what the device sent (a
 *   location) stays in the request row, which only the person and the device may read, because
 *   every member of the profile sees its jobs.
 * - **Only the addressed device hears it**: `request.created` goes to that device's sockets on
 *   `/rt/devices` (they join `device:<id>` when they connect); `request.completed` goes to the
 *   person, whose sockets include the device's.
 * - **A capability the device did not declare, or switched off, is declined by the hub** at once
 *   (`denied`, `unavailable`), without bothering the device.
 * - **Only the device answers**, once. A request that is no longer pending answers `409`.
 * - Unanswered by `expires_at` (the requester's `timeout_ms`, 30 s by default): `expired` with
 *   `timeout`. Checked by a timer, and again whenever a request is read — a hub that restarted
 *   has no timers left, and the row still says the truth.
 *
 * Proposed — owner to confirm: only the device's own person may ask it (their web session, or
 * a token of theirs with the `device` scope); an admin may not ask someone else's phone where it
 * is. Somebody else's device is `404`, as everywhere in this module.
 */
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { newUlid } from '../../db/ids.js';
import { t, type Language } from '../../i18n/index.js';
import type { ModuleDb } from '../../lib/db.js';
import { HubError, conflict } from '../../lib/errors.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import {
  deviceRequests,
  devices,
  type CapabilityKind,
  type DeviceRequestErrorCode,
  type DeviceRequestStatus,
} from './schema.js';

export type DeviceRequestRow = typeof deviceRequests.$inferSelect;

/** What `devices` needs from the job runner (audit), lent by the composition root. */
export interface RequestJobHandle {
  readonly id: string;
  cancelRequested(): boolean;
}
export interface RequestJobs {
  start(
    job: {
      workspace: string;
      ownerId: string;
      kind: string;
      entityKind: string;
      entityId: string;
      input: Record<string, unknown>;
    },
    work: (handle: RequestJobHandle) => Promise<Record<string, unknown> | void>,
  ): { id: string };
}

export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * What a request waits for when the asker does not say (§89): a computer's helper reads a file
 * in a moment but may first ask the person; a program's call may ask and then run a while (a
 * long one answers "running" before this and is followed with `op: status`).
 */
const TIMEOUTS: Partial<Record<CapabilityKind, number>> = { files: 60_000, apps: 120_000 };
export function defaultTimeoutFor(capability: CapabilityKind): number {
  return TIMEOUTS[capability] ?? DEFAULT_TIMEOUT_MS;
}
/** What an agent's run may ask the person's own computer for (§89). */
export const AGENT_CAPABILITIES: ReadonlySet<CapabilityKind> = new Set(['files', 'apps']);
/**
 * Capabilities only a connected computer serves: asked of one that is offline, the answer is
 * "offline" at once instead of a wait for a device that cannot hear it (§89). A phone's
 * capabilities keep §74's catch-up on reconnect.
 */
const LIVE_ONLY: ReadonlySet<CapabilityKind> = new Set(['files', 'apps', 'screen']);
/** How often a waiting job looks whether someone cancelled it. */
const CANCEL_POLL_MS = 250;
/** The room a device's own sockets join on `/rt/devices`. */
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;

type DeviceError = { code: DeviceRequestErrorCode; message: string | null };

/** The contract's `DeviceRequest`. */
export function serializeRequest(row: DeviceRequestRow, profile: string) {
  const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    device_id: row.deviceId,
    session_id: row.sessionId,
    run_id: row.runId,
    job_id: row.jobId,
    capability: row.capability,
    purpose: row.purpose,
    params: row.params,
    status: row.status,
    expires_at: iso(row.expiresAt),
    result: row.result ?? null,
    error: row.error ?? null,
  };
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * A fulfilled answer must be the one shape its capability has (§14): a location is
 * `{latitude, longitude, accuracy_m, captured_at}`. Other capabilities are the device's.
 */
export function checkResult(capability: CapabilityKind, result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new HubError('validation_failed', { details: { field: 'result', reason: 'required' } });
  }
  const value = result as Record<string, unknown>;
  if (capability === 'location') {
    const ok =
      isNumber(value.latitude) &&
      value.latitude >= -90 &&
      value.latitude <= 90 &&
      isNumber(value.longitude) &&
      value.longitude >= -180 &&
      value.longitude <= 180 &&
      isNumber(value.accuracy_m) &&
      value.accuracy_m >= 0 &&
      typeof value.captured_at === 'string' &&
      !Number.isNaN(Date.parse(value.captured_at));
    if (!ok) {
      throw new HubError('validation_failed', {
        details: {
          field: 'result',
          reason: 'not_a_location',
          expected: ['latitude', 'longitude', 'accuracy_m', 'captured_at'],
        },
      });
    }
    return {
      latitude: value.latitude,
      longitude: value.longitude,
      accuracy_m: value.accuracy_m,
      captured_at: new Date(Date.parse(value.captured_at as string))
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    };
  }
  if (capability === 'apps') {
    // A program's call is either finished (its MCP result) or still running (§89).
    const running = value.state === 'running' && typeof value.call_id === 'string';
    const done = value.state === 'done' && Array.isArray(value.content);
    if (!running && !done) {
      throw new HubError('validation_failed', {
        details: { field: 'result', reason: 'not_a_program_result', expected: ['state'] },
      });
    }
  }
  if (capability === 'files') {
    const content = Array.isArray(value.content);
    const file = typeof value.attachment_id === 'string';
    if (!content && !file) {
      throw new HubError('validation_failed', {
        details: { field: 'result', reason: 'not_a_files_result', expected: ['content'] },
      });
    }
  }
  return value;
}

interface Outcome {
  status: DeviceRequestStatus;
  error: DeviceError | null;
}

/** One hub's requests: the rows, the timers and the jobs waiting for an answer. */
export class DeviceRequestService {
  private readonly waiters = new Map<string, (outcome: Outcome) => void>();
  /** An outcome that arrived before its job was listening (an immediate decline). */
  private readonly early = new Map<string, Outcome>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly realtime: Realtime;
  private closed = false;

  constructor(
    private readonly options: {
      db: ModuleDb;
      io: SocketServer;
      jobs: RequestJobs;
      now: () => number;
      /** The person's language for the hub's own sentences (a timeout, an undeclared capability). */
      languageOf: (userId: string) => Language;
    },
  ) {
    this.realtime = createRealtime(options.io, () => new Date(options.now()));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waiters.clear();
    this.early.clear();
  }

  /** Asks the device. The caller has already checked who may ask it. */
  create(input: {
    workspace: { id: string; slug: string };
    ownerId: string;
    device: typeof devices.$inferSelect;
    capability: CapabilityKind;
    purpose: string | null;
    params: Record<string, unknown>;
    sessionId: string | null;
    runId?: string | null;
    timeoutMs: number;
    /** Whether the device has a live `/rt/devices` socket now. */
    online?: boolean;
  }): { jobId: string; request: DeviceRequestRow } {
    const { db, now } = this.options;
    const id = newUlid(now());
    const offered = input.device.capabilities.find((c) => c.kind === input.capability);
    const language = this.languageOf(input.ownerId);
    const declined: DeviceError | null =
      offered && offered.enabled
        ? null
        : {
            code: 'unavailable',
            message: t('devices.request.capability_off', language).replace(
              '{capability}',
              input.capability,
            ),
          };
    // Nobody would hear it: said at once, as a failure the asker can tell the person (§89).
    const offline: DeviceError | null =
      !declined && input.online === false && LIVE_ONLY.has(input.capability)
        ? {
            code: 'unavailable',
            message: t('devices.request.offline', language).replace('{device}', input.device.name),
          }
        : null;

    const job = this.options.jobs.start(
      {
        workspace: input.workspace.id,
        ownerId: input.ownerId,
        kind: 'devices.device_request',
        entityKind: 'device_request',
        entityId: id,
        input: { device_id: input.device.id, capability: input.capability },
      },
      (handle) => this.wait(id, handle, input.ownerId),
    );

    const at = new Date(now());
    const row = db
      .insert(deviceRequests)
      .values({
        id,
        workspace: input.workspace.id,
        ownerId: input.ownerId,
        deviceId: input.device.id,
        capability: input.capability,
        purpose: input.purpose,
        params: input.params,
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        jobId: job.id,
        status: declined ? 'denied' : offline ? 'failed' : 'pending',
        expiresAt: new Date(at.getTime() + input.timeoutMs),
        error: declined ?? offline,
        answeredAt: declined || offline ? at : null,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();

    if (declined) {
      this.completed(row, input.workspace.slug);
      this.settle(id, { status: 'denied', error: declined });
      return { jobId: job.id, request: row };
    }
    if (offline) {
      this.completed(row, input.workspace.slug);
      this.settle(id, { status: 'failed', error: offline });
      return { jobId: job.id, request: row };
    }
    this.realtime.emit(
      REALTIME_NAMESPACES.devices,
      'request.created',
      { profile: input.workspace.slug, room: deviceRoom(input.device.id) },
      { request: serializeRequest(row, input.workspace.slug) },
    );
    this.arm(row, input.workspace.slug);
    return { jobId: job.id, request: row };
  }

  /** The request in this profile, with its expiry applied; null when there is none. */
  find(workspace: { id: string; slug: string }, id: string): DeviceRequestRow | null {
    const row = this.options.db
      .select()
      .from(deviceRequests)
      .where(and(eq(deviceRequests.id, id), eq(deviceRequests.workspace, workspace.id)))
      .get();
    if (!row) return null;
    return this.expireIfDue(row, workspace.slug);
  }

  /** A page of requests: the device's own, or those addressed to any device of the person. */
  list(input: {
    workspace: { id: string; slug: string };
    userId: string;
    deviceId: string | null;
    status: DeviceRequestStatus | null;
    cursor: string | undefined;
    limit: number | undefined;
  }) {
    const { db } = this.options;
    this.expireDue(input.workspace);
    const limit = clampLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const mine = db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.ownerId, input.userId))
      .all()
      .map((row) => row.id);
    const deviceIds = input.deviceId ? mine.filter((id) => id === input.deviceId) : mine;
    if (deviceIds.length === 0) return { items: [], next_cursor: null };
    const rows = db
      .select()
      .from(deviceRequests)
      .where(
        and(
          eq(deviceRequests.workspace, input.workspace.id),
          inArray(deviceRequests.deviceId, deviceIds),
          input.status ? eq(deviceRequests.status, input.status) : undefined,
          after ? gt(deviceRequests.id, after) : undefined,
        ),
      )
      .orderBy(asc(deviceRequests.id))
      .limit(limit + 1)
      .all();
    return pageOf(rows, limit, (row) => serializeRequest(row, input.workspace.slug));
  }

  /** The device's answer. The caller has checked that the device is the addressed one. */
  respond(
    workspace: { id: string; slug: string },
    row: DeviceRequestRow,
    answer: { status: 'fulfilled' | 'denied' | 'failed'; result?: unknown; error?: unknown },
  ): DeviceRequestRow {
    if (row.status !== 'pending') {
      throw conflict({ reason: 'request_not_pending', status: row.status });
    }
    let result: Record<string, unknown> | null = null;
    let error: DeviceError | null = null;
    const given = answer.error as { code?: DeviceRequestErrorCode; message?: string | null } | null;
    if (answer.status === 'fulfilled') {
      result = checkResult(row.capability, answer.result);
    } else if (answer.status === 'denied') {
      error = { code: given?.code ?? 'permission_denied', message: given?.message ?? null };
    } else {
      error = { code: given?.code ?? 'failed', message: given?.message ?? null };
    }
    const next = this.finish(row.id, workspace.slug, answer.status, { result, error });
    if (!next) {
      // Answered or expired between the read and the write.
      const now = this.find(workspace, row.id);
      throw conflict({ reason: 'request_not_pending', status: now?.status ?? 'expired' });
    }
    return next;
  }

  // ---------------------------------------------------------------- internals

  private languageOf(userId: string): Language {
    try {
      return this.options.languageOf(userId);
    } catch {
      return 'en';
    }
  }

  /** The job's worker: waits for the answer, or for someone to cancel the job. */
  private wait(id: string, handle: RequestJobHandle, ownerId: string) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const poll = setInterval(() => {
        if (!handle.cancelRequested()) return;
        const row = this.options.db
          .select()
          .from(deviceRequests)
          .where(eq(deviceRequests.id, id))
          .get();
        if (!row) return;
        const slug = this.slugOf(id);
        this.finish(id, slug, 'cancelled', {
          result: null,
          error: {
            code: 'cancelled',
            message: t('devices.request.cancelled', this.languageOf(ownerId)),
          },
        });
      }, CANCEL_POLL_MS);
      poll.unref();
      const done = (outcome: Outcome) => {
        clearInterval(poll);
        if (outcome.status === 'fulfilled' || outcome.status === 'cancelled') {
          resolve({ request_id: id, status: outcome.status });
          return;
        }
        const language = this.languageOf(ownerId);
        const message =
          outcome.error?.message ??
          t(
            outcome.status === 'expired'
              ? 'devices.request.timeout'
              : outcome.status === 'denied'
                ? 'devices.request.denied'
                : 'devices.request.failed',
            language,
          );
        reject(
          new HubError(outcome.status === 'denied' ? 'forbidden' : 'service_unavailable', {
            message,
            details: { request_id: id, status: outcome.status, code: outcome.error?.code },
          }),
        );
      };
      const early = this.early.get(id);
      if (early) {
        this.early.delete(id);
        done(early);
        return;
      }
      this.waiters.set(id, done);
    });
  }

  /** Profile slugs of the requests armed in this process, for the timer and the cancel. */
  private readonly slugs = new Map<string, string>();
  private slugOf(id: string): string {
    return this.slugs.get(id) ?? '';
  }

  private arm(row: DeviceRequestRow, slug: string): void {
    if (this.closed) return;
    this.slugs.set(row.id, slug);
    const delay = Math.max(0, row.expiresAt.getTime() - this.options.now());
    const timer = setTimeout(() => {
      this.timers.delete(row.id);
      const current = this.options.db
        .select()
        .from(deviceRequests)
        .where(eq(deviceRequests.id, row.id))
        .get();
      if (current) this.expireIfDue(current, slug, true);
    }, delay);
    timer.unref();
    this.timers.set(row.id, timer);
  }

  private expireIfDue(row: DeviceRequestRow, slug: string, force = false): DeviceRequestRow {
    if (row.status !== 'pending') return row;
    if (!force && row.expiresAt.getTime() > this.options.now()) return row;
    return (
      this.finish(row.id, slug, 'expired', {
        result: null,
        error: {
          code: 'timeout',
          message: t('devices.request.timeout', this.languageOf(row.ownerId)),
        },
      }) ?? row
    );
  }

  private expireDue(workspace: { id: string; slug: string }): void {
    const due = this.options.db
      .select()
      .from(deviceRequests)
      .where(
        and(
          eq(deviceRequests.workspace, workspace.id),
          eq(deviceRequests.status, 'pending'),
          lte(deviceRequests.expiresAt, new Date(this.options.now())),
        ),
      )
      .all();
    for (const row of due) this.expireIfDue(row, workspace.slug);
  }

  /** Moves a pending request to a final state, once; null when it was no longer pending. */
  private finish(
    id: string,
    slug: string,
    status: Exclude<DeviceRequestStatus, 'pending'>,
    fields: { result: Record<string, unknown> | null; error: DeviceError | null },
  ): DeviceRequestRow | null {
    const at = new Date(this.options.now());
    const row = this.options.db
      .update(deviceRequests)
      .set({ status, result: fields.result, error: fields.error, answeredAt: at, updatedAt: at })
      .where(and(eq(deviceRequests.id, id), eq(deviceRequests.status, 'pending')))
      .returning()
      .get();
    if (!row) return null;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.slugs.delete(id);
    this.completed(row, slug);
    this.settle(id, { status, error: fields.error });
    return row;
  }

  private completed(row: DeviceRequestRow, slug: string): void {
    if (this.closed) return;
    // The person's sockets, which include the device's own (every socket joins its user room).
    this.realtime.emit(
      REALTIME_NAMESPACES.devices,
      'request.completed',
      { profile: slug, userId: row.ownerId },
      { request: serializeRequest(row, slug) },
    );
  }

  private settle(id: string, outcome: Outcome): void {
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(outcome);
      return;
    }
    this.early.set(id, outcome);
  }
}

const services = new WeakMap<SocketServer, DeviceRequestService>();

export function requestsFor(
  app: FastifyInstance,
  make: () => DeviceRequestService,
): DeviceRequestService {
  const existing = services.get(app.hub.io);
  if (existing) return existing;
  const service = make();
  services.set(app.hub.io, service);
  return service;
}

export function closeRequests(app: FastifyInstance): void {
  services.get(app.hub.io)?.close();
  services.delete(app.hub.io);
}

/** The scope the route guards put on a request (auth's `requireWorkspace`). */
export function workspaceOf(request: FastifyRequest): { id: string; slug: string } {
  const workspace = request.workspace;
  if (!workspace) throw new HubError('internal', { message: 'route has no workspace' });
  return { id: workspace.id, slug: workspace.slug };
}
