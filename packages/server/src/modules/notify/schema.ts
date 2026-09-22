/**
 * notify — in-app notices, push deliveries, per-user preferences, outgoing
 * webhooks and their deliveries, and the server's push credentials.
 *
 * Scoped: notifications (owner_id = recipient), notification_deliveries,
 * notification_preferences, webhooks, webhook_deliveries.
 * Global: push_credentials (one row per push provider for the whole hub).
 *
 * Cross-module id columns: notification_deliveries.device_id -> devices.devices,
 * notifications.entity_id -> the entity named by `entity_kind`,
 * webhooks.signing_secret_id -> models.secrets.
 */
import { check, index, sqliteTable, text, uniqueIndex, integer } from 'drizzle-orm/sqlite-core';
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

export const NOTIFICATION_KINDS = [
  'approval_requested',
  'question_asked',
  'run_completed',
  'run_failed',
  'task_assigned',
  'task_moved',
  'mention',
  'handoff',
  'schedule_failed',
  'workflow_waiting',
  'device_command',
  'update_available',
  'system',
] as const;
export const SEVERITIES = ['info', 'warning', 'error', 'action_required'] as const;
export const DELIVERY_CHANNELS = ['in_app', 'push', 'webhook'] as const;
export const DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export const WEBHOOK_DELIVERY_STATUSES = ['queued', 'delivered', 'failed', 'dead'] as const;
export const PUSH_CREDENTIAL_PROVIDERS = ['fcm', 'apns', 'webpush'] as const;

/** Deep link the client opens: `{ route: 'session', id }` etc. */
export type NotificationData = {
  route?: string;
  id?: string;
  [key: string]: unknown;
};

export const notifications = sqliteTable(
  'notifications',
  {
    ...scopedColumns(),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull().default('info'),
    /** Already localised to the recipient's locale at creation. */
    title: text('title', { length: 200 }).notNull(),
    body: text('body'),
    entityKind: text('entity_kind', { length: 32 }),
    entityId: ulid('entity_id'),
    data: json<NotificationData>('data').notNull().default(EMPTY_OBJECT),
    readAt: timestampMs('read_at'),
    dismissedAt: timestampMs('dismissed_at'),
  },
  (t) => [
    index('notifications_inbox_idx').on(t.workspace, t.ownerId, t.readAt, t.createdAt),
    index('notifications_entity_idx').on(t.entityKind, t.entityId),
    check('notifications_kind_check', inList(t.kind, NOTIFICATION_KINDS)),
    check('notifications_severity_check', inList(t.severity, SEVERITIES)),
  ],
);

export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    ...scopedColumns(),
    notificationId: ulid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: DELIVERY_CHANNELS }).notNull(),
    deviceId: ulid('device_id'),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** Provider message id (FCM/APNs) for support questions. */
    providerRef: text('provider_ref', { length: 200 }),
    lastError: text('last_error'),
    sentAt: timestampMs('sent_at'),
  },
  (t) => [
    index('notification_deliveries_notification_idx').on(t.notificationId),
    index('notification_deliveries_queue_idx').on(t.status, t.createdAt),
    check('notification_deliveries_channel_check', inList(t.channel, DELIVERY_CHANNELS)),
    check('notification_deliveries_status_check', inList(t.status, DELIVERY_STATUSES)),
  ],
);

export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    ...scopedColumns(),
    /** A NOTIFICATION_KINDS value or `*` for the default row. */
    kind: text('kind', { length: 32 }).notNull(),
    inApp: bool('in_app').notNull().default(true),
    push: bool('push').notNull().default(true),
    mutedUntil: timestampMs('muted_until'),
    /**
     * Quiet hours, kept on the `*` row only: `HH:MM` in `quietTimezone`, and a window
     * that may cross midnight. They silence push, never the inbox — a notice written
     * at 3 a.m. is still there at 8, and dropping it would lose it.
     */
    quietFrom: text('quiet_from', { length: 5 }),
    quietTo: text('quiet_to', { length: 5 }),
    quietTimezone: text('quiet_timezone', { length: 64 }),
  },
  (t) => [uniqueIndex('notification_preferences_owner_kind_uq').on(t.workspace, t.ownerId, t.kind)],
);

export const webhooks = sqliteTable(
  'webhooks',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    url: text('url').notNull(),
    /** HMAC-SHA256 signing key (models.secrets); null = unsigned. */
    signingSecretId: ulid('signing_secret_id'),
    /**
     * The signing key itself, when the hub holds it rather than the models store.
     *
     * ADR 0010's one credential store is about *provider* credentials — a key added once
     * that every agent inherits. A webhook's HMAC key is not that: it belongs to one
     * webhook and nothing else ever reads it. It is stored here, never returned, and read
     * back as the contract's `[stored]`.
     */
    signingSecret: text('signing_secret'),
    /** Workspaces this webhook fires for; empty means every one of them. */
    profiles: json<string[]>('profiles').notNull().default(EMPTY_ARRAY),
    /** Include message text in payloads; off means ids only. */
    includeContent: bool('include_content').notNull().default(false),
    /**
     * Allow a URL that resolves to a private address. Off by default: a webhook is a URL
     * a person typed, and a hub that will POST to `127.0.0.1` on request is a hub that
     * can be asked to knock on doors inside its own network.
     */
    allowPrivateNetwork: bool('allow_private_network').notNull().default(false),
    maxRetries: integer('max_retries').notNull().default(3),
    deliveredCount: integer('delivered_count').notNull().default(0),
    lastError: text('last_error'),
    /** Realtime event names to forward, e.g. ["task.moved", "run.failed"]. */
    events: json<string[]>('events').notNull().default(EMPTY_ARRAY),
    /** Non-secret static headers. */
    headers: json<Record<string, string>>('headers').notNull().default(EMPTY_OBJECT),
    enabled: bool('enabled').notNull().default(true),
    failureCount: integer('failure_count').notNull().default(0),
    lastStatus: integer('last_status'),
    lastDeliveredAt: timestampMs('last_delivered_at'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [index('webhooks_workspace_idx').on(t.workspace, t.enabled, t.archivedAt)],
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    ...scopedColumns(),
    webhookId: ulid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventName: text('event_name', { length: 64 }).notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    status: text('status', { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    nextAttemptAt: timestampMs('next_attempt_at'),
    deliveredAt: timestampMs('delivered_at'),
  },
  (t) => [
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    index('webhook_deliveries_retry_idx').on(t.status, t.nextAttemptAt),
    check('webhook_deliveries_status_check', inList(t.status, WEBHOOK_DELIVERY_STATUSES)),
  ],
);

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
