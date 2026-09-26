/**
 * sessions — chat sessions, their messages, streamed runs, tool calls and
 * approvals. The transcript the hub *received*; the agent's private files
 * stay in the agent's home (ARCHITECTURE §Data ownership).
 *
 * All tables are workspace-scoped. Intra-module foreign keys cascade from
 * sessions -> messages/runs -> tool_calls/approvals.
 *
 * Cross-module id columns: sessions.agent_id / runs.agent_id -> agents.agents,
 * sessions.model_id -> models.models, sessions.worktree_id -> tasks.worktrees,
 * messages.attachment_ids / tool_calls.output_attachment_id -> knowledge.attachments,
 * approvals.responded_by_user_id -> auth.users. Origin pairs (`origin_kind`,
 * `origin_id`) point at tasks.tasks, schedules.schedule_runs,
 * schedules.node_runs or rooms.seats.
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

export const SESSION_ORIGINS = ['user', 'task', 'schedule', 'workflow', 'room', 'api'] as const;
/**
 * `Session.source` in the contract: where the session came from, as the clients group it.
 * Wider than `origin_kind`, which says which *entity* owns the session.
 */
export const SESSION_SOURCES = [
  'chat',
  'global_agent',
  'room',
  'task',
  'schedule',
  'workflow',
  'channel',
  'cli',
  'api',
] as const;
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'max'] as const;
/**
 * `command` is a user message whose text starts with `/` (contract `MessageRole`).
 * `tool` and `event` are hub-internal roles rendered as `system` on the wire; tool output
 * itself lives on `tool_calls`, never in a message of its own.
 */
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'command', 'tool', 'event'] as const;
export const AUTHOR_KINDS = ['user', 'agent', 'system'] as const;
export const RUN_STATUSES = [
  'queued',
  'starting',
  'streaming',
  'waiting_approval',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const RUN_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export const TOOL_CALL_KINDS = [
  'shell',
  'file_read',
  'file_write',
  'search',
  'web',
  'mcp',
  'device',
  'custom',
] as const;
export const TOOL_CALL_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
] as const;
export const APPROVAL_KINDS = [
  'tool_call',
  'plan',
  'memory_write',
  'skill_write',
  'question',
  /** A workflow's `approval` step (or a step with `approval_required`): no session, no run. */
  'workflow_step',
] as const;
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'answered',
  'expired',
  'cancelled',
] as const;

/** One rendered part of a message. `text` is the whole message when parts are absent. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string; alt?: string }
  | { type: 'file'; attachmentId: string }
  | { type: 'audio'; attachmentId: string; durationMs?: number | null; transcript?: string | null }
  | { type: 'location'; latitude: number; longitude: number; accuracyM?: number | null }
  | { type: 'tool_call'; toolCallId: string }
  | { type: 'approval'; approvalId: string };

/**
 * `runs.timing`: epoch milliseconds and offsets into the run's text and reasoning — and, since
 * contract decision §54, the models the run moved past (`fallback`), which is what the hub saw
 * of the run the same way its turns are.
 */
export interface RunTiming {
  /** The models of the fallback chain that failed the run, in order (`Run.fallback`). */
  fallback?: {
    failed: Array<{
      model: string;
      provider: string | null;
      code: string | null;
      error: string | null;
    }>;
  } | null;
  turns: Array<{
    startedAt: number;
    endedAt: number | null;
    /** Tool calls started before the turn opened (absent in nothing written so far). */
    toolsBefore?: number;
    firstTokenAt: number | null;
    textStart: number;
    textEnd: number | null;
    reasoningStart: number;
    reasoningEnd: number | null;
    reasoningStartedAt: number | null;
    reasoningEndedAt: number | null;
  }>;
}

/**
 * `runs.changes`: what the run changed in its working folder, summed, written when it ends
 * (contract decision §49). `null` for a run that recorded nothing — no working folder, or it
 * ran before changes were recorded. The files themselves are `run_file_changes` rows.
 */
export interface RunChangesSummary {
  source: 'git' | 'snapshot';
  /** The run's start covered the whole folder. */
  complete: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** More files changed than are kept as rows. */
  truncated: boolean;
  /** Epoch milliseconds. */
  recordedAt: number;
}

export const RUN_FILE_CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const;
export const RUN_FILE_DIFF_STATES = ['available', 'binary', 'too_large', 'unavailable'] as const;

export type SessionMetadata = {
  /** Skills the user picked for this session (Hermes). */
  skills?: string[];
  /** Free-form adapter data that is not private agent state. */
  [key: string]: unknown;
};

export const sessions = sqliteTable(
  'sessions',
  {
    ...scopedColumns(),
    agentId: ulid('agent_id').notNull(),
    title: text('title', { length: 200 }),
    /**
     * The person named this session themselves (`SessionPatch.title` with text), so the
     * hub never renames it (contract decision §26). `title: null` clears the mark and
     * hands the naming back. Not on the wire: no client renders it, and the one question
     * a client asks — "may I ask for a new title?" — is answered by sending `null`.
     */
    titleSetByUser: bool('title_set_by_user').notNull().default(false),
    /** Contract `Session.source`; drives the grouping on the history screen. */
    source: text('source', { enum: SESSION_SOURCES }).notNull().default('chat'),
    /** Messaging platform slug when `source = channel` (telegram, whatsapp, …). */
    channel: text('channel', { length: 60 }),
    originKind: text('origin_kind', { enum: SESSION_ORIGINS }).notNull().default('user'),
    originId: ulid('origin_id'),
    modelId: ulid('model_id'),
    /** "provider/model" label frozen at creation; survives model deletion. */
    modelLabel: text('model_label', { length: 200 }),
    /** Provider slug frozen next to `model_label` so a deleted provider still renders. */
    provider: text('provider', { length: 120 }),
    /** Per-session override of the profile default; null means "use the default". */
    reasoningEffort: text('reasoning_effort', { enum: REASONING_EFFORTS }),
    /** The agent's own session identifier (ACP session id, Hermes session key). */
    agentSessionRef: text('agent_session_ref', { length: 200 }),
    workingDir: text('working_dir'),
    worktreeId: ulid('worktree_id'),
    lastRunId: ulid('last_run_id'),
    lastMessageAt: timestampMs('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    /** First 300 characters of the newest message; the list shows it under the title. */
    preview: text('preview', { length: 300 }),
    pinned: bool('pinned').notNull().default(false),
    /** The session this one was forked from (`sessions.fork`). No FK: the parent may be purged. */
    parentSessionId: ulid('parent_session_id'),
    /** `session_categories` is a later phase; the column exists because the contract has it. */
    categoryId: ulid('category_id'),
    /** Push a notice to the user's devices when a run in this session finishes. */
    notify: bool('notify').notNull().default(true),
    metadata: json<SessionMetadata>('metadata').notNull().default(EMPTY_OBJECT),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    index('sessions_workspace_recent_idx').on(t.workspace, t.archivedAt, t.lastMessageAt),
    index('sessions_workspace_agent_idx').on(t.workspace, t.agentId),
    index('sessions_origin_idx').on(t.originKind, t.originId),
    index('sessions_workspace_source_idx').on(t.workspace, t.source),
    check('sessions_origin_kind_check', inList(t.originKind, SESSION_ORIGINS)),
    check('sessions_source_check', inList(t.source, SESSION_SOURCES)),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    ...scopedColumns(),
    sessionId: ulid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The run that produced this message (assistant/tool/event) or that it triggered (user). */
    runId: ulid('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    /** 1-based position inside the session; the client orders by this, not by time. */
    seq: integer('seq').notNull(),
    role: text('role', { enum: MESSAGE_ROLES }).notNull(),
    authorKind: text('author_kind', { enum: AUTHOR_KINDS }).notNull(),
    /** users.id or agents.id depending on `author_kind`. */
    authorId: ulid('author_id'),
    /** Markdown. Always present, even when `parts` carries the structure. */
    content: text('content').notNull().default(''),
    parts: json<MessagePart[]>('parts').notNull().default(EMPTY_ARRAY),
    /** Agent reasoning shown when the user enables it; may be empty. */
    reasoning: text('reasoning'),
    attachmentIds: json<string[]>('attachment_ids').notNull().default(EMPTY_ARRAY),
    /** The agent's own message id, for de-duplication on reconnect. */
    agentMessageRef: text('agent_message_ref', { length: 200 }),
    editedAt: timestampMs('edited_at'),
  },
  (t) => [
    uniqueIndex('messages_session_seq_uq').on(t.sessionId, t.seq),
    index('messages_run_idx').on(t.runId),
    check('messages_role_check', inList(t.role, MESSAGE_ROLES)),
    check('messages_author_kind_check', inList(t.authorKind, AUTHOR_KINDS)),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    ...scopedColumns(),
    sessionId: ulid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id').notNull(),
    /** The user message (or injected prompt) this turn answers. */
    triggerMessageId: ulid('trigger_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
    }),
    /** The assistant message the run finished with, once it has. */
    finalMessageId: ulid('final_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    /** The `audit.jobs` row this run is executed as (invariant 4; contract `Run.job_id`). */
    jobId: ulid('job_id').notNull(),
    /** Retry counter for the same trigger (1 = first attempt). */
    attempt: integer('attempt').notNull().default(1),
    originKind: text('origin_kind', { enum: SESSION_ORIGINS }).notNull().default('user'),
    originId: ulid('origin_id'),
    modelLabel: text('model_label', { length: 200 }),
    provider: text('provider', { length: 120 }),
    reasoningEffort: text('reasoning_effort', { enum: REASONING_EFFORTS }),
    adapterKind: text('adapter_kind', { length: 16 }).notNull(),
    /** The agent's own turn/run id, if it has one. */
    agentRunRef: text('agent_run_ref', { length: 200 }),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
    interruptRequestedAt: timestampMs('interrupt_requested_at'),
    cancelReason: text('cancel_reason', { length: 200 }),
    errorCode: text('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    /**
     * The model's turns as the hub saw them (`run-reducer.ts` `ModelTurnState`), written when
     * the run ends. `null` for runs from before it was recorded: their trajectory has no
     * times for its turns (contract decision §43).
     */
    timing: json<RunTiming>('timing'),
    /** What the run changed in its working folder, summed (decision §49); `null` if unrecorded. */
    changes: json<RunChangesSummary>('changes'),
  },
  (t) => [
    index('runs_session_idx').on(t.sessionId, t.createdAt),
    index('runs_workspace_status_idx').on(t.workspace, t.status),
    /** The Usage report counts runs and conversations per day of a period (decision §50). */
    index('runs_workspace_time_idx').on(t.workspace, t.createdAt),
    index('runs_origin_idx').on(t.originKind, t.originId),
    check('runs_status_check', inList(t.status, RUN_STATUSES)),
    check('runs_origin_kind_check', inList(t.originKind, SESSION_ORIGINS)),
  ],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    ...scopedColumns(),
    runId: ulid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** The message the call is rendered inside (set when the adapter reports it). */
    messageId: ulid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    agentToolCallRef: text('agent_tool_call_ref', { length: 200 }),
    name: text('name', { length: 120 }).notNull(),
    kind: text('kind', { enum: TOOL_CALL_KINDS }).notNull().default('custom'),
    /** Short human line ("Edit src/app.ts"). */
    title: text('title', { length: 200 }),
    /** Redacted per the agent's approval policy before storage. */
    input: json<Record<string, unknown>>('input').notNull().default(EMPTY_OBJECT),
    /** Truncated to the configured limit; the full output is an attachment. */
    output: text('output'),
    /** Contract `ToolCall.output_truncated`: `output` is a prefix of what the agent sent. */
    outputTruncated: bool('output_truncated').notNull().default(false),
    outputAttachmentId: ulid('output_attachment_id'),
    /** Set when a delegated subagent made the call (contract `ToolCall.subagent_id`). */
    subagentId: text('subagent_id', { length: 120 }),
    status: text('status', { enum: TOOL_CALL_STATUSES }).notNull().default('pending'),
    approvalId: ulid('approval_id').references((): AnySQLiteColumn => approvals.id, {
      onDelete: 'set null',
    }),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
    durationMs: integer('duration_ms'),
    exitCode: integer('exit_code'),
  },
  (t) => [
    uniqueIndex('tool_calls_run_seq_uq').on(t.runId, t.seq),
    index('tool_calls_message_idx').on(t.messageId),
    check('tool_calls_kind_check', inList(t.kind, TOOL_CALL_KINDS)),
    check('tool_calls_status_check', inList(t.status, TOOL_CALL_STATUSES)),
  ],
);

/**
 * One file a run changed in its working folder, with the diff recorded when the run ended
 * (contract decision §49): the answer stays what the run did, whatever the file became later.
 * At most `CHANGES_MAX_FILES` per run (`run-changes.ts`), the first by path.
 */
export const runFileChanges = sqliteTable(
  'run_file_changes',
  {
    ...scopedColumns(),
    runId: ulid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Order inside the run: by path. */
    seq: integer('seq').notNull(),
    /** Relative to the working folder, `/`-separated; where a deleted file was. */
    path: text('path').notNull(),
    /** Where a renamed file was. */
    oldPath: text('old_path'),
    change: text('change', { enum: RUN_FILE_CHANGE_KINDS }).notNull(),
    additions: integer('additions'),
    deletions: integer('deletions'),
    binary: bool('binary').notNull().default(false),
    diffState: text('diff_state', { enum: RUN_FILE_DIFF_STATES }).notNull(),
    /** The unified diff's hunks, capped; `null` unless `diff_state` is `available`. */
    diff: text('diff'),
    diffTruncated: bool('diff_truncated').notNull().default(false),
  },
  (t) => [
    uniqueIndex('run_file_changes_run_seq_uq').on(t.runId, t.seq),
    check('run_file_changes_change_check', inList(t.change, RUN_FILE_CHANGE_KINDS)),
    check('run_file_changes_diff_state_check', inList(t.diffState, RUN_FILE_DIFF_STATES)),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    ...scopedColumns(),
    /** The session run that asked; `null` for a workflow step's gate, which has none. */
    runId: ulid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    /**
     * A workflow step's gate: the workflow run it pauses and the node it stands on
     * (cross-module ids -> schedules.workflow_runs / its definition's node key).
     */
    workflowRunId: ulid('workflow_run_id'),
    nodeId: text('node_id', { length: 64 }),
    toolCallId: ulid('tool_call_id').references((): AnySQLiteColumn => toolCalls.id, {
      onDelete: 'set null',
    }),
    kind: text('kind', { enum: APPROVAL_KINDS }).notNull(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    title: text('title', { length: 200 }).notNull(),
    description: text('description'),
    /** kind=question: `{ options?: string[] }`; kind=tool_call: the redacted input. */
    payload: json<Record<string, unknown>>('payload').notNull().default(EMPTY_OBJECT),
    /** `{ answer?: string, note?: string }` */
    response: json<Record<string, unknown>>('response'),
    respondedByUserId: ulid('responded_by_user_id'),
    /** True when the user chose "always allow" — the run applies it for the rest of the session. */
    remember: bool('remember').notNull().default(false),
    requestedAt: timestampMs('requested_at').notNull(),
    respondedAt: timestampMs('responded_at'),
    expiresAt: timestampMs('expires_at'),
  },
  (t) => [
    index('approvals_workspace_pending_idx').on(t.workspace, t.status, t.requestedAt),
    index('approvals_run_idx').on(t.runId),
    index('approvals_workflow_run_idx').on(t.workflowRunId),
    check('approvals_kind_check', inList(t.kind, APPROVAL_KINDS)),
    check('approvals_status_check', inList(t.status, APPROVAL_STATUSES)),
  ],
);

/**
 * A folder of the profile's chats list (contract decision §60): the profile's, shared by
 * everyone who may enter it, like its sessions. `sessions.category_id` points here; no FK, so
 * deleting a category clears its sessions in the service, which announces each one.
 */
export const sessionCategories = sqliteTable(
  'session_categories',
  {
    ...scopedColumns(),
    name: text('name', { length: 60 }).notNull(),
    /** `name` trimmed and lower-cased: what "the same name" means within a profile. */
    nameKey: text('name_key', { length: 60 }).notNull(),
    /** `#rrggbb`, or null for the list's own colour. */
    color: text('color', { length: 7 }),
    /** Display order within the profile, always `0…n-1`. */
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('session_categories_workspace_name_uq').on(t.workspace, t.nameKey),
    index('session_categories_workspace_position_idx').on(t.workspace, t.position),
  ],
);

/**
 * A channel conversation (Telegram, WhatsApp… read from Hermes, §61) one person hid from their
 * own list (contract decision §88). The conversation is Hermes's; only this mark is the hub's —
 * per person (`owner_id`) and per profile (`workspace`), keyed by Hermes's session id. Deleting
 * the conversation from Hermes removes every mark on it.
 */
export const channelConversationHides = sqliteTable(
  'channel_conversation_hides',
  {
    ...scopedColumns(),
    conversationId: text('conversation_id', { length: 128 }).notNull(),
  },
  (t) => [
    uniqueIndex('channel_conversation_hides_uq').on(t.workspace, t.ownerId, t.conversationId),
  ],
);
