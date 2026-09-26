// Module `devices`: phones, computers and browsers linked to the hub, and push to them.
// Public surface of the module: other modules and app/ import this file only.
//
// What answers (DECISIONS §66): the registry (list, read, rename, unlink, register a
// browser), push registration, the push senders (Web Push with the hub's own VAPID keys,
// FCM, APNs) and a test push; and capability requests (DECISIONS §14, §74; `requests.ts`).
// The way in from outside for a hub the desktop app runs (`getRelay` / `setRelay`, DECISIONS
// §95; `outside.ts`). Linked hubs (ADR 0026, DECISIONS §101; `peers.ts`).
//
// `auth` imports this module (pairing creates the device row), so this module does not
// import `auth`: what it needs from it — the route guards, revoking a token, reaching a
// person's sockets — is lent by the composition root (`createDevicesModule`).
import { and, asc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument, serverBasePath } from '@corehub/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite, type ModuleDb } from '../../lib/db.js';
import { HubError, conflict, notFound } from '../../lib/errors.js';
import { REALTIME_NAMESPACES, defineModule, type HubModule } from '../../lib/module.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { defineRoute, type RouteGuards } from '../../lib/route.js';
import {
  PushConfigError,
  PushService,
  type PushEnvInput,
  type Sealer,
  type SenderUpdate,
} from './push.js';
import { parseSubscription } from './webpush.js';
import {
  AGENT_CAPABILITIES,
  DeviceRequestService,
  defaultTimeoutFor,
  closeRequests,
  deviceRoom,
  requestsFor,
  serializeRequest,
  workspaceOf,
  type RequestJobs,
} from './requests.js';
import type { Language } from '../../i18n/index.js';
import type { PushMessage, PushProvider } from './senders.js';
import type { RelayProof } from './relay.js';
import { changeRelay, readRelay, type RelayChange } from './outside.js';
import { registerPeerRoutes, type PeerAgentsPort } from './peers.js';
import {
  devices,
  type DeviceHelperReport,
  type DeviceRequestStatus,
  type CapabilityKind,
  type DeviceConnection,
  type DeviceKind,
  type DevicePlatform,
  type PushBlocker,
} from './schema.js';

export type DeviceRow = typeof devices.$inferSelect;
export type {
  CapabilityKind,
  DeviceConnection,
  DeviceKind,
  DevicePlatform,
  PushBlocker,
} from './schema.js';
export {
  CAPABILITY_KINDS,
  DEVICE_CONNECTIONS,
  DEVICE_KINDS,
  DEVICE_PLATFORMS,
  PUSH_BLOCKERS,
} from './schema.js';
export type { DeliveryResult, Sealer } from './push.js';
export type { PushMessage, PushProvider } from './senders.js';
export type { RequestJobHandle, RequestJobs } from './requests.js';
export {
  RelayHostRefusal,
  relayPairingUrl,
  type RelayChange,
  type RelayHost,
  type RelayHostState,
  type RelayView,
} from './outside.js';

/** What the composition root lends this module (it may not import `auth` or `notify`). */
export interface DevicesPorts {
  guards: RouteGuards;
  /** Revoke an app token and drop the sockets it admitted (auth). */
  revokeAppToken(app: FastifyInstance, tokenId: string, now: number): void;
  /** Emit a user-level event to every socket of one person (auth's rooms). */
  emitToUser(
    io: SocketServer | null,
    userId: string,
    namespace: string,
    event: string,
    payload: Record<string, unknown>,
    now: number,
  ): void;
  /** notify's address rule: may the hub POST to this URL? */
  checkAddress(
    url: string,
    allowPrivate: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string; detail: string }>;
  /** The hub's data key ring (models). */
  sealer(app: FastifyInstance): Sealer;
  /** The job runner (audit), for capability requests: a request is a `device_request` job. */
  jobs(app: FastifyInstance): RequestJobs;
  /** A person's language, for the hub's own sentences in a request (auth). */
  userLanguage(app: FastifyInstance, userId: string): Language;
  /**
   * Is this `app_tokens` row (a sign-in session or a pairing token) still good — not revoked,
   * not expired, its person active (auth)? A push registration lives only as long as it.
   */
  sessionLive(db: ModuleDb, tokenId: string, now: number): boolean;
  /** Linked hubs (ADR 0026): the agents a peer may be shown, and asking one without tools. */
  peerAgents: PeerAgentsPort;
}

/** Test seams: fakes for the push services, and permission to call 127.0.0.1. */
export interface DevicesOverrides {
  fetchImpl?: typeof fetch;
  fcmBaseUrl?: string;
  apnsOrigin?: string;
  /** The push relay's `fetch`: a fake relay (`testing/fake-relay.ts`). */
  relayFetch?: typeof fetch;
  /** Lets a Web Push endpoint be `http:` and private (tests and the e2e fake push service). */
  allowPrivateEndpoints?: boolean;
  now?: () => number;
  /** How long `getRelay` / `setRelay` wait for the desktop app (`outside.ts`). */
  relayHostTimeoutMs?: number;
  /** The `fetch` linked-hub calls go through: the two-hub test routes them in process. */
  peerFetch?: typeof fetch;
  /** The peer guest's answer, in place of the agent's (the two-hub test has no model). */
  peerAsk?: (input: {
    workspaceId: string;
    agentId: string;
    prompt: string;
  }) => Promise<string | null>;
}
let overrides: DevicesOverrides = {};
export function overrideDevices(next: DevicesOverrides): void {
  overrides = next;
}

let ports: DevicesPorts | null = null;
/** How often the hub checks whether its tokens are due to be re-stated to the push relay. */
const RELAY_SYNC_TICK_MS = 60_000;
const services = new WeakMap<SocketServer, PushService>();
/** Each hub's database, for the socket handlers (a socket has no request). */
const databases = new WeakMap<SocketServer, ModuleDb>();

/** The push service of one hub. `notify` reaches it through the composition root. */
export function pushFor(app: FastifyInstance): PushService {
  const existing = services.get(app.hub.io);
  if (existing) return existing;
  if (!ports) throw new Error('devices: the module was not created with its ports');
  const lent = ports;
  const allowPrivate = overrides.allowPrivateEndpoints ?? false;
  const service = new PushService({
    db: requireSqlite(app.hub.database),
    dataDir: app.hub.config.dataDir,
    env: (app.hub.config as { push?: PushEnvInput }).push,
    sealer: lent.sealer(app),
    sessionLive: (tokenId, at) => lent.sessionLive(requireSqlite(app.hub.database), tokenId, at),
    checkEndpoint: async (endpoint) => {
      if (!allowPrivate && !endpoint.startsWith('https://')) return 'the endpoint is not https';
      const verdict = await lent.checkAddress(endpoint, allowPrivate);
      return verdict.ok ? null : `the endpoint is refused (${verdict.reason}: ${verdict.detail})`;
    },
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.fcmBaseUrl ? { fcmBaseUrl: overrides.fcmBaseUrl } : {}),
    ...(overrides.apnsOrigin ? { apnsOrigin: overrides.apnsOrigin } : {}),
    ...(overrides.relayFetch ? { relayFetch: overrides.relayFetch } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  services.set(app.hub.io, service);
  return service;
}

// ------------------------------------------------------------------ registry rows

/** The contract's `DeviceRegistration` plus who owns the device and which token it got. */
export interface PairedDeviceInput {
  ownerId: string;
  deviceKey: string;
  name: string;
  platform: DevicePlatform;
  kind: DeviceKind;
  brand: string | null;
  model: string | null;
  appVersion: string | null;
  /** Optional: an app older than the field does not send it, and the row keeps what it had. */
  osVersion?: string | null | undefined;
  pushBlocker?: PushBlocker | null | undefined;
  capabilities: readonly CapabilityKind[];
  connection: DeviceConnection;
  appTokenId: string;
}

/**
 * The name a device row takes when the device describes itself again: a name a person gave
 * it (`devices.update`) stays; otherwise the device's own.
 */
export function nameAfterReport(existing: DeviceRow | undefined, reported: string): string {
  return existing?.renamedAt ? existing.name : reported;
}

/**
 * Creates the device row, or re-pairs the same device (same owner + `device_key`) in place.
 * Returns the previous token id so the caller (auth) can revoke it.
 */
export function registerPairedDevice(
  db: ModuleDb,
  input: PairedDeviceInput,
  now: number,
): { device: DeviceRow; previousTokenId: string | null } {
  const existing = db
    .select()
    .from(devices)
    .where(and(eq(devices.ownerId, input.ownerId), eq(devices.deviceKey, input.deviceKey)))
    .get();
  const capabilities = input.capabilities.map((kind) => {
    const known = existing?.capabilities.find((c) => c.kind === kind);
    return { kind, enabled: true, consentAt: known?.consentAt ?? null };
  });
  // A row that was unlinked starts over: the name a person gave it went with it.
  const kept = existing?.status === 'paired' ? existing : undefined;
  const values = {
    name: nameAfterReport(kept, input.name),
    ...(kept ? {} : { renamedAt: null }),
    platform: input.platform,
    kind: input.kind,
    brand: input.brand,
    model: input.model,
    appVersion: input.appVersion,
    ...(input.osVersion !== undefined ? { osVersion: input.osVersion } : {}),
    ...(input.pushBlocker !== undefined ? { pushBlocker: input.pushBlocker } : {}),
    connection: input.connection,
    capabilities,
    status: 'paired' as const,
    appTokenId: input.appTokenId,
    pairedAt: new Date(now),
    lastSeenAt: new Date(now),
    revokedAt: null,
  };
  if (existing) {
    const device = db
      .update(devices)
      .set(values)
      .where(eq(devices.id, existing.id))
      .returning()
      .get()!;
    return { device, previousTokenId: existing.appTokenId ?? null };
  }
  const device = db
    .insert(devices)
    .values({ ownerId: input.ownerId, deviceKey: input.deviceKey, ...values })
    .returning()
    .get();
  return { device, previousTokenId: null };
}

export function findDevice(db: ModuleDb, id: string): DeviceRow | null {
  return db.select().from(devices).where(eq(devices.id, id)).get() ?? null;
}

/** Nothing is pushed to a device that is gone: its push registration goes with it. */
const REVOKED_PUSH = {
  pushProvider: 'none' as const,
  pushToken: null,
  pushRegisteredAt: null,
  pushSessionId: null,
};

/**
 * A sign-in ended (sign-out, a revoked token, a password change, a re-pair): the push
 * registrations it made are forgotten, so nothing reaches a phone that is no longer signed
 * in. A row registered before `push_session_id` existed answers to its pairing token.
 * Returns the devices that lost their registration.
 */
export function endPushForSessions(db: ModuleDb, tokenIds: readonly string[]): DeviceRow[] {
  if (tokenIds.length === 0) return [];
  return db
    .update(devices)
    .set(REVOKED_PUSH)
    .where(
      and(
        ne(devices.pushProvider, 'none'),
        or(
          inArray(devices.pushSessionId, [...tokenIds]),
          and(isNull(devices.pushSessionId), inArray(devices.appTokenId, [...tokenIds])),
        ),
      ),
    )
    .returning()
    .all();
}

/**
 * A person can no longer sign in at all (disabled, deleted, the owner reset): every push
 * registration of theirs goes, a browser's included.
 */
export function endPushForOwners(db: ModuleDb, userIds: readonly string[]): DeviceRow[] {
  if (userIds.length === 0) return [];
  return db
    .update(devices)
    .set(REVOKED_PUSH)
    .where(and(ne(devices.pushProvider, 'none'), inArray(devices.ownerId, [...userIds])))
    .returning()
    .all();
}

/** Marks the device revoked when its pairing token is revoked; null when no device holds it. */
export function revokeDeviceByToken(
  db: ModuleDb,
  appTokenId: string,
  now: number,
): DeviceRow | null {
  const row = db.select().from(devices).where(eq(devices.appTokenId, appTokenId)).get();
  if (!row) return null;
  if (row.status === 'revoked') return row;
  return (
    db
      .update(devices)
      .set({ status: 'revoked', revokedAt: new Date(now), ...REVOKED_PUSH })
      .where(eq(devices.id, row.id))
      .returning()
      .get() ?? null
  );
}

export interface SerializeDeviceOptions {
  /** Has a live `/rt/devices` socket. */
  online: boolean;
  /** True when the reader is this very device. */
  thisDevice: boolean;
}

/** The contract's `Device`. */
export function serializeDevice(row: DeviceRow, options: SerializeDeviceOptions) {
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return {
    id: row.id,
    user_id: row.ownerId,
    device_key: row.deviceKey,
    name: row.name,
    platform: row.platform,
    kind: row.kind,
    brand: row.brand,
    model: row.model,
    os_version: row.osVersion,
    app_version: row.appVersion,
    connection: row.connection,
    online: options.online,
    last_seen_at: iso(row.lastSeenAt),
    paired_at: row.pairedAt.toISOString(),
    app_token_id: row.appTokenId,
    capabilities: row.capabilities.map((c) => ({
      kind: c.kind,
      enabled: c.enabled,
      consent_at: c.consentAt === null ? null : new Date(c.consentAt).toISOString(),
    })),
    push:
      row.pushProvider === 'none' || !row.pushRegisteredAt
        ? null
        : {
            provider: row.pushProvider,
            locale: row.pushLocale === 'en' ? ('en' as const) : ('ar' as const),
            registered_at: row.pushRegisteredAt.toISOString(),
          },
    push_blocker: row.pushBlocker ?? null,
    this_device: options.thisDevice,
    profiles: row.profiles ?? null,
    helper: row.helper ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ------------------------------------------------------------------ presence

type SocketPrincipal = { principal?: { deviceId?: string | null } };
const deviceOfSocket = (data: unknown): string | null =>
  (data as SocketPrincipal).principal?.deviceId ?? null;

/** Device ids with a live `/rt/devices` socket right now (the socket's verified principal). */
function onlineDevices(io: SocketServer | null): Set<string> {
  const online = new Set<string>();
  if (!io) return online;
  for (const socket of io.of(REALTIME_NAMESPACES.devices).sockets.values()) {
    const deviceId = deviceOfSocket(socket.data);
    if (deviceId) online.add(deviceId);
  }
  return online;
}

export const SEEN_WRITE_INTERVAL_MS = 60_000;
/** Past this many entries, the throttle forgets the ones older than the interval. */
const SEEN_MEMORY_LIMIT = 2_000;
const lastSeenWrites = new Map<string, number>();

/** Whether `key` (a device, or a sign-in) is due a `last_seen_at` write, and notes it if so. */
function seenDue(key: string, at: number, force: boolean): boolean {
  const last = lastSeenWrites.get(key) ?? 0;
  if (!force && at - last < SEEN_WRITE_INTERVAL_MS) return false;
  if (lastSeenWrites.size >= SEEN_MEMORY_LIMIT) {
    for (const [other, when] of lastSeenWrites)
      if (at - when >= SEEN_WRITE_INTERVAL_MS) lastSeenWrites.delete(other);
  }
  lastSeenWrites.set(key, at);
  return true;
}

/** Records that a device was seen, at most once a minute (a write per request is waste). */
function touch(db: ModuleDb, deviceId: string, at: number, force = false): void {
  if (!seenDue(`device:${deviceId}`, at, force)) return;
  db.update(devices)
    .set({ lastSeenAt: new Date(at) })
    .where(and(eq(devices.id, deviceId), eq(devices.status, 'paired')))
    .run();
}

/**
 * The same for a device that signed in instead of pairing (a phone with a password, a
 * browser): the calls of the sign-in that registered it are its activity. At most once a
 * minute per sign-in.
 */
function touchBySession(db: ModuleDb, tokenId: string, at: number): void {
  if (!seenDue(`session:${tokenId}`, at, false)) return;
  db.update(devices)
    .set({ lastSeenAt: new Date(at) })
    .where(and(eq(devices.seenSessionId, tokenId), eq(devices.status, 'paired')))
    .run();
}

// ------------------------------------------------------------------ routes

type Principal = NonNullable<FastifyRequest['principal']>;

const principalOf = (request: FastifyRequest): Principal => {
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  return principal;
};

const isAdmin = (principal: Principal) =>
  principal.user.role === 'owner' || principal.user.role === 'admin';

/** An agent's run acting for its person (auth `run-tokens.ts`): pinned to the run's profile. */
const isRunPrincipal = (principal: Principal) => principal.user.pinnedWorkspaceId !== undefined;

/** The device, if the caller may see it: its owner, the device itself, or an admin. */
function visibleDevice(db: ModuleDb, principal: Principal, id: string): DeviceRow {
  const row = findDevice(db, id);
  if (!row || row.status !== 'paired') throw notFound({ resource: 'device', id });
  if (row.ownerId !== principal.user.id && !isAdmin(principal)) {
    // Somebody else's device is not "forbidden", it is not there — its id says nothing.
    throw notFound({ resource: 'device', id });
  }
  return row;
}

const now = (): number => overrides.now?.() ?? Date.now();

const TOKEN_PATTERNS: Record<Exclude<PushProvider, 'webpush'>, RegExp> = {
  fcm: /^\S{16,4096}$/,
  apns: /^[0-9a-fA-F]{32,200}$/,
};

/** The notice a test push carries, in the words of the person who asked for it. */
function testMessage(locale: string): PushMessage {
  const ar = locale !== 'en';
  return {
    noticeId: null,
    kind: 'system',
    title: ar ? 'إشعار تجريبي' : 'Test notification',
    body: ar ? 'إن وصلك هذا فالإشعارات تعمل على هذا الجهاز.' : 'If this arrived, push works here.',
    profile: null,
    resource: null,
    urgent: false,
  };
}

export function createDevicesModule(lent: DevicesPorts): HubModule {
  ports = lent;
  return defineModule({
    name: 'devices',
    registerRoutes(app: FastifyInstance) {
      const document = loadOpenApiDocument();
      if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
      const deps = { contract: createContractIndex(document), guards: lent.guards };
      databases.set(app.hub.io, requireSqlite(app.hub.database));
      // Clean-ups that end a sign-in (auth) do not call the relay; a quiet re-statement of the
      // hub's tokens every few minutes lets go of theirs there (ADR 0024 §6).
      const relaySync = setInterval(() => {
        try {
          void pushFor(app).syncRelayIfNeeded();
        } catch {
          // The next tick tries again.
        }
      }, RELAY_SYNC_TICK_MS);
      relaySync.unref();
      app.addHook('onClose', async () => {
        clearInterval(relaySync);
        services.get(app.hub.io)?.close();
        closeRequests(app);
      });
      const dbOf = (request: FastifyRequest) => requireSqlite(request.server.hub.database);
      const view = (request: FastifyRequest, row: DeviceRow) =>
        serializeDevice(row, {
          online: onlineDevices(request.server.hub.io).has(row.id),
          thisDevice: principalOf(request).deviceId === row.id,
        });
      const emit = (request: FastifyRequest, row: DeviceRow, event: string, payload?: object) =>
        lent.emitToUser(
          request.server.hub.io,
          row.ownerId,
          REALTIME_NAMESPACES.devices,
          event,
          (payload ?? { device: view(request, row) }) as Record<string, unknown>,
          now(),
        );

      // A device that calls the hub was seen: `last_seen_at` without a heartbeat. A paired
      // one by its pairing token; one that signed in by the sign-in that registered it.
      app.addHook('preHandler', async (request) => {
        const principal = request.principal;
        if (!principal) return;
        const db = requireSqlite(app.hub.database);
        if (principal.deviceId) touch(db, principal.deviceId, now());
        else touchBySession(db, principal.tokenId, now());
      });

      defineRoute(app, deps, {
        operationId: 'devices.list',
        handler: (request, { query }) => {
          const principal = principalOf(request);
          const limit = clampLimit(query.limit as number | undefined);
          const after = decodeCursor(query.cursor as string | undefined);
          const rows = dbOf(request)
            .select()
            .from(devices)
            .where(
              and(
                eq(devices.status, 'paired'),
                isAdmin(principal) ? undefined : eq(devices.ownerId, principal.user.id),
                after ? gt(devices.id, after) : undefined,
              ),
            )
            .orderBy(asc(devices.id))
            .limit(limit + 1)
            .all();
          return pageOf(rows, limit, (row) => view(request, row));
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.get',
        handler: (request, { params }) =>
          view(
            request,
            visibleDevice(dbOf(request), principalOf(request), params.device_id as string),
          ),
      });

      defineRoute(app, deps, {
        operationId: 'devices.register',
        handler: (request, { body }, reply) => {
          const principal = principalOf(request);
          if (principal.deviceId) {
            throw conflict({ reason: 'already_a_device', device_id: principal.deviceId });
          }
          const input = body as {
            device_key: string;
            name: string;
            platform: DevicePlatform;
            kind: DeviceKind;
            brand?: string | null;
            model?: string | null;
            app_version?: string | null;
            os_version?: string | null;
            push_blocker?: PushBlocker | null;
            capabilities?: CapabilityKind[];
          };
          const db = dbOf(request);
          const at = now();
          const existing = db
            .select()
            .from(devices)
            .where(
              and(eq(devices.ownerId, principal.user.id), eq(devices.deviceKey, input.device_key)),
            )
            .get();
          if (existing && existing.status === 'paired' && existing.appTokenId) {
            // That key belongs to a paired app; a browser may not take its row over.
            throw conflict({ reason: 'device_key_in_use', device_id: existing.id });
          }
          const capabilities = (input.capabilities ?? []).map((kind) => ({
            kind,
            enabled: true,
            consentAt: existing?.capabilities.find((c) => c.kind === kind)?.consentAt ?? null,
          }));
          const values = {
            name: nameAfterReport(
              existing?.status === 'paired' ? existing : undefined,
              input.name.trim() || input.device_key.slice(0, 80),
            ),
            platform: input.platform,
            kind: input.kind,
            brand: input.brand ?? null,
            model: input.model ?? null,
            appVersion: input.app_version ?? null,
            ...(input.os_version !== undefined ? { osVersion: input.os_version } : {}),
            ...(input.push_blocker !== undefined ? { pushBlocker: input.push_blocker } : {}),
            capabilities,
            lastSeenAt: new Date(at),
            // This sign-in's calls are this device's activity from now on.
            seenSessionId: principal.tokenId,
          };
          if (existing && existing.status === 'paired') {
            const row = db
              .update(devices)
              .set(values)
              .where(eq(devices.id, existing.id))
              .returning()
              .get()!;
            emit(request, row, 'device.updated');
            return reply.status(200).send(view(request, row));
          }
          const row = existing
            ? db
                .update(devices)
                .set({
                  ...values,
                  status: 'paired',
                  revokedAt: null,
                  renamedAt: null,
                  pairedAt: new Date(at),
                  appTokenId: null,
                  connection: 'lan',
                })
                .where(eq(devices.id, existing.id))
                .returning()
                .get()!
            : db
                .insert(devices)
                .values({
                  ownerId: principal.user.id,
                  deviceKey: input.device_key,
                  connection: 'lan',
                  status: 'paired',
                  pairedAt: new Date(at),
                  ...values,
                })
                .returning()
                .get();
          emit(request, row, 'device.linked');
          return reply.status(201).send(view(request, row));
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.update',
        handler: (request, { params, body }) => {
          const db = dbOf(request);
          const principal = principalOf(request);
          const row = visibleDevice(db, principal, params.device_id as string);
          const patch = body as {
            profiles?: string[] | null;
            helper?: DeviceHelperReport | null;
            name?: string;
            brand?: string | null;
            model?: string | null;
            os_version?: string | null;
            app_version?: string | null;
            push_blocker?: PushBlocker | null;
            capabilities?: Array<{
              kind: CapabilityKind;
              enabled: boolean;
              consent_at: string | null;
            }>;
          };
          if (patch.name !== undefined && !patch.name.trim()) {
            throw new HubError('validation_failed', {
              details: { field: 'name', reason: 'empty' },
            });
          }
          // Which profiles may ask the device is its person's choice, made from a sign-in of
          // theirs: not the device's own token, not an agent's run, not an admin (§89).
          if (
            patch.profiles !== undefined &&
            (row.ownerId !== principal.user.id ||
              principal.deviceId === row.id ||
              isRunPrincipal(principal))
          ) {
            throw new HubError('forbidden', { details: { reason: 'not_the_devices_person' } });
          }
          // What the helper offers is the computer's own report, from its own token only.
          if (patch.helper !== undefined && principal.deviceId !== row.id) {
            throw new HubError('forbidden', { details: { reason: 'not_this_device' } });
          }
          const next = db
            .update(devices)
            .set({
              // A name given here is a person's choice: the device reporting itself keeps it.
              ...(patch.name !== undefined
                ? { name: patch.name.trim(), renamedAt: new Date(now()) }
                : {}),
              ...(patch.brand !== undefined ? { brand: patch.brand } : {}),
              ...(patch.model !== undefined ? { model: patch.model } : {}),
              ...(patch.os_version !== undefined ? { osVersion: patch.os_version } : {}),
              ...(patch.app_version !== undefined ? { appVersion: patch.app_version } : {}),
              ...(patch.push_blocker !== undefined ? { pushBlocker: patch.push_blocker } : {}),
              ...(patch.profiles !== undefined
                ? { profiles: patch.profiles === null ? null : [...new Set(patch.profiles)] }
                : {}),
              ...(patch.helper !== undefined
                ? {
                    helper:
                      patch.helper === null
                        ? null
                        : { ...patch.helper, reported_at: new Date(now()).toISOString() },
                  }
                : {}),
              ...(patch.capabilities
                ? {
                    capabilities: patch.capabilities.map((c) => ({
                      kind: c.kind,
                      enabled: c.enabled,
                      consentAt: c.consent_at ? Date.parse(c.consent_at) : null,
                    })),
                  }
                : {}),
            })
            .where(eq(devices.id, row.id))
            .returning()
            .get()!;
          emit(request, next, 'device.updated');
          return view(request, next);
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.unlink',
        status: 204,
        handler: (request, { params }) => {
          const db = dbOf(request);
          const row = visibleDevice(db, principalOf(request), params.device_id as string);
          const at = now();
          db.update(devices)
            .set({ status: 'revoked', revokedAt: new Date(at), ...REVOKED_PUSH })
            .where(eq(devices.id, row.id))
            .run();
          // Unlinking a paired device takes its token too: a device that is gone cannot call.
          if (row.appTokenId) lent.revokeAppToken(request.server, row.appTokenId, at);
          if (row.pushProvider === 'fcm' || row.pushProvider === 'apns') {
            void pushFor(request.server).syncRelay();
          }
          emit(request, row, 'device.unlinked', { device_id: row.id });
          return null;
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.registerPush',
        handler: async (request, { params, body }) => {
          const principal = principalOf(request);
          const db = dbOf(request);
          const row = visibleDevice(db, principal, params.device_id as string);
          // A paired device registers its own token; nobody else may point its pushes
          // elsewhere. A device with no token of its own (a browser) is its owner's.
          const allowed = row.appTokenId
            ? principal.deviceId === row.id
            : row.ownerId === principal.user.id;
          if (!allowed) throw new HubError('forbidden', { details: { reason: 'not_this_device' } });
          const input = body as {
            provider: PushProvider;
            token: string;
            locale?: 'ar' | 'en';
            relay_proof?: RelayProof;
          };
          const push = pushFor(request.server);
          if (!push.ready().includes(input.provider)) {
            throw conflict({ reason: 'sender_not_configured', provider: input.provider });
          }
          const token = input.token.trim();
          if (input.provider === 'webpush') {
            const subscription = parseSubscription(token);
            if (!subscription) {
              throw new HubError('bad_request', {
                details: { field: 'token', reason: 'not_a_push_subscription' },
              });
            }
            const allowPrivate = overrides.allowPrivateEndpoints ?? false;
            const verdict =
              allowPrivate || subscription.endpoint.startsWith('https://')
                ? await lent.checkAddress(subscription.endpoint, allowPrivate)
                : ({ ok: false, reason: 'scheme', detail: 'http' } as const);
            if (!verdict.ok) {
              throw new HubError('bad_request', {
                details: { field: 'token', reason: 'endpoint_refused', detail: verdict.reason },
              });
            }
          } else if (!TOKEN_PATTERNS[input.provider].test(token)) {
            throw new HubError('bad_request', {
              details: { field: 'token', reason: `not_an_${input.provider}_token` },
            });
          }
          const at = now();
          const next = db
            .update(devices)
            .set({
              pushProvider: input.provider,
              pushToken: push.sealToken(token),
              // A phone's token lives as long as the sign-in that registered it. A browser's
              // subscription is the browser's own: it stays until turned off or unlinked.
              pushSessionId: input.provider === 'webpush' ? null : principal.tokenId,
              pushLocale: input.locale ?? principal.user.locale ?? 'ar',
              pushRegisteredAt: new Date(at),
              lastSeenAt: new Date(at),
            })
            .where(eq(devices.id, row.id))
            .returning()
            .get()!;
          // Through the relay the token is bound to this hub there (ADR 0024); a relay that
          // cannot be reached now binds it at the first send.
          await push.relayBind(input.provider, token, input.relay_proof);
          if (row.pushToken && (row.pushProvider === 'fcm' || row.pushProvider === 'apns')) {
            // The token it replaces is let go of.
            void push.syncRelay();
          }
          emit(request, next, 'device.updated');
          return view(request, next).push;
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.unregisterPush',
        status: 204,
        handler: (request, { params }) => {
          const db = dbOf(request);
          const row = visibleDevice(db, principalOf(request), params.device_id as string);
          const next = db
            .update(devices)
            .set(REVOKED_PUSH)
            .where(eq(devices.id, row.id))
            .returning()
            .get()!;
          if (row.pushProvider === 'fcm' || row.pushProvider === 'apns') {
            void pushFor(request.server).syncRelay();
          }
          emit(request, next, 'device.updated');
          return null;
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.testPush',
        handler: async (request, { params }) => {
          const principal = principalOf(request);
          const row = visibleDevice(dbOf(request), principal, params.device_id as string);
          if (row.pushProvider === 'none' || !row.pushToken) {
            throw conflict({ reason: 'no_push_registration', device_id: row.id });
          }
          const provider = row.pushProvider;
          const result = await pushFor(request.server).sendToDevice(
            row,
            testMessage(row.pushLocale ?? principal.user.locale),
          );
          return {
            provider,
            status: result?.ok ? 'sent' : 'failed',
            error: result?.ok ? null : (result?.error ?? 'not sent'),
          };
        },
      });

      // ---------------------------------------------------------------- capability requests

      const requests = (request: FastifyRequest) =>
        requestsFor(
          request.server,
          () =>
            new DeviceRequestService({
              db: requireSqlite(request.server.hub.database),
              io: request.server.hub.io,
              jobs: lent.jobs(request.server),
              now,
              languageOf: (userId) => lent.userLanguage(request.server, userId),
            }),
        );

      /** The request, if the caller may see it: the person who asked, or the device asked. */
      const visibleRequest = (request: FastifyRequest, id: string) => {
        const principal = principalOf(request);
        const row = requests(request).find(workspaceOf(request), id);
        if (!row) throw notFound({ resource: 'device_request', id });
        const asked = principal.deviceId === row.deviceId;
        if (row.ownerId !== principal.user.id && !asked) {
          throw notFound({ resource: 'device_request', id });
        }
        return row;
      };

      defineRoute(app, deps, {
        operationId: 'devices.listRequests',
        handler: (request, { query }) => {
          const principal = principalOf(request);
          // A device sees what was asked of it; a person sees what was asked of their devices.
          const wanted = (query.device_id as string | undefined) ?? null;
          const deviceId = principal.deviceId ?? wanted;
          if (principal.deviceId && wanted && wanted !== principal.deviceId) {
            return { items: [], next_cursor: null };
          }
          return requests(request).list({
            workspace: workspaceOf(request),
            userId: principal.user.id,
            deviceId,
            status: (query.status as DeviceRequestStatus | undefined) ?? null,
            cursor: query.cursor as string | undefined,
            limit: query.limit as number | undefined,
          });
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.createRequest',
        status: 202,
        handler: (request, { body }) => {
          const principal = principalOf(request);
          const input = body as {
            device_id: string;
            capability: CapabilityKind;
            purpose?: string | null;
            params?: Record<string, unknown>;
            session_id?: string | null;
            timeout_ms?: number;
          };
          // An agent's run may ask the person's own computer for its helper's files and
          // programs, and nothing else (§89); anyone else needs the `device` scope.
          const run = isRunPrincipal(principal);
          const allowed = run
            ? AGENT_CAPABILITIES.has(input.capability)
            : principal.scopes.includes('device') || principal.scopes.includes('admin');
          if (!allowed) {
            throw new HubError('forbidden', {
              messageKey: 'auth.scope_insufficient',
              details: { required_scope: 'device' },
            });
          }
          const device = findDevice(dbOf(request), input.device_id);
          // Only the device's own person may ask it; anyone else's device is not there.
          if (!device || device.status !== 'paired' || device.ownerId !== principal.user.id) {
            throw notFound({ resource: 'device', id: input.device_id });
          }
          const workspace = workspaceOf(request);
          if (device.profiles && !device.profiles.includes(workspace.slug)) {
            throw new HubError('forbidden', {
              details: { reason: 'device_not_in_profile', profile: workspace.slug },
            });
          }
          const { jobId, request: row } = requests(request).create({
            workspace,
            ownerId: principal.user.id,
            device,
            capability: input.capability,
            purpose: input.purpose?.trim() || null,
            params: input.params ?? {},
            sessionId: input.session_id ?? null,
            // A run token's id is its run's (auth `run-tokens.ts`).
            runId: run ? principal.tokenId : null,
            timeoutMs: input.timeout_ms ?? defaultTimeoutFor(input.capability),
            online: onlineDevices(request.server.hub.io).has(device.id),
          });
          return { job_id: jobId, request_id: row.id };
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.getRequest',
        handler: (request, { params }) =>
          serializeRequest(
            visibleRequest(request, params.request_id as string),
            workspaceOf(request).slug,
          ),
      });

      defineRoute(app, deps, {
        operationId: 'devices.respondRequest',
        handler: (request, { params, body }) => {
          const principal = principalOf(request);
          const row = visibleRequest(request, params.request_id as string);
          if (principal.deviceId !== row.deviceId) {
            throw new HubError('forbidden', { details: { reason: 'not_the_addressed_device' } });
          }
          const workspace = workspaceOf(request);
          const next = requests(request).respond(
            workspace,
            row,
            body as {
              status: 'fulfilled' | 'denied' | 'failed';
              result?: unknown;
              error?: unknown;
            },
          );
          return serializeRequest(next, workspace.slug);
        },
      });

      // ---------------------------------------------------------------- senders

      defineRoute(app, deps, {
        operationId: 'devices.getPushConfig',
        handler: (request) => pushFor(request.server).config(),
      });

      defineRoute(app, deps, {
        operationId: 'devices.listPushSenders',
        handler: (request) => ({ items: pushFor(request.server).views() }),
      });

      const configError = (error: unknown): never => {
        if (error instanceof PushConfigError) {
          if (error.reason === 'set_by_environment') {
            throw conflict({ reason: error.reason, message: error.message });
          }
          if (error.reason === 'not_stored') throw notFound({ resource: 'push_sender' });
          throw new HubError('bad_request', {
            details: { reason: 'invalid_credentials', message: error.message },
          });
        }
        throw error;
      };

      defineRoute(app, deps, {
        operationId: 'devices.setPushSender',
        handler: (request, { params, body }) => {
          try {
            return pushFor(request.server).update(
              params.provider as PushProvider,
              body as SenderUpdate,
              principalOf(request).user.id,
            );
          } catch (error) {
            return configError(error);
          }
        },
      });

      defineRoute(app, deps, {
        operationId: 'devices.setPushRelay',
        handler: (request, { body }) =>
          pushFor(request.server).updateRelay(
            body as { enabled?: boolean; private_push?: boolean },
          ),
      });

      // ---------------------------------------------------------------- linked hubs (ADR 0026)

      registerPeerRoutes(
        app,
        deps,
        {
          db: (hub) => requireSqlite(hub.hub.database),
          sealer: (hub) => lent.sealer(hub),
          agents: {
            list: (hub, language) => lent.peerAgents.list(hub, language),
            ask: (hub, input) =>
              overrides.peerAsk ? overrides.peerAsk(input) : lent.peerAgents.ask(hub, input),
          },
          now,
          fetch: () => overrides.peerFetch ?? fetch,
          base: serverBasePath(document),
        },
        (request) => {
          const principal = principalOf(request);
          return { id: principal.user.id, username: principal.user.username };
        },
      );

      // ---------------------------------------------------------------- way in from outside

      defineRoute(app, deps, {
        operationId: 'devices.getRelay',
        handler: (request) => readRelay(request.server.hub.relayHost, overrides.relayHostTimeoutMs),
      });

      defineRoute(app, deps, {
        operationId: 'devices.setRelay',
        handler: (request, { body }) =>
          changeRelay(
            request.server.hub.relayHost,
            body as RelayChange,
            overrides.relayHostTimeoutMs,
          ),
      });

      defineRoute(app, deps, {
        operationId: 'devices.deletePushSender',
        status: 204,
        handler: (request, { params }) => {
          const provider = params.provider as PushProvider;
          if (provider === 'webpush') {
            // Its keys are the hub's own; forgetting them would orphan every browser.
            throw new HubError('bad_request', {
              details: { reason: 'webpush_keys_are_the_hubs' },
            });
          }
          try {
            pushFor(request.server).remove(provider);
          } catch (error) {
            configError(error);
          }
          return null;
        },
      });
    },
    registerEvents(io) {
      const namespace = io.of(REALTIME_NAMESPACES.devices);
      // A paired device's socket is its presence: `device.online` when the first one
      // connects, `device.offline` when the last one goes (events/README.md).
      namespace.on('connection', (socket) => {
        const deviceId = deviceOfSocket(socket.data);
        if (!deviceId) return;
        // What is asked of this device reaches this device only (`request.created`).
        void socket.join(deviceRoom(deviceId));
        const announce = (event: 'device.online' | 'device.offline', online: boolean) => {
          const db = databases.get(io);
          if (!db || !ports) return;
          if (online) touch(db, deviceId, now(), true);
          const row = findDevice(db, deviceId);
          if (!row || row.status !== 'paired') return;
          ports.emitToUser(
            io,
            row.ownerId,
            REALTIME_NAMESPACES.devices,
            event,
            { device: serializeDevice(row, { online, thisDevice: false }) },
            now(),
          );
        };
        const others = () =>
          [...namespace.sockets.values()].filter(
            (other) => other.id !== socket.id && deviceOfSocket(other.data) === deviceId,
          ).length;
        if (others() === 0) announce('device.online', true);
        socket.on('disconnect', () => {
          if (others() === 0) announce('device.offline', false);
        });
      });
    },
  });
}
