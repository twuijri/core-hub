/**
 * tasks — projects, tasks (a kanban-style section), their transitions and
 * dependencies, and the git worktree each task runs in.
 *
 * All tables are workspace-scoped. Intra-module foreign keys cascade from
 * projects -> tasks/worktrees -> task_transitions/task_dependencies.
 *
 * Cross-module id columns: projects.default_agent_id / tasks.assignee_agent_id
 * -> agents.agents, tasks.assignee_user_id -> auth.users, tasks.session_id
 * -> sessions.sessions, tasks.current_run_id / task_transitions.run_id
 * -> sessions.runs, tasks.room_id -> rooms.rooms, worktrees.create_job_id
 * -> audit.jobs.
 */
import { sql } from 'drizzle-orm';
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

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
/**
 * The nine columns of the Tasks section, in workflow order (contract `TaskStatus`).
 * `triage` is intake and `running` belongs to the worker: a person moves a task *to*
 * `ready`, and the hub moves it to `running` when a run starts.
 */
export const TASK_STATUSES = [
  'triage',
  'todo',
  'ready',
  'scheduled',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
] as const;
export const TASK_TERMINAL_STATUSES = ['done', 'archived'] as const;
export const SUBTASK_STATUSES = [
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
  'skipped',
] as const;
export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export const ASSIGNEE_KINDS = ['none', 'user', 'agent'] as const;
export const TRANSITION_FIELDS = ['status', 'assignee', 'priority', 'project'] as const;
export const TRANSITION_ACTORS = ['user', 'agent', 'system', 'schedule', 'workflow'] as const;
export const WORKTREE_STATUSES = [
  'creating',
  'ready',
  'dirty',
  'merged',
  'removed',
  'failed',
] as const;

export type ProjectSettings = {
  /** Directory under which worktrees are created; defaults to `<data>/worktrees/<project>`. */
  worktreeBaseDir?: string;
  /** Branch name template, e.g. "task/{key}-{number}-{slug}". */
  branchTemplate?: string;
  /** Run a fresh session per attempt instead of resuming the task session. */
  freshSessionPerAttempt?: boolean;
  /** Commands the agent is expected to run before `review`. */
  checks?: string[];
};

/**
 * One line of a task's definition of done or its constraints (contract `TaskCheckItem`,
 * decision §103). `checked` is the reviewer's tick; a new run clears it.
 */
export type TaskCheckItem = { text: string; checked: boolean };

export type WorktreeStats = {
  ahead?: number;
  behind?: number;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
};

export const projects = sqliteTable(
  'projects',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    /** Short upper-case key for task numbers: "HUB-12". */
    key: text('key', { length: 10 }).notNull(),
    description: text('description'),
    color: text('color', { length: 16 }),
    repoUrl: text('repo_url'),
    /** Checkout on the hub host that worktrees are created from. */
    localPath: text('local_path'),
    defaultBranch: text('default_branch', { length: 120 }).notNull().default('main'),
    defaultAgentId: ulid('default_agent_id'),
    /** Room where assigned agents post progress (rooms module). */
    reportRoomId: ulid('report_room_id'),
    /** Assign `ready` tasks automatically — the `/task-dispatches` switch. */
    autoDispatch: bool('auto_dispatch').notNull().default(false),
    status: text('status', { enum: PROJECT_STATUSES }).notNull().default('active'),
    settings: json<ProjectSettings>('settings').notNull().default(EMPTY_OBJECT),
    /** Last task number handed out; incremented in the same transaction as the insert. */
    taskCounter: integer('task_counter').notNull().default(0),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    uniqueIndex('projects_workspace_key_uq').on(t.workspace, t.key),
    index('projects_workspace_idx').on(t.workspace, t.archivedAt),
    check('projects_status_check', inList(t.status, PROJECT_STATUSES)),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    ...scopedColumns(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title', { length: 300 }).notNull(),
    /** Markdown brief the agent receives verbatim. */
    description: text('description'),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('triage'),
    priority: text('priority', { enum: TASK_PRIORITIES }).notNull().default('normal'),
    assigneeKind: text('assignee_kind', { enum: ASSIGNEE_KINDS }).notNull().default('none'),
    assigneeUserId: ulid('assignee_user_id'),
    assigneeAgentId: ulid('assignee_agent_id'),
    parentId: ulid('parent_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null',
    }),
    /**
     * Fractional-ordering key for the column; the client never computes one.
     *
     * The column is still `sort_key` and the tag column is still `labels`: the contract
     * settled on `position` and `tags` after these tables were written, and renaming a
     * column in SQLite is a table rebuild for a pair of names nobody sees. The property
     * reads as the contract does; the column keeps the name the migration gave it.
     */
    position: text('sort_key', { length: 64 }).notNull().default('n'),
    tags: json<string[]>('labels').notNull().default(EMPTY_ARRAY),
    /** Start a run as soon as the task is `ready` and assigned. */
    autoStart: bool('auto_start').notNull().default(false),
    /** Why the task is where it is, for any status; `blockedReason` is the `blocked` one. */
    statusReason: text('status_reason'),
    /** The assignee's last progress summary. */
    latestSummary: text('latest_summary'),
    attachmentIds: json<string[]>('attachment_ids').notNull().default(EMPTY_ARRAY),
    /** What must be true for the task to be done; sent with every run, ticked at review (§103). */
    definitionOfDone: json<TaskCheckItem[]>('definition_of_done').notNull().default(EMPTY_ARRAY),
    /** What the agent must keep to while doing it; sent and ticked like the above (§103). */
    constraints: json<TaskCheckItem[]>('constraints').notNull().default(EMPTY_ARRAY),
    dueAt: timestampMs('due_at'),
    startedAt: timestampMs('started_at'),
    completedAt: timestampMs('completed_at'),
    blockedReason: text('blocked_reason'),
    /** The session the agent works in for this task (sessions module). */
    sessionId: ulid('session_id'),
    /** The run in flight, if any (sessions module). */
    currentRunId: ulid('current_run_id'),
    /** Room where progress is reported (rooms module). */
    roomId: ulid('room_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    archivedAt: timestampMs('archived_at'),
    /**
     * The stuck-task watchdog's marker (DECISIONS §93): while the task is `running`, the
     * moment its run last showed activity, once that was longer ago than the hub allows.
     * Cleared by activity or by any move out of `running`.
     */
    stuckAt: timestampMs('stuck_at'),
    /**
     * Where this card really lives, when it is not only here.
     *
     * `hermes` means it is a card on Hermes's own kanban and this row is its reflection
     * (owner decision, 2026-09-23): Hermes is the one doing the work, so on every read its
     * title, status and result overwrite ours, and every move goes through `hermes
     * kanban`. `null` is a card the hub alone keeps.
     */
    externalSource: text('external_source', { enum: ['hermes'] }),
    /** Hermes's own id (`t_` + 8 hex). Not a ULID, which is why it is not our `id`. */
    externalId: text('external_id', { length: 64 }),
    /** When the reflection last matched Hermes. */
    externalSyncedAt: timestampMs('external_synced_at'),
  },
  (t) => [
    uniqueIndex('tasks_project_number_uq').on(t.projectId, t.number),
    // One reflection per Hermes card per workspace: a second sync must update, not copy.
    uniqueIndex('tasks_external_uq').on(t.workspace, t.externalSource, t.externalId),
    index('tasks_workspace_status_idx').on(t.workspace, t.archivedAt, t.status, t.position),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_assignee_agent_idx').on(t.assigneeAgentId, t.status),
    index('tasks_parent_idx').on(t.parentId),
    check('tasks_status_check', inList(t.status, TASK_STATUSES)),
    check('tasks_priority_check', inList(t.priority, TASK_PRIORITIES)),
    check('tasks_assignee_kind_check', inList(t.assigneeKind, ASSIGNEE_KINDS)),
  ],
);

/**
 * A checklist inside a task. Separate from `tasks` on purpose: a subtask is a line in a
 * list, not a task of its own — it has no assignee, no worktree and no run.
 */
export const subtasks = sqliteTable(
  'subtasks',
  {
    ...scopedColumns(),
    taskId: ulid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Position in the checklist, from 0; the hub renumbers, the client never sends gaps. */
    index: integer('index').notNull().default(0),
    title: text('title', { length: 300 }).notNull(),
    status: text('status', { enum: SUBTASK_STATUSES }).notNull().default('todo'),
    note: text('note'),
    blockedReason: text('blocked_reason'),
    completedAt: timestampMs('completed_at'),
  },
  (t) => [
    index('subtasks_task_idx').on(t.taskId, t.index),
    check('subtasks_status_check', inList(t.status, SUBTASK_STATUSES)),
  ],
);

/** What people (and agents) said on a task. */
export const taskComments = sqliteTable(
  'task_comments',
  {
    ...scopedColumns(),
    taskId: ulid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorKind: text('author_kind', { enum: TRANSITION_ACTORS }).notNull().default('user'),
    authorId: ulid('author_id'),
    authorName: text('author_name', { length: 120 }),
    body: text('body').notNull(),
  },
  (t) => [
    index('task_comments_task_idx').on(t.taskId, t.createdAt),
    check('task_comments_author_kind_check', inList(t.authorKind, TRANSITION_ACTORS)),
  ],
);

export const taskTransitions = sqliteTable(
  'task_transitions',
  {
    ...scopedColumns(),
    taskId: ulid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    field: text('field', { enum: TRANSITION_FIELDS }).notNull().default('status'),
    fromValue: text('from_value', { length: 64 }),
    toValue: text('to_value', { length: 64 }).notNull(),
    actorKind: text('actor_kind', { enum: TRANSITION_ACTORS }).notNull(),
    /** users.id, agents.id, schedules.id or workflow_runs.id by `actor_kind`. */
    actorId: ulid('actor_id'),
    runId: ulid('run_id'),
    note: text('note'),
  },
  (t) => [
    index('task_transitions_task_idx').on(t.taskId, t.createdAt),
    check('task_transitions_field_check', inList(t.field, TRANSITION_FIELDS)),
    check('task_transitions_actor_kind_check', inList(t.actorKind, TRANSITION_ACTORS)),
  ],
);

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    ...scopedColumns(),
    taskId: ulid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: ulid('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('task_dependencies_pair_uq').on(t.taskId, t.dependsOnTaskId),
    index('task_dependencies_depends_on_idx').on(t.dependsOnTaskId),
    check('task_dependencies_no_self_check', sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  ],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    ...scopedColumns(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The task this worktree serves; at most one live worktree per task (partial unique index). */
    taskId: ulid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** Absolute path on the hub host. */
    path: text('path').notNull(),
    branch: text('branch', { length: 200 }).notNull(),
    /** Commit the branch was created from. */
    baseRef: text('base_ref', { length: 64 }),
    /** Last commit the hub observed on the branch. */
    headSha: text('head_sha', { length: 64 }),
    status: text('status', { enum: WORKTREE_STATUSES }).notNull().default('creating'),
    createJobId: ulid('create_job_id'),
    prUrl: text('pr_url'),
    stats: json<WorktreeStats>('stats').notNull().default(EMPTY_OBJECT),
    lastSyncedAt: timestampMs('last_synced_at'),
    removedAt: timestampMs('removed_at'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('worktrees_live_task_uq')
      .on(t.taskId)
      .where(sql`${t.removedAt} is null and ${t.taskId} is not null`),
    uniqueIndex('worktrees_path_uq').on(t.path),
    index('worktrees_project_idx').on(t.projectId, t.status),
    check('worktrees_status_check', inList(t.status, WORKTREE_STATUSES)),
  ],
);
