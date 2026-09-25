/**
 * devices — phones and computers linked to the hub, the capabilities they
 * expose, and the commands the hub sends them (`device://` relay).
 *
 * Global: devices (a device belongs to a user, not to a workspace), push_credentials
 * (one row per push sender for the whole hub; moved here from notify, same table).
 * Scoped: device_commands (a command is requested from inside a workspace).
 *
 * Column names follow the contract's `Device` / `DeviceRegistration` schemas
 * (packages/contracts/openapi.yaml): a device carries the stable `device_key`
 * it generated, its `kind`, `brand`, `model`, how it reaches the hub
 * (`connection`) and its capabilities as `{ kind, enabled, consent_at }`.
 *
 * Cross-module id columns: devices.app_token_id -> auth.app_tokens,
 * devices.push_session_id -> auth.app_tokens,
 * device_commands.run_id -> sessions.runs, device_commands.requested_by_id
 * -> auth.users / agents.agents / schedules.workflow_runs,
 * device_commands.result_attachment_id -> knowledge.attachments.
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
export const DEVICE_COMMAND_KINDS = [
  'capture_photo',
  'record_audio',
  'read_clipboard',
  'write_clipboard',
  'open_url',
  'locate',
  'speak',
  'show_notification',
  'custom',
] as const;
export const DEVICE_COMMAND_STATUSES = [
  'queued',
  'sent',
  'acked',
  'completed',
  'failed',
  'expired',
  'cancelled',
] as const;
export const DEVICE_REQUESTERS = ['user', 'agent', 'workflow'] as const;

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

export const deviceCommands = sqliteTable(
  'device_commands',
  {
    ...scopedColumns(),
    deviceId: ulid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: DEVICE_COMMAND_KINDS }).notNull(),
    payload: json<Record<string, unknown>>('payload').notNull().default(EMPTY_OBJECT),
    status: text('status', { enum: DEVICE_COMMAND_STATUSES }).notNull().default('queued'),
    requestedByKind: text('requested_by_kind', { enum: DEVICE_REQUESTERS }).notNull(),
    requestedById: ulid('requested_by_id'),
    /** The agent run waiting on this command, if any. */
    runId: ulid('run_id'),
    result: json<Record<string, unknown>>('result'),
    /** Photo / recording produced by the device (knowledge module). */
    resultAttachmentId: ulid('result_attachment_id'),
    error: text('error'),
    sentAt: timestampMs('sent_at'),
    completedAt: timestampMs('completed_at'),
    expiresAt: timestampMs('expires_at').notNull(),
  },
  (t) => [
    index('device_commands_device_pending_idx').on(t.deviceId, t.status, t.createdAt),
    index('device_commands_run_idx').on(t.runId),
    check('device_commands_kind_check', inList(t.kind, DEVICE_COMMAND_KINDS)),
    check('device_commands_status_check', inList(t.status, DEVICE_COMMAND_STATUSES)),
    check('device_commands_requester_check', inList(t.requestedByKind, DEVICE_REQUESTERS)),
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
