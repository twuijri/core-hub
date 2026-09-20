/**
 * plugins — Docker/MCP based extensions and skill packs installed on the
 * host, enabled per workspace, and the tools/skills they expose.
 *
 * Global: plugins, plugin_tools (installed on the host, declared by the
 * manifest). Scoped: plugin_bindings (enabled + configured per workspace).
 *
 * Cross-module id columns: plugins.install_job_id -> audit.jobs,
 * plugin_bindings.secret_refs values -> models.secrets,
 * plugin_bindings.exposed_to -> agents.agents ids or `*`.
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

export const PLUGIN_KINDS = ['mcp_server', 'docker', 'skill_pack'] as const;
export const PLUGIN_SOURCES = ['registry', 'manual', 'git'] as const;
export const PLUGIN_INSTALL_STATES = [
  'not_installed',
  'installing',
  'installed',
  'updating',
  'broken',
  'removed',
] as const;
export const PLUGIN_BINDING_STATUSES = ['stopped', 'starting', 'running', 'error'] as const;
export const PLUGIN_TOOL_KINDS = ['tool', 'skill', 'prompt', 'resource'] as const;

export type PluginManifest = {
  name: string;
  version: string;
  /** mcp_server: argv or `{ image, ports }` for docker. */
  start?: Record<string, unknown>;
  /** Config keys the binding must provide, with `secret: true` for secrets. */
  config?: Record<
    string,
    { type: 'string' | 'number' | 'boolean'; secret?: boolean; required?: boolean }
  >;
  /** Declared tools/skills; refreshed from the running server when it lists them. */
  tools?: Array<{ key: string; name: string; kind?: (typeof PLUGIN_TOOL_KINDS)[number] }>;
};

export const plugins = sqliteTable(
  'plugins',
  {
    ...globalColumns(),
    slug: text('slug', { length: 64 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    icon: text('icon', { length: 64 }),
    kind: text('kind', { enum: PLUGIN_KINDS }).notNull(),
    source: text('source', { enum: PLUGIN_SOURCES }).notNull().default('manual'),
    /** Registry name, git URL or image reference. */
    sourceRef: text('source_ref'),
    version: text('version', { length: 64 }),
    installState: text('install_state', { enum: PLUGIN_INSTALL_STATES })
      .notNull()
      .default('not_installed'),
    installJobId: ulid('install_job_id'),
    manifest: json<PluginManifest>('manifest').notNull(),
    lastError: text('last_error'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('plugins_slug_uq').on(t.slug),
    check('plugins_kind_check', inList(t.kind, PLUGIN_KINDS)),
    check('plugins_source_check', inList(t.source, PLUGIN_SOURCES)),
    check('plugins_install_state_check', inList(t.installState, PLUGIN_INSTALL_STATES)),
  ],
);

export const pluginBindings = sqliteTable(
  'plugin_bindings',
  {
    ...scopedColumns(),
    pluginId: ulid('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    enabled: bool('enabled').notNull().default(false),
    /** Non-secret config values keyed by the manifest's config keys. */
    config: json<Record<string, unknown>>('config').notNull().default(EMPTY_OBJECT),
    /** config key -> models.secrets id for keys the manifest marks `secret`. */
    secretRefs: json<Record<string, string>>('secret_refs').notNull().default(EMPTY_OBJECT),
    /** agents.id list, or ["*"] for every agent in the workspace. */
    exposedTo: json<string[]>('exposed_to').notNull().default(EMPTY_ARRAY),
    status: text('status', { enum: PLUGIN_BINDING_STATUSES }).notNull().default('stopped'),
    lastStartedAt: timestampMs('last_started_at'),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('plugin_bindings_workspace_plugin_uq').on(t.workspace, t.pluginId),
    check('plugin_bindings_status_check', inList(t.status, PLUGIN_BINDING_STATUSES)),
  ],
);

export const pluginTools = sqliteTable(
  'plugin_tools',
  {
    ...globalColumns(),
    pluginId: ulid('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    key: text('key', { length: 120 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    kind: text('kind', { enum: PLUGIN_TOOL_KINDS }).notNull().default('tool'),
    /** JSON Schema of the tool input, as the plugin declared it. */
    inputSchema: json<Record<string, unknown>>('input_schema'),
  },
  (t) => [
    uniqueIndex('plugin_tools_plugin_key_uq').on(t.pluginId, t.key),
    index('plugin_tools_kind_idx').on(t.kind),
    check('plugin_tools_kind_check', inList(t.kind, PLUGIN_TOOL_KINDS)),
  ],
);
