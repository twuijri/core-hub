/**
 * sessions — chat sessions, their messages, streamed runs, tool calls and
 * approvals. The transcript the hub *received*; the agent's private files
 * stay in the agent's home (ARCHITECTURE §Data ownership).
 *
 * All tables are workspace-scoped. Intra-module foreign keys cascade from
 * sessions -> messages/runs -> tool_calls/approvals.
 *
 * Cross-module id columns: sessions.agent_id / runs.agent_id -> agents.agents,
 * sessions.model_id -> models.models, sessions.worktree_id -> board.worktrees,
 * messages.attachment_ids / tool_calls.output_attachment_id -> knowledge.attachments,
 * approvals.responded_by_user_id -> auth.users. Origin pairs (`origin_kind`,
 * `origin_id`) point at board.tasks, schedules.schedule_runs,
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
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'event'] as const;
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
  | { type: 'tool_call'; toolCallId: string }
  | { type: 'approval'; approvalId: string };

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
    title: text('title', { length: 200 }).notNull().default(''),
    originKind: text('origin_kind', { enum: SESSION_ORIGINS }).notNull().default('user'),
    originId: ulid('origin_id'),
    modelId: ulid('model_id'),
    /** "provider/model" label frozen at creation; survives model deletion. */
    modelLabel: text('model_label', { length: 200 }),
    /** The agent's own session identifier (ACP session id, Hermes session key). */
    agentSessionRef: text('agent_session_ref', { length: 200 }),
    workingDir: text('working_dir'),
    worktreeId: ulid('worktree_id'),
    lastRunId: ulid('last_run_id'),
    lastMessageAt: timestampMs('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    pinned: bool('pinned').notNull().default(false),
    metadata: json<SessionMetadata>('metadata').notNull().default(EMPTY_OBJECT),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    index('sessions_workspace_recent_idx').on(t.workspace, t.archivedAt, t.lastMessageAt),
    index('sessions_workspace_agent_idx').on(t.workspace, t.agentId),
    index('sessions_origin_idx').on(t.originKind, t.originId),
    check('sessions_origin_kind_check', inList(t.originKind, SESSION_ORIGINS)),
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
    /** Retry counter for the same trigger (1 = first attempt). */
    attempt: integer('attempt').notNull().default(1),
    originKind: text('origin_kind', { enum: SESSION_ORIGINS }).notNull().default('user'),
    originId: ulid('origin_id'),
    modelLabel: text('model_label', { length: 200 }),
    adapterKind: text('adapter_kind', { length: 16 }).notNull(),
    /** The agent's own turn/run id, if it has one. */
    agentRunRef: text('agent_run_ref', { length: 200 }),
    startedAt: timestampMs('started_at'),
    finishedAt: timestampMs('finished_at'),
    interruptRequestedAt: timestampMs('interrupt_requested_at'),
    cancelReason: text('cancel_reason', { length: 200 }),
    errorCode: text('error_code', { length: 64 }),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('runs_session_idx').on(t.sessionId, t.createdAt),
    index('runs_workspace_status_idx').on(t.workspace, t.status),
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
    outputAttachmentId: ulid('output_attachment_id'),
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

export const approvals = sqliteTable(
  'approvals',
  {
    ...scopedColumns(),
    runId: ulid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
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
    check('approvals_kind_check', inList(t.kind, APPROVAL_KINDS)),
    check('approvals_status_check', inList(t.status, APPROVAL_STATUSES)),
  ],
);
