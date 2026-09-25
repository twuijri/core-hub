/**
 * auth — workspaces, users, app tokens, device pairing, lockouts.
 *
 * Global tables (no `workspace` column, ADR 0005): workspaces, users,
 * app_tokens, pairing_codes, login_lockouts, channel_identities. Scoped: workspace_members.
 *
 * Cross-module id columns (no DB foreign key, validated through the owning
 * module's API): app_tokens.device_id / pairing_codes.device_id ->
 * devices.devices.
 *
 * Avatars (users, workspaces) are files under `<DATA_DIR>/avatars/`, not
 * knowledge attachments: attachments are workspace-scoped and these rows are
 * global. The row keeps only the MIME type; the file is named by the row id.
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

export const USER_ROLES = ['owner', 'admin', 'member'] as const;
export const USER_STATUSES = ['active', 'disabled'] as const;
export const LOCALES = ['ar', 'en'] as const;
export const APP_TOKEN_KINDS = ['personal', 'device', 'web'] as const;
export const APP_TOKEN_SCOPES = ['read', 'write', 'device', 'admin'] as const;
export const LOCKOUT_SUBJECT_KINDS = ['ip', 'user'] as const;
/** Which flow the failures belong to (the contract's `Lockout.kind`). */
export const LOCKOUT_KINDS = ['password', 'token', 'pairing'] as const;
export const PAIRING_CONNECTIONS = ['lan', 'relay'] as const;
/** The contract's `ChannelIdentityPlatform`: where a person can prove an account (§78). */
export const CHANNEL_IDENTITY_PLATFORMS = ['telegram', 'whatsapp'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type Locale = (typeof LOCALES)[number];
export type AppTokenKind = (typeof APP_TOKEN_KINDS)[number];
export type AppTokenScope = (typeof APP_TOKEN_SCOPES)[number];
export type LockoutKind = (typeof LOCKOUT_KINDS)[number];
export type PairingConnection = (typeof PAIRING_CONNECTIONS)[number];
export type ChannelIdentityPlatform = (typeof CHANNEL_IDENTITY_PLATFORMS)[number];

/** The contract's `ModelRef`. */
export type ModelRef = { providerId: string; model: string };

/** The contract's `ProfileSettings` (stored under `WorkspaceSettings.hub`). */
export type WorkspaceHubSettings = {
  proxy: {
    httpsProxy: string | null;
    httpProxy: string | null;
    allProxy: string | null;
    noProxy: string | null;
  };
  compression: {
    enabled: boolean;
    threshold: number;
    targetRatio: number;
    protectFirst: number;
    protectLast: number;
    /** `model.context_length` for Hermes: the window when the catalogue's is wrong. */
    contextLength: number | null;
  };
  privacy: { redactPii: boolean };
  appearance: {
    fontSize: number;
    textColor: string | null;
    accentColor: string | null;
    backgroundAttachmentId: string | null;
  };
};

export type WorkspaceSettings = {
  /** Default agent slug for "new session" in this workspace. */
  defaultAgent?: string;
  /** Hermes profile name this workspace drives (Hermes adapter). */
  hermesProfile?: string;
  /** The contract's `Profile.default_model`. */
  defaultModel?: ModelRef | null;
  /** The contract's `ProfileSettings`; missing sections fall back to defaults. */
  hub?: Partial<WorkspaceHubSettings>;
};

/** The contract's `Preferences`, stored as given (snake_case keys) so a PUT round-trips. */
export type UserPreferences = Record<string, unknown>;

export const workspaces = sqliteTable(
  'workspaces',
  {
    ...globalColumns(),
    /** URL/header-safe name carried in `X-Hub-Profile` when the client uses names. */
    slug: text('slug', { length: 64 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    color: text('color', { length: 16 }),
    icon: text('icon', { length: 64 }),
    /** MIME of the avatar file under `<DATA_DIR>/avatars/workspaces/<id>`; null = generated avatar. */
    avatarMime: text('avatar_mime', { length: 64 }),
    /** Exactly one workspace is the default for new users and tokens. */
    isDefault: bool('is_default').notNull().default(false),
    settings: json<WorkspaceSettings>('settings').notNull().default(EMPTY_OBJECT),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [uniqueIndex('workspaces_slug_uq').on(t.slug)],
);

export const users = sqliteTable(
  'users',
  {
    ...globalColumns(),
    username: text('username', { length: 64 }).notNull(),
    displayName: text('display_name', { length: 120 }),
    role: text('role', { enum: USER_ROLES }).notNull().default('member'),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    /** Argon2id hash. Never returned to a client, never logged. */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestampMs('password_changed_at'),
    locale: text('locale', { enum: LOCALES }).notNull().default('ar'),
    /** MIME of the avatar file under `<DATA_DIR>/avatars/users/<id>`; null = generated avatar. */
    avatarMime: text('avatar_mime', { length: 64 }),
    defaultWorkspaceId: ulid('default_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    preferences: json<UserPreferences>('preferences').notNull().default(EMPTY_OBJECT),
    lastLoginAt: timestampMs('last_login_at'),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    check('users_role_check', inList(t.role, USER_ROLES)),
    check('users_status_check', inList(t.status, USER_STATUSES)),
    check('users_locale_check', inList(t.locale, LOCALES)),
  ],
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    ...scopedColumns(),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('workspace_members_workspace_user_uq').on(t.workspace, t.userId),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

export const appTokens = sqliteTable(
  'app_tokens',
  {
    ...globalColumns(),
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `web` rows are the rotating refresh tokens of browser/desktop sign-ins. */
    kind: text('kind', { enum: APP_TOKEN_KINDS }).notNull().default('personal'),
    name: text('name', { length: 120 }).notNull(),
    /** SHA-256 of the bearer token. The token itself is shown once, never stored. */
    tokenHash: text('token_hash', { length: 64 }).notNull(),
    /** First 8 characters, for the "which token is this" list. */
    tokenPrefix: text('token_prefix', { length: 8 }).notNull(),
    scopes: json<AppTokenScope[]>('scopes').notNull().default(EMPTY_ARRAY),
    /** Set for `device` tokens issued by pairing. */
    deviceId: ulid('device_id'),
    expiresAt: timestampMs('expires_at'),
    lastUsedAt: timestampMs('last_used_at'),
    revokedAt: timestampMs('revoked_at'),
  },
  (t) => [
    uniqueIndex('app_tokens_hash_uq').on(t.tokenHash),
    index('app_tokens_user_idx').on(t.userId, t.revokedAt),
    check('app_tokens_kind_check', inList(t.kind, APP_TOKEN_KINDS)),
  ],
);

export const pairingCodes = sqliteTable(
  'pairing_codes',
  {
    ...globalColumns(),
    /** Short human code (`7KQ2-M9XW`); the QR payload is rebuilt from the row, never stored. */
    code: text('code', { length: 12 }).notNull(),
    createdByUserId: ulid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Workspace the paired device opens first. */
    initialWorkspaceId: ulid('initial_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    connection: text('connection', { enum: PAIRING_CONNECTIONS }).notNull().default('lan'),
    /** Origin the web client used to create the pairing; the QR tells the phone to call it. */
    hubUrl: text('hub_url', { length: 512 }).notNull(),
    expiresAt: timestampMs('expires_at').notNull(),
    consumedAt: timestampMs('consumed_at'),
    cancelledAt: timestampMs('cancelled_at'),
    deviceId: ulid('device_id'),
    appTokenId: ulid('app_token_id').references(() => appTokens.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('pairing_codes_code_uq').on(t.code),
    index('pairing_codes_expires_idx').on(t.expiresAt),
    check('pairing_codes_connection_check', inList(t.connection, PAIRING_CONNECTIONS)),
  ],
);

export const loginLockouts = sqliteTable(
  'login_lockouts',
  {
    ...globalColumns(),
    subjectKind: text('subject_kind', { enum: LOCKOUT_SUBJECT_KINDS }).notNull(),
    /** The client IP or the user id being throttled. */
    subject: text('subject', { length: 128 }).notNull(),
    kind: text('kind', { enum: LOCKOUT_KINDS }).notNull().default('password'),
    failures: integer('failures').notNull().default(0),
    lastFailureAt: timestampMs('last_failure_at'),
    lockedUntil: timestampMs('locked_until'),
  },
  (t) => [
    uniqueIndex('login_lockouts_subject_uq').on(t.subjectKind, t.subject, t.kind),
    check('login_lockouts_subject_kind_check', inList(t.subjectKind, LOCKOUT_SUBJECT_KINDS)),
    check('login_lockouts_kind_check', inList(t.kind, LOCKOUT_KINDS)),
  ],
);

/**
 * A messaging account a person proved is theirs (contract decision §78): a message from it runs
 * with that person's permissions, so the hub's own tools act as them. Global — one link per
 * account for the whole hub; the person's own memberships decide where it acts. `sender_id`
 * is the account as Hermes names the sender.
 */
export const channelIdentities = sqliteTable(
  'channel_identities',
  {
    ...globalColumns(),
    /** The person; their links go with them. */
    userId: ulid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: CHANNEL_IDENTITY_PLATFORMS }).notNull(),
    senderId: text('sender_id', { length: 320 }).notNull(),
    lastUsedAt: timestampMs('last_used_at'),
  },
  (t) => [
    uniqueIndex('channel_identities_account_uq').on(t.platform, t.senderId),
    index('channel_identities_user_idx').on(t.userId),
    check('channel_identities_platform_check', inList(t.platform, CHANNEL_IDENTITY_PLATFORMS)),
  ],
);
