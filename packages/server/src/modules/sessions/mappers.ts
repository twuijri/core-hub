/**
 * Database rows -> the wire shapes in `packages/contracts/openapi.yaml`.
 *
 * The contract is the source of truth; these functions are the only place
 * that knows how an internal row becomes a `Session`, `Message`, `Run`,
 * `ToolCall` or `Approval`. Two mappings are worth naming because the
 * internal model is deliberately richer than the wire:
 *
 * - **run status** — the state machine has nine states
 *   (docs/domain/README.md §run), the contract's `RunStatus` has six.
 *   `starting`/`streaming` are both `running`; `waiting_approval` and
 *   `waiting_input` are both `waiting`; `timed_out` is `failed` with
 *   `error.code = "timeout"`, so no information is lost, only nuance the
 *   clients do not render.
 * - **message role** — `tool` and `event` rows are hub-internal and render as
 *   `system`; tool output lives on `tool_calls`, never in a message
 *   (contract `MessageRole`).
 */
import type { UsageTotals } from '../audit/index.js';
import type { approvals, messages, runs, sessions, toolCalls } from './schema.js';

export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export type WireRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type WireSessionStatus = 'idle' | 'running' | 'waiting';

export interface Money {
  amount: string;
  currency: string;
}
export interface WireUsage {
  input_tokens: number;
  output_tokens: number;
  cost: Money | null;
}

export const iso = (value: Date | number | null | undefined): string | null =>
  value === null || value === undefined
    ? null
    : new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const isoNow = (value: Date | number): string => iso(value) as string;

export function wireRunStatus(status: RunRow['status']): WireRunStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'starting':
    case 'streaming':
      return 'running';
    case 'waiting_approval':
    case 'waiting_input':
      return 'waiting';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'timed_out':
      return 'failed';
  }
}

export function sessionStatusFrom(
  runStatus: RunRow['status'] | null | undefined,
): WireSessionStatus {
  if (!runStatus) return 'idle';
  const wire = wireRunStatus(runStatus);
  if (wire === 'running' || wire === 'queued') return 'running';
  if (wire === 'waiting') return 'waiting';
  return 'idle';
}

/** Micro-USD integers -> the contract's decimal-string `Money`. */
export function money(costMicroUsd: number): Money {
  const sign = costMicroUsd < 0 ? '-' : '';
  const abs = Math.abs(costMicroUsd);
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, '0');
  return { amount: `${sign}${whole}.${fraction}`, currency: 'USD' };
}

export function wireUsage(totals: UsageTotals | undefined): WireUsage | null {
  if (!totals) return null;
  if (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.costMicroUsd === 0 &&
    !totals.hasCost
  ) {
    return null;
  }
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cost: totals.hasCost ? money(totals.costMicroUsd) : null,
  };
}

/** `Session.origin`: the entity the session serves, as a `ResourceRef`. */
function originRef(row: SessionRow | RunRow): { kind: string; id: string } | null {
  if (!row.originId) return null;
  const kind =
    row.originKind === 'task'
      ? 'task'
      : row.originKind === 'schedule'
        ? 'schedule_run'
        : row.originKind === 'workflow'
          ? 'workflow_run'
          : row.originKind === 'room'
            ? 'seat'
            : null;
  return kind ? { kind, id: row.originId } : null;
}

export interface SessionView {
  row: SessionRow;
  lastRunStatus: RunRow['status'] | null;
  activeRunId: string | null;
  usage: UsageTotals | undefined;
  match?: { message_id: string | null; snippet: string } | null;
}

export function toSession(view: SessionView, profile: string): Record<string, unknown> {
  const { row } = view;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: isoNow(row.createdAt),
    updated_at: isoNow(row.updatedAt),
    agent_id: row.agentId,
    title: row.title ?? null,
    source: row.source,
    origin: originRef(row),
    channel: row.channel ?? null,
    model: row.modelLabel ?? null,
    provider: row.provider ?? null,
    reasoning_effort: row.reasoningEffort ?? null,
    working_dir: row.workingDir ?? null,
    pinned: row.pinned,
    archived: row.archivedAt !== null,
    category_id: row.categoryId ?? null,
    preview: row.preview ?? null,
    message_count: row.messageCount,
    usage: wireUsage(view.usage),
    context: null,
    status: sessionStatusFrom(view.lastRunStatus),
    active_run_id: view.activeRunId,
    parent_session_id: row.parentSessionId ?? null,
    notify: row.notify,
    last_message_at: iso(row.lastMessageAt),
    match: view.match ?? null,
  };
}

export interface RunView {
  row: RunRow;
  queuePosition: number | null;
  usage: UsageTotals | undefined;
  errorMessage?: string | null;
}

export function toRun(view: RunView, profile: string): Record<string, unknown> {
  const { row } = view;
  const status = wireRunStatus(row.status);
  const code = row.status === 'timed_out' ? 'timeout' : (row.errorCode ?? null);
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: isoNow(row.createdAt),
    updated_at: isoNow(row.updatedAt),
    session_id: row.sessionId,
    room_id: null,
    seat_id: row.originKind === 'room' ? (row.originId ?? null) : null,
    job_id: row.jobId,
    status,
    queue_position: status === 'queued' ? view.queuePosition : null,
    trigger: triggerOf(row),
    input_message_id: row.triggerMessageId ?? null,
    output_message_id: row.finalMessageId ?? null,
    model: row.modelLabel ?? null,
    provider: row.provider ?? null,
    reasoning_effort: row.reasoningEffort ?? null,
    interrupted: row.interruptRequestedAt !== null,
    error: code
      ? { error: view.errorMessage ?? row.errorMessage ?? code, code: wireErrorCode(code) }
      : null,
    usage: wireUsage(view.usage),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
  };
}

/**
 * `Run.error` is the standard `{ error, code }` envelope, whose `code` comes
 * from the contract's fixed `ErrorCode` list. Adapter-specific codes that are
 * not on the list are reported as `agent_error` with the text preserved.
 */
const WIRE_ERROR_CODES = new Set([
  'bad_request',
  'validation_failed',
  'profile_required',
  'unauthorized',
  'token_expired',
  'forbidden',
  'not_found',
  'profile_not_found',
  'conflict',
  'state_invalid',
  'already_running',
  'payload_too_large',
  'unsupported_media_type',
  'agent_unavailable',
  'agent_error',
  'rate_limited',
  'internal',
  'not_implemented',
  'service_unavailable',
]);

function wireErrorCode(code: string): string {
  return WIRE_ERROR_CODES.has(code) ? code : 'agent_error';
}

function triggerOf(row: RunRow): { kind: string; id: string | null } {
  switch (row.originKind) {
    case 'task':
      return { kind: 'task', id: row.originId ?? null };
    case 'schedule':
      return { kind: 'schedule', id: row.originId ?? null };
    case 'workflow':
      return { kind: 'workflow', id: row.originId ?? null };
    case 'room':
      return { kind: 'room', id: row.originId ?? null };
    case 'api':
      return { kind: 'api', id: null };
    default:
      return { kind: 'user', id: row.ownerId };
  }
}

export function toToolCall(row: ToolCallRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    status: wireToolStatus(row.status),
    preview: row.title ?? null,
    arguments: row.input ?? null,
    output: row.output ?? null,
    output_truncated: row.outputTruncated,
    duration_ms: row.durationMs ?? null,
    subagent_id: row.subagentId ?? null,
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
  };
}

function wireToolStatus(status: ToolCallRow['status']): string {
  switch (status) {
    case 'pending':
      return 'awaiting_approval';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
      return 'interrupted';
    case 'failed':
    case 'denied':
      return 'failed';
  }
}

export interface MessageAuthor {
  kind: 'user' | 'agent' | 'system';
  id: string | null;
  name: string;
  avatar: { kind: 'image' | 'generated'; url: string | null; seed: string | null } | null;
}

export interface MessageView {
  row: MessageRow;
  author: MessageAuthor;
  toolCalls: ToolCallRow[];
  /** `streaming` while the run that writes it is still live. */
  status: 'complete' | 'streaming' | 'failed' | 'interrupted';
  usage: UsageTotals | undefined;
}

export function toMessage(view: MessageView, profile: string): Record<string, unknown> {
  const { row } = view;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: isoNow(row.createdAt),
    updated_at: isoNow(row.updatedAt),
    session_id: row.sessionId,
    room_id: null,
    seq: row.seq,
    role: wireRole(row.role),
    author: view.author,
    content: contentBlocks(row),
    reasoning: row.reasoning ? { text: row.reasoning, duration_ms: null } : null,
    tool_calls: view.toolCalls.map(toToolCall),
    run_id: row.runId ?? null,
    status: view.status,
    mentions: [],
    handoff: null,
    usage: wireUsage(view.usage),
    reply_to_message_id: null,
  };
}

function wireRole(role: MessageRow['role']): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'command':
      return 'command';
    default:
      return 'system';
  }
}

/**
 * `Message.content` is an array of `ContentBlock`. The row keeps the Markdown
 * in `content` and the structure in `parts`; text always wins position 0 when
 * there are no parts, so a client never sees an empty message body.
 */
function contentBlocks(row: MessageRow): Array<Record<string, unknown>> {
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const blocks: Array<Record<string, unknown>> = [];
  let textEmitted = false;
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      textEmitted = true;
    } else if (part.type === 'image' || part.type === 'file') {
      blocks.push({
        type: part.type,
        attachment_id: part.attachmentId,
        url: attachmentUrl(part.attachmentId),
      });
    } else if (part.type === 'audio') {
      blocks.push({
        type: 'audio',
        attachment_id: part.attachmentId,
        url: attachmentUrl(part.attachmentId),
        duration_ms: part.durationMs ?? null,
        transcript: part.transcript ?? null,
      });
    } else if (part.type === 'location') {
      blocks.push({
        type: 'location',
        latitude: part.latitude,
        longitude: part.longitude,
        accuracy_m: part.accuracyM ?? null,
        captured_at: null,
      });
    }
  }
  if (!textEmitted && row.content.length > 0) {
    blocks.unshift({ type: 'text', text: row.content });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: row.content });
  return blocks;
}

/** Where the bytes come from once `knowledge` serves them (`sessions.downloadAttachment`). */
export function attachmentUrl(attachmentId: string): string {
  return `/api/v1/attachments/${attachmentId}/content`;
}

export interface ApprovalView {
  row: ApprovalRow;
  sessionId: string;
  messageId: string | null;
  agent: { id: string; name: string };
}

export function toApproval(view: ApprovalView, profile: string): Record<string, unknown> {
  const { row } = view;
  const payload = (row.payload ?? {}) as {
    command?: unknown;
    choices?: unknown;
    allow_always?: unknown;
    answer_mode?: unknown;
  };
  const response = (row.response ?? null) as {
    decision?: string | null;
    answer?: string | null;
  } | null;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: isoNow(row.createdAt),
    updated_at: isoNow(row.updatedAt),
    kind: row.kind,
    status: row.status,
    session_id: view.sessionId,
    run_id: row.runId,
    message_id: view.messageId,
    room_id: null,
    workflow_run_id: null,
    node_id: null,
    agent: view.agent,
    title: row.title,
    description: row.description ?? null,
    command: typeof payload.command === 'string' ? payload.command : null,
    choices: Array.isArray(payload.choices) ? payload.choices : [],
    allow_always: payload.allow_always === true,
    answer_mode: typeof payload.answer_mode === 'string' ? payload.answer_mode : 'choice',
    response:
      response && row.respondedAt
        ? {
            decision: response.decision ?? null,
            answer: response.answer ?? null,
            responded_by: row.respondedByUserId ?? row.ownerId,
            responded_at: isoNow(row.respondedAt),
          }
        : null,
    expires_at: iso(row.expiresAt),
  };
}
