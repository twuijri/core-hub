/**
 * models — providers, their keys (secrets), the model catalogue, defaults
 * with fallbacks, and the workspace secret store.
 *
 * All tables are workspace-scoped (ADR 0005: each workspace has its own
 * models). `secrets` is the only table that holds ciphertext; every column
 * marked ENCRYPTED is AES-256-GCM under the server data key, masked as
 * `[stored]` on read, never logged, never returned.
 *
 * Cross-module consumers reference `secrets.id` by id: agents.agent_settings,
 * notify.webhooks, plugins.plugin_bindings.
 */
import {
  check,
  index,
  sqliteTable,
  text,
  uniqueIndex,
  integer,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import {
  EMPTY_ARRAY,
  EMPTY_OBJECT,
  bool,
  inList,
  json,
  scopedColumns,
  timestampMs,
  ulid,
} from '../../db/columns.js';

export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'mistral',
  'groq',
  'ollama',
  'openai_compatible',
  'custom',
] as const;
export const PROVIDER_STATUSES = ['unconfigured', 'ok', 'error'] as const;
export const MODEL_KINDS = ['chat', 'stt', 'tts', 'embedding', 'image'] as const;
export const MODEL_SOURCES = ['catalogue', 'discovered', 'manual'] as const;
export const MODEL_ROLES = [
  'chat',
  'coding',
  'titles',
  'summaries',
  'stt',
  'tts',
  'embedding',
] as const;
export const SECRET_KINDS = ['api_key', 'token', 'password', 'generic'] as const;

export type ProviderCapabilities = {
  chat?: boolean;
  stt?: boolean;
  tts?: boolean;
  embeddings?: boolean;
  images?: boolean;
  /** Provider can list its models (`discovered` source). */
  listModels?: boolean;
};

/** Micro-USD per million tokens. */
export type ModelPricing = {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type ModelCapabilities = {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  json?: boolean;
};

export const secrets = sqliteTable(
  'secrets',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    kind: text('kind', { enum: SECRET_KINDS }).notNull().default('generic'),
    /** ENCRYPTED. Base64 AES-256-GCM ciphertext; null once wiped. */
    ciphertext: text('ciphertext'),
    /** ENCRYPTED (metadata). Base64 GCM nonce for `ciphertext`. */
    nonce: text('nonce', { length: 32 }),
    /** Version of the data key that encrypted this row; enables rotation. */
    keyId: text('key_id', { length: 32 }).notNull(),
    /** Last 4 characters, for "sk-…ab12" in the UI. */
    hint: text('hint', { length: 4 }),
    rotatedAt: timestampMs('rotated_at'),
    /** Ciphertext and nonce nulled; row kept so audit references resolve. */
    wipedAt: timestampMs('wiped_at'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('secrets_workspace_name_uq').on(t.workspace, t.name),
    check('secrets_kind_check', inList(t.kind, SECRET_KINDS)),
  ],
);

export const providers = sqliteTable(
  'providers',
  {
    ...scopedColumns(),
    kind: text('kind', { enum: PROVIDER_KINDS }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    baseUrl: text('base_url'),
    apiKeySecretId: ulid('api_key_secret_id').references((): AnySQLiteColumn => secrets.id, {
      onDelete: 'set null',
    }),
    /** Non-secret extra headers (org id, project id). */
    headers: json<Record<string, string>>('headers').notNull().default(EMPTY_OBJECT),
    capabilities: json<ProviderCapabilities>('capabilities').notNull().default(EMPTY_OBJECT),
    enabled: bool('enabled').notNull().default(true),
    status: text('status', { enum: PROVIDER_STATUSES }).notNull().default('unconfigured'),
    lastCheckedAt: timestampMs('last_checked_at'),
    lastError: text('last_error'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('providers_workspace_name_uq').on(t.workspace, t.name),
    index('providers_workspace_kind_idx').on(t.workspace, t.kind),
    check('providers_kind_check', inList(t.kind, PROVIDER_KINDS)),
    check('providers_status_check', inList(t.status, PROVIDER_STATUSES)),
  ],
);

export const models = sqliteTable(
  'models',
  {
    ...scopedColumns(),
    providerId: ulid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    /** The provider's own model id, e.g. "claude-sonnet-4-5". */
    modelKey: text('model_key', { length: 200 }).notNull(),
    label: text('label', { length: 200 }).notNull(),
    kind: text('kind', { enum: MODEL_KINDS }).notNull().default('chat'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    pricing: json<ModelPricing>('pricing').notNull().default(EMPTY_OBJECT),
    capabilities: json<ModelCapabilities>('capabilities').notNull().default(EMPTY_OBJECT),
    enabled: bool('enabled').notNull().default(true),
    source: text('source', { enum: MODEL_SOURCES }).notNull().default('catalogue'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('models_provider_key_uq').on(t.providerId, t.modelKey),
    index('models_workspace_kind_idx').on(t.workspace, t.kind, t.enabled),
    check('models_kind_check', inList(t.kind, MODEL_KINDS)),
    check('models_source_check', inList(t.source, MODEL_SOURCES)),
  ],
);

export const modelDefaults = sqliteTable(
  'model_defaults',
  {
    ...scopedColumns(),
    role: text('role', { enum: MODEL_ROLES }).notNull(),
    modelId: ulid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    /** Ordered fallback chain of models.id, tried when the primary fails. */
    fallbackModelIds: json<string[]>('fallback_model_ids').notNull().default(EMPTY_ARRAY),
  },
  (t) => [
    uniqueIndex('model_defaults_workspace_role_uq').on(t.workspace, t.role),
    check('model_defaults_role_check', inList(t.role, MODEL_ROLES)),
  ],
);
