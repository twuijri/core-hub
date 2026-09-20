/**
 * updates — release channels for the clients, published releases, and which
 * channel each device follows.
 *
 * All tables are global (ADR 0005: updates are an admin surface).
 *
 * Cross-module id columns: channel_subscriptions.device_id -> devices.devices.
 */
import { check, index, sqliteTable, text, uniqueIndex, integer } from 'drizzle-orm/sqlite-core';
import { bool, globalColumns, inList, timestampMs, ulid } from '../../db/columns.js';

export const RELEASE_PLATFORMS = [
  'android',
  'ios',
  'desktop_linux',
  'desktop_macos',
  'desktop_windows',
  'web',
  'server',
] as const;

export const releaseChannels = sqliteTable(
  'release_channels',
  {
    ...globalColumns(),
    /** `stable`, `test`, `dev` — the key clients send when they check for updates. */
    key: text('key', { length: 32 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    isDefault: bool('is_default').notNull().default(false),
    enabled: bool('enabled').notNull().default(true),
  },
  (t) => [uniqueIndex('release_channels_key_uq').on(t.key)],
);

export const releases = sqliteTable(
  'releases',
  {
    ...globalColumns(),
    channelId: ulid('channel_id')
      .notNull()
      .references(() => releaseChannels.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: RELEASE_PLATFORMS }).notNull(),
    /** Semver; clients compare it with their own. */
    version: text('version', { length: 32 }).notNull(),
    buildNumber: integer('build_number'),
    notesAr: text('notes_ar'),
    notesEn: text('notes_en'),
    artifactUrl: text('artifact_url'),
    artifactSha256: text('artifact_sha256', { length: 64 }),
    artifactSizeBytes: integer('artifact_size_bytes'),
    /** Oldest server this client build can talk to. */
    minServerVersion: text('min_server_version', { length: 32 }),
    mandatory: bool('mandatory').notNull().default(false),
    publishedAt: timestampMs('published_at'),
    yankedAt: timestampMs('yanked_at'),
  },
  (t) => [
    uniqueIndex('releases_channel_platform_version_uq').on(t.channelId, t.platform, t.version),
    index('releases_latest_idx').on(t.channelId, t.platform, t.publishedAt),
    check('releases_platform_check', inList(t.platform, RELEASE_PLATFORMS)),
  ],
);

export const channelSubscriptions = sqliteTable(
  'channel_subscriptions',
  {
    ...globalColumns(),
    deviceId: ulid('device_id').notNull(),
    channelId: ulid('channel_id')
      .notNull()
      .references(() => releaseChannels.id, { onDelete: 'cascade' }),
    /** Version the device reported at its last check. */
    lastReportedVersion: text('last_reported_version', { length: 32 }),
    lastCheckedAt: timestampMs('last_checked_at'),
  },
  (t) => [uniqueIndex('channel_subscriptions_device_uq').on(t.deviceId)],
);
