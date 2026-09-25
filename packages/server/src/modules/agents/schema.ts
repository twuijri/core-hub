/**
 * agents — the registry of agents on the host, their adapters and the
 * per-workspace settings that drive them.
 *
 * Global: agent_adapters, agents (an installed CLI is a host fact).
 * Scoped: agent_settings (ADR 0005: each workspace has its own agent settings).
 *
 * Cross-module id columns: agents.install_job_id -> audit.jobs,
 * agent_settings.default_model_id -> models.models,
 * agent_settings.secret_refs values -> models.secrets.
 *
 * The vocabulary here is the contract's: `AGENT_CAPABILITIES`, `AGENT_SECTIONS`,
 * `AGENT_SOURCES` and `ADAPTER_KINDS` hold exactly the values of `AgentCapability`,
 * `AgentSection`, `AgentInstall.source` and `AgentKind` in
 * `packages/contracts/openapi.yaml`, so no translation table sits between the database and
 * the API (docs/domain/agents.md).
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

/** Contract `AgentKind`. `builtin` is reserved for the hub's own lightweight agent. */
export const ADAPTER_KINDS = ['hermes', 'acp', 'harness', 'builtin'] as const;
export const ADAPTER_STATUSES = ['available', 'unavailable'] as const;
/** Contract `AgentInstall.source`. */
export const AGENT_SOURCES = ['managed', 'user_cli', 'builtin', 'none'] as const;
/**
 * ADR 0006 names four resting/moving states; `updating` is the fifth because the contract
 * distinguishes an update in flight from a first install. `failed` maps to the contract's
 * `AgentStatus.error`.
 */
export const AGENT_INSTALL_STATES = [
  'not_installed',
  'installing',
  'installed',
  'updating',
  'failed',
] as const;
export const APPROVAL_MODES = ['ask', 'auto_safe', 'auto_all'] as const;

/** Contract `AgentCapability`. */
export const AGENT_CAPABILITIES = [
  'streaming',
  'tools',
  'approvals',
  'mcp',
  'skills',
  'memory',
  'channels',
  'worktrees',
  'resume',
  'vision',
  'audio',
  'plugins',
  'presets',
  'journey',
  'jobs',
  'tasks',
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** Contract `AgentSection` — the rows a client draws under an agent's card. */
export const AGENT_SECTIONS = [
  'jobs',
  'tasks',
  'channels',
  'skills',
  'plugins',
  'presets',
  'mcp',
  'memory',
  'journey',
  'settings',
] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];

export type AgentSettingsBody = {
  maxTurns?: number;
  timeoutSeconds?: number;
  /** Adapter-specific keys the adapter declares in `settings()`; validated there. */
  [key: string]: unknown;
};

export const agentAdapters = sqliteTable(
  'agent_adapters',
  {
    ...globalColumns(),
    kind: text('kind', { enum: ADAPTER_KINDS }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    /** Version of the adapter code, so a client can show "limited" harnesses. */
    version: text('version', { length: 32 }).notNull(),
    capabilities: json<AgentCapability[]>('capabilities').notNull().default(EMPTY_ARRAY),
    status: text('status', { enum: ADAPTER_STATUSES }).notNull().default('available'),
    lastProbeAt: timestampMs('last_probe_at'),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('agent_adapters_kind_uq').on(t.kind),
    check('agent_adapters_kind_check', inList(t.kind, ADAPTER_KINDS)),
    check('agent_adapters_status_check', inList(t.status, ADAPTER_STATUSES)),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    ...globalColumns(),
    /** The catalog entry's id (ADR 0006); the contract calls it `slug`. */
    slug: text('slug', { length: 64 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    vendor: text('vendor', { length: 120 }),
    /** SPDX id of the agent's own licence, copied from the catalog entry. */
    licence: text('licence', { length: 64 }),
    description: text('description'),
    icon: text('icon', { length: 64 }),
    adapterId: ulid('adapter_id')
      .notNull()
      .references(() => agentAdapters.id, { onDelete: 'restrict' }),
    /** Denormalised from the adapter so lists need no join. */
    adapterKind: text('adapter_kind', { enum: ADAPTER_KINDS }).notNull(),
    source: text('source', { enum: AGENT_SOURCES }).notNull().default('none'),
    /** argv array used to start the agent (ACP/harness) — never a shell string. */
    command: json<string[]>('command').notNull().default(EMPTY_ARRAY),
    executablePath: text('executable_path'),
    /** npm/pip package the hub installs for a `managed` agent. */
    packageName: text('package_name', { length: 200 }),
    /** Hermes adapter: gateway base URL; other adapters: null. */
    endpoint: text('endpoint'),
    version: text('version', { length: 64 }),
    latestVersion: text('latest_version', { length: 64 }),
    autoUpdate: bool('auto_update').notNull().default(false),
    checkedAt: timestampMs('checked_at'),
    installState: text('install_state', { enum: AGENT_INSTALL_STATES })
      .notNull()
      .default('not_installed'),
    installJobId: ulid('install_job_id'),
    detectedAt: timestampMs('detected_at'),
    capabilities: json<AgentCapability[]>('capabilities').notNull().default(EMPTY_ARRAY),
    sections: json<AgentSection[]>('sections').notNull().default(EMPTY_ARRAY),
    /** True for the process harness: the UI marks the agent "limited". */
    limited: bool('limited').notNull().default(false),
    /** The harness is declared but cannot be chosen yet (ADR 0002 "last resort"). */
    selectable: bool('selectable').notNull().default(true),
    lastError: text('last_error'),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('agents_slug_uq').on(t.slug),
    index('agents_adapter_idx').on(t.adapterId),
    check('agents_adapter_kind_check', inList(t.adapterKind, ADAPTER_KINDS)),
    check('agents_source_check', inList(t.source, AGENT_SOURCES)),
    check('agents_install_state_check', inList(t.installState, AGENT_INSTALL_STATES)),
  ],
);

export const agentSettings = sqliteTable(
  'agent_settings',
  {
    ...scopedColumns(),
    agentId: ulid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    enabled: bool('enabled').notNull().default(true),
    defaultModelId: ulid('default_model_id'),
    approvalMode: text('approval_mode', { enum: APPROVAL_MODES }).notNull().default('ask'),
    maxTurns: integer('max_turns'),
    workingDir: text('working_dir'),
    settings: json<AgentSettingsBody>('settings').notNull().default(EMPTY_OBJECT),
    /** Non-secret environment for the agent process. */
    env: json<Record<string, string>>('env').notNull().default(EMPTY_OBJECT),
    /** env name -> models.secrets id; resolved at start, never stored in clear. */
    secretRefs: json<Record<string, string>>('secret_refs').notNull().default(EMPTY_OBJECT),
  },
  (t) => [
    uniqueIndex('agent_settings_workspace_agent_uq').on(t.workspace, t.agentId),
    check('agent_settings_approval_mode_check', inList(t.approvalMode, APPROVAL_MODES)),
  ],
);

/**
 * The hub's own tools, per profile (contract decision §58): whether the profile offers them
 * to its Hermes, which groups are on and which may write, and the hash of the key written
 * into the profile's `.env` (the key itself is never stored). One row per workspace, made
 * the first time an admin opens or changes the card; no row means off.
 */
export interface HubToolGroupState {
  enabled: boolean;
  allowWrites: boolean;
}

export const hubToolSettings = sqliteTable(
  'hub_tool_settings',
  {
    ...scopedColumns(),
    enabled: bool('enabled').notNull().default(false),
    groups: json<Record<string, HubToolGroupState>>('groups').notNull().default(EMPTY_OBJECT),
    /** SHA-256 of the profile's key; `null` while off. */
    keyHash: text('key_hash', { length: 64 }),
  },
  (t) => [
    uniqueIndex('hub_tool_settings_workspace_uq').on(t.workspace),
    uniqueIndex('hub_tool_settings_key_uq').on(t.keyHash),
  ],
);

/** The calls made to the hub's own tools, kept short (the newest 200 per profile). */
export const hubToolCalls = sqliteTable(
  'hub_tool_calls',
  {
    ...scopedColumns(),
    tool: text('tool', { length: 80 }).notNull(),
    ok: bool('ok').notNull(),
    errorCode: text('error_code', { length: 80 }),
    /** The person the call acted for; `null` when no run was live to act for. */
    userId: ulid('user_id'),
    sessionId: ulid('session_id'),
    runId: ulid('run_id'),
    durationMs: integer('duration_ms').notNull().default(0),
  },
  (t) => [index('hub_tool_calls_workspace_idx').on(t.workspace, t.createdAt)],
);
