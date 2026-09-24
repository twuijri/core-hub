/**
 * models — the hub's one provider and credential store (ADR 0010).
 *
 * A person adds a provider key **once, here**; the hub propagates it to every agent
 * (`propagation.ts`): into Hermes's own home through its `.env`, and into a coding
 * agent's process environment at start. Nobody configures a provider per agent.
 *
 * All tables are workspace-scoped, with one exception in meaning (contract decision §38): a
 * provider row with `shared = true` is **every** profile's. It is stored under the default
 * profile, and so are its models and its key (`shared-provider:<family>`). A row with
 * `shared = false` is its profile's own, and in that profile it wins over a shared row of the
 * same slug. `model_defaults`, `ensembles` and `speech_settings` are each profile's own
 * choices. `secrets` is the only table that holds ciphertext; every column marked
 * ENCRYPTED is AES-256-GCM under the server data key (`<data>/keys/data.key`), rotated
 * by `key_id`, masked as `[stored]` on read, never logged, never returned.
 *
 * Cross-module consumers reference `secrets.id` by id: agents.agent_settings,
 * notify.webhooks, plugins.plugin_bindings.
 *
 * The vocabulary is the contract's: `providers.kind`, `models.kind`,
 * `models.capabilities`, `providers.api_mode` and `providers.visibility_mode` hold
 * exactly the values of `ProviderKind`, `ModelKind`, `ModelCapability`, `Provider.api_mode`
 * and `Visibility.mode` in `packages/contracts/openapi.yaml`, so no translation table sits
 * between the database and the API.
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

/** The contract's `ProviderKind`. */
export const PROVIDER_KINDS = ['llm', 'stt', 'tts'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** The contract's `Provider.api_mode`. */
export const API_MODES = ['native', 'chat_completions', 'responses'] as const;
export type ApiMode = (typeof API_MODES)[number];

/** The contract's `Provider.auth.kind`. */
export const AUTH_KINDS = ['api_key', 'oauth', 'none'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/** The contract's `Provider.catalogue.status`. */
export const CATALOGUE_STATUSES = ['ready', 'loading', 'error', 'unsupported'] as const;
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];

/** Outcome of the last `models.testProvider` (domain docs/domain/models.md). */
export const PROVIDER_STATUSES = ['unconfigured', 'ok', 'error'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/** The contract's `Visibility.mode`. */
export const VISIBILITY_MODES = ['all', 'include'] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];

/** The contract's `ModelKind`. */
export const MODEL_KINDS = ['chat', 'embedding', 'stt', 'tts'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** The contract's `ModelCapability`. */
export const MODEL_CAPABILITIES = ['vision', 'tools', 'reasoning', 'audio', 'streaming'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_SOURCES = ['catalogue', 'discovered', 'manual'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

/**
 * Roles a workspace assigns a model to. `chat` is the contract's `ModelDefaults.default`;
 * the rest are its `auxiliary.assignments` keys, declared by the server
 * (`defaults.ts` §AUXILIARY_TASKS) and shown with an Arabic and an English label.
 */
export const MODEL_ROLES = ['chat', 'coding', 'title', 'summary', 'embedding'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const SECRET_KINDS = ['api_key', 'token', 'password', 'generic'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface ProviderCapabilities {
  chat?: boolean;
  stt?: boolean;
  tts?: boolean;
  embeddings?: boolean;
  /** Provider can list its own models: `models.refreshProvider` is meaningful. */
  listModels?: boolean;
  /** Provider can list TTS voices (`models.listVoices`). */
  listVoices?: boolean;
}

/** Micro-USD per million tokens (integers; the contract renders them as `Money`). */
export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

/** STT/TTS settings of one speech provider (the contract's `SpeechProvider.settings`). */
export interface SpeechProviderSettings {
  model?: string | null;
  language?: string | null;
  voice?: string | null;
}

/** One member of an ensemble (the contract's `EnsembleMember`). */
export interface EnsembleMemberValue {
  provider_id: string;
  model: string;
  reasoning_effort?: string | null;
}

export const secrets = sqliteTable(
  'secrets',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    kind: text('kind', { enum: SECRET_KINDS }).notNull().default('generic'),
    /** ENCRYPTED. Base64 AES-256-GCM ciphertext (with the tag); null once wiped. */
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
    /** Stable id inside the workspace: `anthropic`, `openai-tts`, `custom-ollama`. */
    slug: text('slug', { length: 64 }).notNull(),
    /**
     * Every profile's provider (stored under the default profile), or — false — only the
     * profile in `workspace`, where it wins over a shared one of the same slug (decision §38).
     */
    shared: bool('shared').notNull().default(false),
    label: text('label', { length: 80 }).notNull(),
    kind: text('kind', { enum: PROVIDER_KINDS }).notNull().default('llm'),
    /** Seeded from the bundled catalogue; a person may disable it but never delete it. */
    builtin: bool('builtin').notNull().default(false),
    enabled: bool('enabled').notNull().default(true),
    baseUrl: text('base_url'),
    apiMode: text('api_mode', { enum: API_MODES }).notNull().default('native'),
    authKind: text('auth_kind', { enum: AUTH_KINDS }).notNull().default('api_key'),
    /**
     * The one credential. Providers of the same **credential family** (OpenAI chat, OpenAI
     * speech-to-text, OpenAI text-to-speech) share this row, which is what makes "add the
     * key once" true across `llm`, `stt` and `tts` (ADR 0010).
     */
    apiKeySecretId: ulid('api_key_secret_id').references((): AnySQLiteColumn => secrets.id, {
      onDelete: 'set null',
    }),
    /** Credential family (`openai`); providers sharing it share `api_key_secret_id`. */
    family: text('family', { length: 64 }).notNull(),
    /** Non-secret extra headers (org id, project id). */
    headers: json<Record<string, string>>('headers').notNull().default(EMPTY_OBJECT),
    capabilities: json<ProviderCapabilities>('capabilities').notNull().default(EMPTY_OBJECT),
    settings: json<SpeechProviderSettings>('settings').notNull().default(EMPTY_OBJECT),
    visibilityMode: text('visibility_mode', { enum: VISIBILITY_MODES }).notNull().default('all'),
    visibleModels: json<string[]>('visible_models').notNull().default(EMPTY_ARRAY),
    catalogueStatus: text('catalogue_status', { enum: CATALOGUE_STATUSES })
      .notNull()
      .default('loading'),
    catalogueRefreshedAt: timestampMs('catalogue_refreshed_at'),
    catalogueError: text('catalogue_error'),
    status: text('status', { enum: PROVIDER_STATUSES }).notNull().default('unconfigured'),
    lastCheckedAt: timestampMs('last_checked_at'),
    lastError: text('last_error'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('providers_workspace_shared_slug_uq').on(t.workspace, t.shared, t.slug),
    index('providers_workspace_kind_idx').on(t.workspace, t.kind),
    index('providers_workspace_family_idx').on(t.workspace, t.family),
    check('providers_kind_check', inList(t.kind, PROVIDER_KINDS)),
    check('providers_api_mode_check', inList(t.apiMode, API_MODES)),
    check('providers_auth_kind_check', inList(t.authKind, AUTH_KINDS)),
    check('providers_catalogue_status_check', inList(t.catalogueStatus, CATALOGUE_STATUSES)),
    check('providers_status_check', inList(t.status, PROVIDER_STATUSES)),
    check('providers_visibility_mode_check', inList(t.visibilityMode, VISIBILITY_MODES)),
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
    /** A name the person gave it; shown instead of `label` when set. */
    alias: text('alias', { length: 200 }),
    kind: text('kind', { enum: MODEL_KINDS }).notNull().default('chat'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    pricing: json<ModelPricing>('pricing').notNull().default(EMPTY_OBJECT),
    capabilities: json<ModelCapability[]>('capabilities').notNull().default(EMPTY_ARRAY),
    /** The contract's `Model.disabled` is `!enabled`. */
    enabled: bool('enabled').notNull().default(true),
    /** The contract's `Model.visible`: hidden from pickers without being disabled. */
    visible: bool('visible').notNull().default(true),
    preview: bool('preview').notNull().default(false),
    /** `manual` is the contract's `Model.custom`. */
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

/** Mixture-of-agents presets (the contract's `Ensemble`). At most one is `active`. */
export const ensembles = sqliteTable(
  'ensembles',
  {
    ...scopedColumns(),
    name: text('name', { length: 80 }).notNull(),
    enabled: bool('enabled').notNull().default(true),
    active: bool('active').notNull().default(false),
    members: json<EnsembleMemberValue[]>('members').notNull().default(EMPTY_ARRAY),
    /**
     * Required: the contract's `Ensemble.aggregator` is not nullable, so an ensemble
     * without one could not be serialized. `models.createEnsemble` refuses instead.
     */
    aggregator: json<EnsembleMemberValue>('aggregator').notNull(),
    maxTokens: integer('max_tokens'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [uniqueIndex('ensembles_workspace_name_uq').on(t.workspace, t.name)],
);

/** Which speech providers the workspace speaks with. One row per workspace. */
export const speechSettings = sqliteTable(
  'speech_settings',
  {
    ...scopedColumns(),
    sttProviderId: ulid('stt_provider_id').references((): AnySQLiteColumn => providers.id, {
      onDelete: 'set null',
    }),
    ttsProviderId: ulid('tts_provider_id').references((): AnySQLiteColumn => providers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('speech_settings_workspace_uq').on(t.workspace)],
);

export type SecretRow = typeof secrets.$inferSelect;
export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type ModelDefaultRow = typeof modelDefaults.$inferSelect;
export type EnsembleRow = typeof ensembles.$inferSelect;
export type SpeechSettingsRow = typeof speechSettings.$inferSelect;
