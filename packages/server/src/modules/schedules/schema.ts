/**
 * schedules — cron/interval/one-shot schedules, their tick history, and
 * workflows (a DAG of nodes) with their runs and node runs.
 *
 * All tables are workspace-scoped. A schedule targets either a prompt (one
 * agent run in a session) or a workflow; every tick is a schedule_run that
 * points at the sessions.run or the workflow_run it produced.
 *
 * Cross-module id columns: schedules.agent_id -> agents.agents,
 * schedules.model_id -> models.models, schedule_runs.run_id / node_runs.run_id
 * -> sessions.runs, node_runs.approval_id -> sessions.approvals,
 * node_runs.task_id -> tasks.tasks, workflow_runs.trigger_ref -> the entity
 * named by `trigger_kind`.
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

export const SCHEDULE_KINDS = ['cron', 'interval', 'once'] as const;
export const SCHEDULE_TARGETS = ['prompt', 'workflow'] as const;
export const OVERLAP_POLICIES = ['skip', 'queue', 'parallel'] as const;
export const MISFIRE_POLICIES = ['skip', 'run_once'] as const;
export const SCHEDULE_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const WORKFLOW_TRIGGERS = ['manual', 'schedule', 'event'] as const;
export const WORKFLOW_RUN_TRIGGERS = ['manual', 'schedule', 'event', 'api'] as const;
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const WORKFLOW_RUN_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const NODE_TYPES = [
  'agent_run',
  'approval',
  'condition',
  'delay',
  'webhook',
  'task',
  'notify',
  'room_post',
] as const;
export const NODE_RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;

/** Where a prompt schedule's answer goes besides its session. */
export type ScheduleDelivery = {
  roomId?: string;
  notify?: boolean;
  webhookId?: string;
  /** A messaging platform the agent itself posts to (Hermes's `deliver`), and where on it. */
  channel?: string;
  address?: string | null;
};

/**
 * A node of a workflow, exactly as the contract's `WorkflowNode` describes it. The column
 * is JSON, so the shape is this type and nothing has to migrate when the contract adds a
 * field — which is why the definition was stored as a document in the first place.
 */
export type WorkflowNode = {
  id: string;
  /** The contract's five kinds; the table's `node_runs.node_type` carries the longer list. */
  kind: 'agent' | 'approval' | 'condition' | 'delay' | 'notify';
  title: string;
  agentId?: string | null;
  model?: string | null;
  provider?: string | null;
  reasoningEffort?: string | null;
  skills?: string[];
  /** Prompt template; `{{input}}` and `{{steps.<id>.output}}` are substituted at run time. */
  input?: string | null;
  approvalRequired?: boolean;
  position?: { x: number; y: number };
};

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  route: 'always' | 'success' | 'failure';
};

export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Where the workflow's agents work, when it is tied to a checkout. */
  workingDir?: string | null;
};

export const schedules = sqliteTable(
  'schedules',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    kind: text('kind', { enum: SCHEDULE_KINDS }).notNull().default('cron'),
    /** kind=cron: 5-field expression evaluated in `timezone`. */
    cronExpr: text('cron_expr', { length: 120 }),
    timezone: text('timezone', { length: 64 }).notNull().default('UTC'),
    /** kind=interval */
    intervalSeconds: integer('interval_seconds'),
    /** kind=once */
    runAt: timestampMs('run_at'),
    enabled: bool('enabled').notNull().default(true),
    targetKind: text('target_kind', { enum: SCHEDULE_TARGETS }).notNull().default('prompt'),
    agentId: ulid('agent_id'),
    workflowId: ulid('workflow_id').references((): AnySQLiteColumn => workflows.id, {
      onDelete: 'set null',
    }),
    prompt: text('prompt'),
    modelId: ulid('model_id'),
    skills: json<string[]>('skills').notNull().default(EMPTY_ARRAY),
    delivery: json<ScheduleDelivery>('delivery').notNull().default(EMPTY_OBJECT),
    /** Stop after this many successful runs; null = unlimited. */
    repeatLimit: integer('repeat_limit'),
    repeatCount: integer('repeat_count').notNull().default(0),
    overlapPolicy: text('overlap_policy', { enum: OVERLAP_POLICIES }).notNull().default('skip'),
    misfirePolicy: text('misfire_policy', { enum: MISFIRE_POLICIES }).notNull().default('skip'),
    nextRunAt: timestampMs('next_run_at'),
    lastRunAt: timestampMs('last_run_at'),
    lastStatus: text('last_status', { enum: SCHEDULE_RUN_STATUSES }),
    lastError: text('last_error'),
    lastDeliveryError: text('last_delivery_error'),
    archivedAt: timestampMs('archived_at'),
    /**
     * Set when the schedule lives in an agent's own scheduler (today: Hermes's cron). That
     * scheduler fires it and is the source of truth; this row is its reflection.
     */
    externalSource: text('external_source', { enum: ['hermes'] }),
    externalId: text('external_id', { length: 64 }),
    /** The state that scheduler reports (`scheduled`, `running`, `paused`, `completed`, `error`). */
    externalState: text('external_state', { length: 16 }),
    externalSyncedAt: timestampMs('external_synced_at'),
  },
  (t) => [
    index('schedules_due_idx').on(t.enabled, t.nextRunAt),
    uniqueIndex('schedules_external_uq').on(t.workspace, t.externalSource, t.externalId),
    index('schedules_workspace_idx').on(t.workspace, t.archivedAt),
    check('schedules_kind_check', inList(t.kind, SCHEDULE_KINDS)),
    check('schedules_target_kind_check', inList(t.targetKind, SCHEDULE_TARGETS)),
    check('schedules_overlap_policy_check', inList(t.overlapPolicy, OVERLAP_POLICIES)),
    check('schedules_misfire_policy_check', inList(t.misfirePolicy, MISFIRE_POLICIES)),
  ],
);

export const workflows = sqliteTable(
  'workflows',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    /** Bumped on every definition change; runs snapshot the definition they used. */
    version: integer('version').notNull().default(1),
    definition: json<WorkflowDefinition>('definition').notNull(),
    triggerKind: text('trigger_kind', { enum: WORKFLOW_TRIGGERS }).notNull().default('manual'),
    /** trigger_kind=event: a realtime event name such as `task.moved`. */
    eventKey: text('event_key', { length: 64 }),
    enabled: bool('enabled').notNull().default(true),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    index('workflows_workspace_idx').on(t.workspace, t.archivedAt),
    index('workflows_event_idx').on(t.enabled, t.triggerKind, t.eventKey),
    check('workflows_trigger_kind_check', inList(t.triggerKind, WORKFLOW_TRIGGERS)),
  ],
);

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    ...scopedColumns(),
    workflowId: ulid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    scheduleId: ulid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    triggerKind: text('trigger_kind', { enum: WORKFLOW_RUN_TRIGGERS }).notNull(),
    /** Id of the triggering entity (schedule_run, task, ...) when there is one. */
    triggerRef: ulid('trigger_ref'),
    status: text('status', { enum: WORKFLOW_RUN_STATUSES }).notNull().default('queued'),
    workflowVersion: integer('workflow_version').notNull(),
    definitionSnapshot: json<WorkflowDefinition>('definition_snapshot').notNull(),
    input: json<Record<string, unknown>>('input').notNull().default(EMPTY_OBJECT),
    output: json<Record<string, unknown>>('output'),
    /** Node keys currently running or waiting; drives the live diagram. */
    activeNodeKeys: json<string[]>('active_node_keys').notNull().default(EMPTY_ARRAY),
    error: text('error'),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
  },
  (t) => [
    index('workflow_runs_workflow_idx').on(t.workflowId, t.createdAt),
    index('workflow_runs_workspace_status_idx').on(t.workspace, t.status),
    check('workflow_runs_trigger_kind_check', inList(t.triggerKind, WORKFLOW_RUN_TRIGGERS)),
    check('workflow_runs_status_check', inList(t.status, WORKFLOW_RUN_STATUSES)),
  ],
);

export const nodeRuns = sqliteTable(
  'node_runs',
  {
    ...scopedColumns(),
    workflowRunId: ulid('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key', { length: 64 }).notNull(),
    nodeType: text('node_type', { enum: NODE_TYPES }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status', { enum: NODE_RUN_STATUSES }).notNull().default('pending'),
    input: json<Record<string, unknown>>('input').notNull().default(EMPTY_OBJECT),
    output: json<Record<string, unknown>>('output'),
    error: text('error'),
    /** agent_run nodes: the sessions.run created for this node. */
    runId: ulid('run_id'),
    /** approval nodes: the sessions.approval created for this node. */
    approvalId: ulid('approval_id'),
    /** task nodes: the tasks.task created or moved. */
    taskId: ulid('task_id'),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
  },
  (t) => [
    uniqueIndex('node_runs_run_node_attempt_uq').on(t.workflowRunId, t.nodeKey, t.attempt),
    check('node_runs_node_type_check', inList(t.nodeType, NODE_TYPES)),
    check('node_runs_status_check', inList(t.status, NODE_RUN_STATUSES)),
  ],
);

export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    ...scopedColumns(),
    scheduleId: ulid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    /** The tick this run belongs to; unique per schedule so a restart cannot double-fire. */
    scheduledFor: timestampMs('scheduled_for').notNull(),
    status: text('status', { enum: SCHEDULE_RUN_STATUSES }).notNull().default('queued'),
    /** target=prompt: the sessions.run. */
    runId: ulid('run_id'),
    /** target=workflow: the workflow_run. */
    workflowRunId: ulid('workflow_run_id').references(() => workflowRuns.id, {
      onDelete: 'set null',
    }),
    /** First lines of the answer, for the history list. */
    outputPreview: text('output_preview', { length: 500 }),
    error: text('error'),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
  },
  (t) => [
    uniqueIndex('schedule_runs_schedule_tick_uq').on(t.scheduleId, t.scheduledFor),
    index('schedule_runs_schedule_recent_idx').on(t.scheduleId, t.createdAt),
    check('schedule_runs_status_check', inList(t.status, SCHEDULE_RUN_STATUSES)),
  ],
);
