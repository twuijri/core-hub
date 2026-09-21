/**
 * audit — the immutable audit trail, the usage/cost ledger, performance
 * snapshots, and jobs (long work with progress, invariant 4) with their
 * event log.
 *
 * Global with a nullable workspace: audit_events, jobs, job_events (a login
 * or a server update has no workspace). Global: performance_snapshots.
 * Scoped: usage_records.
 *
 * Other modules create jobs and usage records only through this module's
 * public API; they store the returned job id on their own rows
 * (agents.install_job_id, worktrees.create_job_id, plugins.install_job_id).
 *
 * Cross-module id columns: usage_records.run_id / session_id -> sessions,
 * usage_records.agent_id -> agents, usage_records.provider_id -> models,
 * audit_events.device_id -> devices, jobs.entity_id -> by `entity_kind`.
 */
import {
  check,
  index,
  sqliteTable,
  text,
  uniqueIndex,
  integer,
  real,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import {
  EMPTY_OBJECT,
  globalColumns,
  inList,
  json,
  scopedColumns,
  timestampMs,
  ulid,
} from '../../db/columns.js';

export const ACTOR_KINDS = ['user', 'agent', 'system', 'schedule', 'workflow', 'device'] as const;
export const COST_SOURCES = ['provider', 'estimated', 'unknown'] as const;
export const USAGE_ORIGINS = ['user', 'task', 'schedule', 'workflow', 'room', 'api'] as const;
export const JOB_STATUSES = [
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const JOB_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export const JOB_EVENT_LEVELS = ['debug', 'info', 'warn', 'error', 'progress'] as const;

export const auditEvents = sqliteTable(
  'audit_events',
  {
    ...globalColumns(),
    /** Null for hub-level actions (login, user management, updates). */
    workspace: ulid('workspace'),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorId: ulid('actor_id'),
    /** `<entity>.<verb>`, the same vocabulary as realtime events: `task.moved`, `secret.created`. */
    action: text('action', { length: 64 }).notNull(),
    entityKind: text('entity_kind', { length: 32 }),
    entityId: ulid('entity_id'),
    /** One line, English, for the admin log; clients localise by `action`. */
    summary: text('summary', { length: 300 }),
    /** Redacted before/after values; never secrets, never message bodies. */
    data: json<Record<string, unknown>>('data').notNull().default(EMPTY_OBJECT),
    deviceId: ulid('device_id'),
    requestId: text('request_id', { length: 64 }),
  },
  (t) => [
    index('audit_events_time_idx').on(t.createdAt),
    index('audit_events_workspace_time_idx').on(t.workspace, t.createdAt),
    index('audit_events_entity_idx').on(t.entityKind, t.entityId),
    index('audit_events_actor_idx').on(t.actorKind, t.actorId),
    check('audit_events_actor_kind_check', inList(t.actorKind, ACTOR_KINDS)),
  ],
);

export const usageRecords = sqliteTable(
  'usage_records',
  {
    ...scopedColumns(),
    /** The run this usage belongs to; one record per (run, model) the adapter reported. */
    runId: ulid('run_id').notNull(),
    sessionId: ulid('session_id').notNull(),
    agentId: ulid('agent_id').notNull(),
    providerId: ulid('provider_id'),
    modelLabel: text('model_label', { length: 200 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    /** Micro-USD (1e-6 USD) so sums stay integers. */
    costMicroUsd: integer('cost_micro_usd').notNull().default(0),
    costSource: text('cost_source', { enum: COST_SOURCES }).notNull().default('unknown'),
    /** Copied from the run so roll-ups by task/schedule/room need no join. */
    originKind: text('origin_kind', { enum: USAGE_ORIGINS }).notNull().default('user'),
    originId: ulid('origin_id'),
    recordedAt: timestampMs('recorded_at').notNull(),
  },
  (t) => [
    uniqueIndex('usage_records_run_model_uq').on(t.runId, t.modelLabel),
    index('usage_records_workspace_time_idx').on(t.workspace, t.recordedAt),
    index('usage_records_session_idx').on(t.sessionId),
    index('usage_records_agent_time_idx').on(t.workspace, t.agentId, t.recordedAt),
    index('usage_records_origin_idx').on(t.originKind, t.originId),
    check('usage_records_cost_source_check', inList(t.costSource, COST_SOURCES)),
    check('usage_records_origin_kind_check', inList(t.originKind, USAGE_ORIGINS)),
  ],
);

export const performanceSnapshots = sqliteTable(
  'performance_snapshots',
  {
    ...globalColumns(),
    capturedAt: timestampMs('captured_at').notNull(),
    cpuPercent: real('cpu_percent'),
    memoryBytes: integer('memory_bytes'),
    diskFreeBytes: integer('disk_free_bytes'),
    dbBytes: integer('db_bytes'),
    activeRuns: integer('active_runs').notNull().default(0),
    queuedJobs: integer('queued_jobs').notNull().default(0),
    connectedClients: integer('connected_clients').notNull().default(0),
    data: json<Record<string, unknown>>('data').notNull().default(EMPTY_OBJECT),
  },
  (t) => [index('performance_snapshots_time_idx').on(t.capturedAt)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    ...globalColumns(),
    /** Null for hub-level jobs (server update, backup). */
    workspace: ulid('workspace'),
    /** `<module>.<verb>`: `agents.install`, `tasks.worktree_create`, `plugins.install`, `knowledge.reindex`. */
    kind: text('kind', { length: 64 }).notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    /** 0..100; -1 when unknown (indeterminate progress bar). */
    progress: integer('progress').notNull().default(-1),
    progressMessage: text('progress_message', { length: 300 }),
    entityKind: text('entity_kind', { length: 32 }),
    entityId: ulid('entity_id'),
    input: json<Record<string, unknown>>('input').notNull().default(EMPTY_OBJECT),
    result: json<Record<string, unknown>>('result'),
    errorCode: text('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    parentJobId: ulid('parent_job_id').references((): AnySQLiteColumn => jobs.id, {
      onDelete: 'set null',
    }),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
    cancelRequestedAt: timestampMs('cancel_requested_at'),
    /** Touched by the worker every few seconds; a stale heartbeat marks the job failed on restart. */
    heartbeatAt: timestampMs('heartbeat_at'),
  },
  (t) => [
    index('jobs_status_idx').on(t.status, t.createdAt),
    index('jobs_workspace_idx').on(t.workspace, t.createdAt),
    index('jobs_entity_idx').on(t.entityKind, t.entityId),
    check('jobs_status_check', inList(t.status, JOB_STATUSES)),
  ],
);

export const jobEvents = sqliteTable(
  'job_events',
  {
    ...globalColumns(),
    workspace: ulid('workspace'),
    jobId: ulid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    level: text('level', { enum: JOB_EVENT_LEVELS }).notNull().default('info'),
    message: text('message').notNull(),
    data: json<Record<string, unknown>>('data').notNull().default(EMPTY_OBJECT),
  },
  (t) => [
    uniqueIndex('job_events_job_seq_uq').on(t.jobId, t.seq),
    check('job_events_level_check', inList(t.level, JOB_EVENT_LEVELS)),
  ],
);
