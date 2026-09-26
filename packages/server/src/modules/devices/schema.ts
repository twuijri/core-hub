/**
 * devices — phones and computers linked to the hub, the capabilities they
 * expose, and the commands the hub sends them (`device://` relay).
 *
 * Global: devices (a device belongs to a user, not to a workspace), push_credentials
 * (one row per push sender for the whole hub; moved here from notify, same table).
 * Scoped: device_requests (a capability is asked of a device from inside a workspace; the
 * contract's `DeviceRequest`, DECISIONS §14 and §74). It replaced `device_commands`, a
 * design that was never written to.
 *
 * Column names follow the contract's `Device` / `DeviceRegistration` schemas
 * (packages/contracts/openapi.yaml): a device carries the stable `device_key`
 * it generated, its `kind`, `brand`, `model`, how it reaches the hub
 * (`connection`) and its capabilities as `{ kind, enabled, consent_at }`.
 *
 * Cross-module id columns: devices.app_token_id -> auth.app_tokens,
 * devices.push_session_id -> auth.app_tokens,
 * device_requests.session_id -> sessions.sessions, device_requests.run_id -> sessions.runs,
 * device_requests.job_id -> audit.jobs.
 */
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  EMPTY_ARRAY,
  EMPTY_OBJECT,
  bool,
  globalColumns,
  inList,
  json,
  scopedColumns,
  timestampMs,
  ulid,
} from '../../db/columns.js';

export const DEVICE_PLATFORMS = ['android', 'ios', 'web', 'macos', 'windows', 'linux'] as const;
export const DEVICE_KINDS = ['phone', 'tablet', 'computer', 'browser'] as const;
export const DEVICE_CONNECTIONS = ['lan', 'relay'] as const;
export const PUSH_PROVIDERS = ['none', 'fcm', 'apns', 'webpush'] as const;
export const DEVICE_STATUSES = ['paired', 'revoked'] as const;
export const PUSH_CREDENTIAL_PROVIDERS = ['fcm', 'apns', 'webpush'] as const;
/** The contract's `PushBlocker`: what the device says stops push on it. */
export const PUSH_BLOCKERS = [
  'none',
  'not_in_build',
  'permission_pending',
  'permission_denied',
] as const;
export const CAPABILITY_KINDS = [
  'location',
  'camera',
  'microphone',
  'notifications',
  'clipboard',
  'screen',
  'files',
  'apps',
  'calendar',
  'reminders',
  'health',
] as const;
/** The contract's `DeviceRequestStatus`; `pending` is the only one that is not final. */
export const DEVICE_REQUEST_STATUSES = [
  'pending',
  'fulfilled',
  'denied',
  'failed',
  'expired',
  'cancelled',
] as const;
/** The contract's `DeviceRequestError.code`: one list for every platform (DECISIONS §14). */
export const DEVICE_REQUEST_ERROR_CODES = [
  'permission_denied',
  'unavailable',
  'timeout',
  'cancelled',
  'failed',
] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type DeviceConnection = (typeof DEVICE_CONNECTIONS)[number];
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
export type PushBlocker = (typeof PUSH_BLOCKERS)[number];

/** One entry of the contract's `Device.capabilities`. */
export type DeviceCapability = {
  kind: CapabilityKind;
  enabled: boolean;
  /** Epoch ms when the person granted the OS permission, if the device reports it. */
  consentAt: number | null;
};

/** The contract's `DeviceHelper`, stored as the device sent it (snake_case, as on the wire). */
export type DeviceHelperReport = {
  folders: Array<{ path: string; write: boolean; default?: boolean }>;
  allow_open: boolean;
  programs: Array<{
    id: string;
    name: string;
    source: string;
    profiles: string[];
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  }>;
  reported_at: string;
};

export const devices = sqliteTable(
  'devices',
  {
    ...globalColumns(),
    /** Stable id the device generated once; re-pairing updates the same row (unique per owner). */
    deviceKey: text('device_key', { length: 128 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    platform: text('platform', { enum: DEVICE_PLATFORMS }).notNull(),
    kind: text('kind', { enum: DEVICE_KINDS }).notNull().default('phone'),
    brand: text('brand', { length: 80 }),
    model: text('model', { length: 120 }),
    osVersion: text('os_version', { length: 64 }),
    appVersion: text('app_version', { length: 32 }),
    /** How the device reaches the hub: directly or through the message relay. */
    connection: text('connection', { enum: DEVICE_CONNECTIONS }).notNull().default('lan'),
    pushProvider: text('push_provider', { enum: PUSH_PROVIDERS }).notNull().default('none'),
    /** ENCRYPTED. Push registration token; never returned to a client. */
    pushToken: text('push_token'),
    pushLocale: text('push_locale', { length: 8 }),
    pushRegisteredAt: timestampMs('push_registered_at'),
    /**
     * The `auth.app_tokens` row (a sign-in session or the pairing token) that registered the
     * push token. The registration lives only as long as it: when that session ends, however
     * it ends, nothing more is pushed to this device
     * (docs/changes/2026-09-26-twuijri-push-cleanup-mobile-logs.md).
     */
    pushSessionId: ulid('push_session_id'),
    /** What the device last said stops push on it (the contract's `PushBlocker`); null: never said. */
    pushBlocker: text('push_blocker', { enum: PUSH_BLOCKERS }),
    /**
     * The sign-in (`auth.app_tokens` row) that last registered this device with
     * `devices.register`: calls made with it count as the device being seen, as a paired
     * device's calls with its pairing token do.
     */
    seenSessionId: ulid('seen_session_id'),
    /** When a person named the device: registering or pairing it again keeps that name. */
    renamedAt: timestampMs('renamed_at'),
    capabilities: json<DeviceCapability[]>('capabilities').notNull().default(EMPTY_ARRAY),
    /**
     * The profiles (slugs) whose agents may ask this device (DECISIONS §89); null: every
     * profile of the device's person, the default.
     */
    profiles: json<string[]>('profiles'),
    /**
     * What a computer's local helper offers agents, as the desktop app last reported it (the
     * contract's `DeviceHelper`, ADR 0025): shared folders, opening, programs and their tools.
     */
    helper: json<DeviceHelperReport>('helper'),
    status: text('status', { enum: DEVICE_STATUSES }).notNull().default('paired'),
    /** The device token issued at pairing (auth module). */
    appTokenId: ulid('app_token_id'),
    pairedAt: timestampMs('paired_at').notNull(),
    lastSeenAt: timestampMs('last_seen_at'),
    revokedAt: timestampMs('revoked_at'),
  },
  (t) => [
    index('devices_owner_idx').on(t.ownerId, t.status),
    uniqueIndex('devices_owner_key_uq').on(t.ownerId, t.deviceKey),
    uniqueIndex('devices_app_token_uq').on(t.appTokenId),
    check('devices_platform_check', inList(t.platform, DEVICE_PLATFORMS)),
    check('devices_kind_check', inList(t.kind, DEVICE_KINDS)),
    check('devices_connection_check', inList(t.connection, DEVICE_CONNECTIONS)),
    check('devices_push_provider_check', inList(t.pushProvider, PUSH_PROVIDERS)),
    check('devices_status_check', inList(t.status, DEVICE_STATUSES)),
  ],
);

export type DeviceRequestStatus = (typeof DEVICE_REQUEST_STATUSES)[number];
export type DeviceRequestErrorCode = (typeof DEVICE_REQUEST_ERROR_CODES)[number];

export const deviceRequests = sqliteTable(
  'device_requests',
  {
    ...scopedColumns(),
    deviceId: ulid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    capability: text('capability', { enum: CAPABILITY_KINDS }).notNull(),
    /** Shown to the person in the device's consent sheet. */
    purpose: text('purpose'),
    params: json<Record<string, unknown>>('params').notNull().default(EMPTY_OBJECT),
    sessionId: ulid('session_id'),
    runId: ulid('run_id'),
    /** The `device_request` job the requester follows (audit). */
    jobId: ulid('job_id').notNull(),
    status: text('status', { enum: DEVICE_REQUEST_STATUSES }).notNull().default('pending'),
    expiresAt: timestampMs('expires_at').notNull(),
    /** What the device sent back; a location stays only here, never in the job. */
    result: json<Record<string, unknown>>('result'),
    error: json<{ code: DeviceRequestErrorCode; message: string | null }>('error'),
    answeredAt: timestampMs('answered_at'),
  },
  (t) => [
    index('device_requests_device_status_idx').on(t.deviceId, t.status, t.createdAt),
    index('device_requests_workspace_owner_idx').on(t.workspace, t.ownerId, t.createdAt),
    check('device_requests_capability_check', inList(t.capability, CAPABILITY_KINDS)),
    check('device_requests_status_check', inList(t.status, DEVICE_REQUEST_STATUSES)),
  ],
);

/**
 * A push sender's credentials set from Settings (the environment wins over a row here).
 * Web Push has no row for its keys: they are the hub's own, in `${DATA_DIR}/keys/vapid.json`;
 * its row, when there is one, holds only the contact (`public_meta.subject`) and `enabled`.
 */
export const pushCredentials = sqliteTable(
  'push_credentials',
  {
    ...globalColumns(),
    provider: text('provider', { enum: PUSH_CREDENTIAL_PROVIDERS }).notNull(),
    label: text('label', { length: 120 }).notNull(),
    /** ENCRYPTED. Service-account JSON / APNs .p8 / VAPID private key. */
    ciphertext: text('ciphertext').notNull(),
    /** ENCRYPTED (metadata). GCM nonce. */
    nonce: text('nonce', { length: 32 }).notNull(),
    keyId: text('key_id', { length: 32 }).notNull(),
    /** Non-secret identifiers: project id, team id, key id, bundle id, VAPID public key. */
    publicMeta: json<Record<string, string>>('public_meta').notNull().default(EMPTY_OBJECT),
    enabled: bool('enabled').notNull().default(true),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('push_credentials_provider_uq').on(t.provider),
    check('push_credentials_provider_check', inList(t.provider, PUSH_CREDENTIAL_PROVIDERS)),
  ],
);

/** The contract's `PushRelayStatus.state`, as last seen (ADR 0024). */
export const PUSH_RELAY_STATES = [
  'ready',
  'not_registered',
  'unreachable',
  'blocked',
  'rate_limited',
] as const;

/**
 * The Core Hub push relay as this hub knows it (ADR 0024): one row. Its registration (`hub_id`
 * and the secret the relay gave it, for the relay at `url`), the admin's switch and private
 * push, and what the last call said. A registration belongs to the relay at `url`: another
 * address registers again.
 */
export const pushRelay = sqliteTable(
  'push_relay',
  {
    id: ulid('id').primaryKey(),
    /** The relay this registration is with. */
    url: text('url', { length: 500 }),
    /** This hub's id at the relay (not a secret). */
    hubId: text('hub_id', { length: 64 }),
    /** ENCRYPTED. The secret the relay gave this hub; it signs every call. */
    ciphertext: text('ciphertext'),
    nonce: text('nonce', { length: 32 }),
    keyId: text('key_id', { length: 32 }),
    enabled: bool('enabled').notNull().default(true),
    privatePush: bool('private_push').notNull().default(false),
    state: text('state', { enum: PUSH_RELAY_STATES }),
    lastError: text('last_error'),
    checkedAt: timestampMs('checked_at'),
    /** When the hub last told the relay every token it still wants (`/v1/tokens/sync`). */
    syncedAt: timestampMs('synced_at'),
    createdAt: timestampMs('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestampMs('updated_at')
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  // NULL (never called yet) passes a CHECK in SQLite and PostgreSQL alike.
  (t) => [check('push_relay_state_check', inList(t.state, PUSH_RELAY_STATES))],
);

// ------------------------------------------------------------------ linked hubs (ADR 0026)

export const PEER_DIRECTIONS = ['inbound', 'outbound'] as const;
export const PEER_STATUSES = ['pending', 'waiting', 'linked'] as const;
export const PEER_EVENT_KINDS = [
  'joined',
  'requested',
  'approved',
  'approved_by_peer',
  'updated',
  'unlinked',
  'unlinked_by_peer',
  'list_in',
  'list_out',
  'ask_in',
  'ask_out',
  'refused',
] as const;
export type PeerEventKind = (typeof PEER_EVENT_KINDS)[number];

/**
 * This hub's own identity towards linked hubs: one row, made the first time it is needed. `id`
 * is the hub id peers know it by; the Ed25519 private key is sealed with the data key ring and
 * never leaves the hub.
 */
export const peerIdentity = sqliteTable('peer_identity', {
  id: ulid('id').primaryKey(),
  /** Ed25519 public key, SPKI DER in base64url. Not a secret. */
  publicKey: text('public_key').notNull(),
  /** ENCRYPTED. The private key, PKCS#8 DER in base64url. */
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce', { length: 32 }).notNull(),
  keyId: text('key_id', { length: 32 }).notNull(),
  createdAt: timestampMs('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Another Core Hub, linked or waiting to be. `owner_id` is the admin who invited or asked.
 * Deleting the row is revoking the link: the public key goes with it.
 */
export const peers = sqliteTable(
  'peers',
  {
    ...globalColumns(),
    /** The peer's own hub id (its `peer_identity.id`). */
    hubId: ulid('hub_id').notNull(),
    name: text('name', { length: 80 }).notNull(),
    hubName: text('hub_name', { length: 80 }).notNull(),
    /** The peer's HTTPS origin. */
    url: text('url', { length: 2048 }).notNull(),
    direction: text('direction', { enum: PEER_DIRECTIONS }).notNull(),
    status: text('status', { enum: PEER_STATUSES }).notNull(),
    enabled: bool('enabled').notNull().default(true),
    publicKey: text('public_key').notNull(),
    fingerprint: text('fingerprint', { length: 64 }).notNull(),
    version: text('version', { length: 40 }),
    asksPerHour: integer('asks_per_hour').notNull().default(30),
    lastSeenAt: timestampMs('last_seen_at'),
    approvedAt: timestampMs('approved_at'),
  },
  (t) => [
    uniqueIndex('peers_hub_id_uq').on(t.hubId),
    check('peers_direction_check', inList(t.direction, PEER_DIRECTIONS)),
    check('peers_status_check', inList(t.status, PEER_STATUSES)),
  ],
);

/** An invite this hub made: only the SHA-256 of its code is kept. Single use, 10 minutes. */
export const peerInvites = sqliteTable(
  'peer_invites',
  {
    ...globalColumns(),
    codeHash: text('code_hash', { length: 64 }).notNull(),
    expiresAt: timestampMs('expires_at').notNull(),
    usedAt: timestampMs('used_at'),
  },
  (t) => [uniqueIndex('peer_invites_code_hash_uq').on(t.codeHash)],
);

/** Nonces of signed calls already taken, until their timestamp falls out of the window. */
export const peerNonces = sqliteTable(
  'peer_nonces',
  {
    id: ulid('id').primaryKey(),
    /** The calling hub's id. */
    peerHubId: ulid('peer_hub_id').notNull(),
    nonce: text('nonce', { length: 64 }).notNull(),
    expiresAt: timestampMs('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('peer_nonces_uq').on(t.peerHubId, t.nonce),
    index('peer_nonces_expires_idx').on(t.expiresAt),
  ],
);

/**
 * An agent in a profile that linked hubs may ask (off unless a row says `shared`). `id` is what
 * peers see as the agent's id, so the agent's own id never leaves the hub.
 */
export const peerShares = sqliteTable(
  'peer_shares',
  {
    ...scopedColumns(),
    agentId: ulid('agent_id').notNull(),
    shared: bool('shared').notNull().default(false),
    description: text('description', { length: 280 }),
  },
  (t) => [uniqueIndex('peer_shares_workspace_agent_uq').on(t.workspace, t.agentId)],
);

/** The audit log of linked hubs, on this side. Kept after a peer is deleted. */
export const peerEvents = sqliteTable(
  'peer_events',
  {
    id: ulid('id').primaryKey(),
    peerId: ulid('peer_id').notNull(),
    kind: text('kind', { enum: PEER_EVENT_KINDS }).notNull(),
    ok: bool('ok').notNull(),
    /** A short fact: an agent's name, a refusal's reason. Never a question's words. */
    detail: text('detail', { length: 200 }),
    /** The person on this hub who acted; null when the peer did. */
    actorId: ulid('actor_id'),
    createdAt: timestampMs('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index('peer_events_peer_idx').on(t.peerId, t.createdAt),
    check('peer_events_kind_check', inList(t.kind, PEER_EVENT_KINDS)),
  ],
);
