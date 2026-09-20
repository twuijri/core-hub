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

export const ADAPTER_KINDS = ['acp', 'hermes', 'process'] as const;
export const ADAPTER_STATUSES = ['available', 'unavailable'] as const;
export const AGENT_SOURCES = ['detected', 'manual', 'bundled'] as const;
export const AGENT_INSTALL_STATES = [
  'not_installed',
  'installing',
  'installed',
  'updating',
  'broken',
] as const;
export const APPROVAL_MODES = ['ask', 'auto_safe', 'auto_all'] as const;

/** What an adapter (or a probed agent) can do; the UI hides what is false. */
export type AgentCapabilities = {
  streaming?: boolean;
  toolCalls?: boolean;
  approvals?: boolean;
  interrupt?: boolean;
  resumeSession?: boolean;
  reasoning?: boolean;
  attachments?: boolean;
  memory?: boolean;
  skills?: boolean;
  /** Process harness only: the whitelisted commands it can drive. */
  commandWhitelist?: string[];
};

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
    capabilities: json<AgentCapabilities>('capabilities').notNull().default(EMPTY_OBJECT),
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
    slug: text('slug', { length: 64 }).notNull(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    icon: text('icon', { length: 64 }),
    adapterId: ulid('adapter_id')
      .notNull()
      .references(() => agentAdapters.id, { onDelete: 'restrict' }),
    /** Denormalised from the adapter so lists need no join. */
    adapterKind: text('adapter_kind', { enum: ADAPTER_KINDS }).notNull(),
    source: text('source', { enum: AGENT_SOURCES }).notNull().default('detected'),
    /** argv array used to start the agent (ACP/process) — never a shell string. */
    command: json<string[]>('command').notNull().default(EMPTY_ARRAY),
    executablePath: text('executable_path'),
    /** Hermes adapter: gateway base URL; other adapters: null. */
    endpoint: text('endpoint'),
    version: text('version', { length: 64 }),
    installState: text('install_state', { enum: AGENT_INSTALL_STATES })
      .notNull()
      .default('not_installed'),
    installJobId: ulid('install_job_id'),
    detectedAt: timestampMs('detected_at'),
    capabilities: json<AgentCapabilities>('capabilities').notNull().default(EMPTY_OBJECT),
    /** True for process-harness agents: the UI marks them "limited". */
    limited: bool('limited').notNull().default(false),
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
