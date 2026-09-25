// Module `devices`: phones, computers and browsers linked to the hub, and push to them.
// Public surface of the module: other modules and app/ import this file only.
//
// What answers (DECISIONS §66): the registry (list, read, rename, unlink, register a
// browser), push registration, the push senders (Web Push with the hub's own VAPID keys,
// FCM, APNs) and a test push. Capability requests, the relay and peers stay 501.
//
// `auth` imports this module (pairing creates the device row), so this module does not
// import `auth`: what it needs from it — the route guards, revoking a token, reaching a
// person's sockets — is lent by the composition root (`createDevicesModule`).
import { and, asc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
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
import type { PushMessage, PushProvider } from './senders.js';
import {
  devices,
  type CapabilityKind,
  type DeviceConnection,
  type DeviceKind,
  type DevicePlatform,
} from './schema.js';

export type DeviceRow = typeof devices.$inferSelect;
export type { CapabilityKind, DeviceConnection, DeviceKind, DevicePlatform } from './schema.js';
export { CAPABILITY_KINDS, DEVICE_CONNECTIONS, DEVICE_KINDS, DEVICE_PLATFORMS } from './schema.js';
export type { DeliveryResult, Sealer } from './push.js';
export type { PushMessage, PushProvider } from './senders.js';

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
  /**
   * Is this `app_tokens` row (a sign-in session or a pairing token) still good — not revoked,
   * not expired, its person active (auth)? A push registration lives only as long as it.
   */
  sessionLive(db: ModuleDb, tokenId: string, now: number): boolean;
}

/** Test seams: fakes for the push services, and permission to call 127.0.0.1. */
export interface DevicesOverrides {
  fetchImpl?: typeof fetch;
  fcmBaseUrl?: string;
  apnsOrigin?: string;
  /** Lets a Web Push endpoint be `http:` and private (tests and the e2e fake push service). */
  allowPrivateEndpoints?: boolean;
  now?: () => number;
}
let overrides: DevicesOverrides = {};
export function overrideDevices(next: DevicesOverrides): void {
  overrides = next;
}

let ports: DevicesPorts | null = null;
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
  capabilities: readonly CapabilityKind[];
  connection: DeviceConnection;
  appTokenId: string;
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
  const values = {
    name: input.name,
    platform: input.platform,
    kind: input.kind,
    brand: input.brand,
    model: input.model,
    appVersion: input.appVersion,
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
    app_version: row.appVersion,
    connection: row.connection,
    online: options.online,
    last_seen_at: iso(row.lastSeenAt),
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
    this_device: options.thisDevice,
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

const SEEN_WRITE_INTERVAL_MS = 60_000;
const lastSeenWrites = new Map<string, number>();

/** Records that a device was seen, at most once a minute (a write per request is waste). */
function touch(db: ModuleDb, deviceId: string, at: number, force = false): void {
  const last = lastSeenWrites.get(deviceId) ?? 0;
  if (!force && at - last < SEEN_WRITE_INTERVAL_MS) return;
  lastSeenWrites.set(deviceId, at);
  db.update(devices)
    .set({ lastSeenAt: new Date(at) })
    .where(and(eq(devices.id, deviceId), eq(devices.status, 'paired')))
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
      app.addHook('onClose', async () => services.get(app.hub.io)?.close());
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

      // A paired device that calls the hub was seen: `last_seen_at` without a heartbeat.
      app.addHook('preHandler', async (request) => {
        const deviceId = request.principal?.deviceId;
        if (deviceId) touch(requireSqlite(app.hub.database), deviceId, now());
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
            name: input.name.trim() || input.device_key.slice(0, 80),
            platform: input.platform,
            kind: input.kind,
            brand: input.brand ?? null,
            model: input.model ?? null,
            appVersion: input.app_version ?? null,
            capabilities,
            lastSeenAt: new Date(at),
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
          const row = visibleDevice(db, principalOf(request), params.device_id as string);
          const patch = body as {
            name?: string;
            app_version?: string | null;
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
          const next = db
            .update(devices)
            .set({
              ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
              ...(patch.app_version !== undefined ? { appVersion: patch.app_version } : {}),
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
          const input = body as { provider: PushProvider; token: string; locale?: 'ar' | 'en' };
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
