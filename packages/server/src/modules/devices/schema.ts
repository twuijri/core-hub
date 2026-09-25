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
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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

/** One entry of the contract's `Device.capabilities`. */
export type DeviceCapability = {
  kind: CapabilityKind;
  enabled: boolean;
  /** Epoch ms when the person granted the OS permission, if the device reports it. */
  consentAt: number | null;
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
    capabilities: json<DeviceCapability[]>('capabilities').notNull().default(EMPTY_ARRAY),
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
