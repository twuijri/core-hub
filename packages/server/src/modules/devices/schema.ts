/**
 * devices — phones and computers linked to the hub, the capabilities they
 * expose, and the commands the hub sends them (`device://` relay).
 *
 * Global: devices (a device belongs to a user, not to a workspace).
 * Scoped: device_commands (a command is requested from inside a workspace).
 *
 * Cross-module id columns: devices.app_token_id -> auth.app_tokens,
 * device_commands.run_id -> sessions.runs, device_commands.requested_by_id
 * -> auth.users / agents.agents / schedules.workflow_runs,
 * device_commands.result_attachment_id -> knowledge.attachments.
 */
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  EMPTY_OBJECT,
  globalColumns,
  inList,
  json,
  scopedColumns,
  timestampMs,
  ulid,
} from '../../db/columns.js';

export const DEVICE_PLATFORMS = ['android', 'ios', 'web', 'desktop', 'cli'] as const;
export const PUSH_PROVIDERS = ['none', 'fcm', 'apns', 'webpush'] as const;
export const DEVICE_STATUSES = ['paired', 'revoked'] as const;
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

export type DeviceCapabilities = {
  camera?: boolean;
  microphone?: boolean;
  location?: boolean;
  clipboard?: boolean;
  notifications?: boolean;
  tts?: boolean;
  /** Desktop only: local apps the device agent can expose. */
  localApps?: string[];
};

export const devices = sqliteTable(
  'devices',
  {
    ...globalColumns(),
    name: text('name', { length: 120 }).notNull(),
    platform: text('platform', { enum: DEVICE_PLATFORMS }).notNull(),
    osVersion: text('os_version', { length: 64 }),
    appVersion: text('app_version', { length: 32 }),
    pushProvider: text('push_provider', { enum: PUSH_PROVIDERS }).notNull().default('none'),
    /** ENCRYPTED. Push registration token; never returned to a client. */
    pushToken: text('push_token'),
    capabilities: json<DeviceCapabilities>('capabilities').notNull().default(EMPTY_OBJECT),
    status: text('status', { enum: DEVICE_STATUSES }).notNull().default('paired'),
    /** The device token issued at pairing (auth module). */
    appTokenId: ulid('app_token_id'),
    pairedAt: timestampMs('paired_at').notNull(),
    lastSeenAt: timestampMs('last_seen_at'),
    revokedAt: timestampMs('revoked_at'),
  },
  (t) => [
    index('devices_owner_idx').on(t.ownerId, t.status),
    uniqueIndex('devices_app_token_uq').on(t.appTokenId),
    check('devices_platform_check', inList(t.platform, DEVICE_PLATFORMS)),
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
