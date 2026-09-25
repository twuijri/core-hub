/**
 * The run state machine, as a pure function.
 *
 * Everything a streamed turn does — text, reasoning, tool calls, approvals,
 * usage, interruption, timeout — is folded here. No database, no sockets, no
 * clock: the caller passes `now` and an id factory, so a whole run can be
 * replayed in a unit test and asserted event by event.
 *
 * The states and the legal arrows are exactly `docs/domain/README.md` §run:
 *
 *   queued -> starting -> streaming -> succeeded | failed | cancelled | timed_out
 *   streaming <-> waiting_approval | waiting_input
 *
 * The engine (`engine.ts`) turns the returned `actions` into database writes
 * and the realtime events declared in `packages/contracts/events/sessions/`.
 * The reducer names *what happened*; only the engine knows the wire shapes.
 */
import type { AgentApprovalKind, AgentChoice, AgentEvent, AgentToolKind } from './ports.js';
import type { RUN_STATUSES, TOOL_CALL_STATUSES, APPROVAL_STATUSES } from './schema.js';

export type RunStatus = (typeof RUN_STATUSES)[number];
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const satisfies readonly RunStatus[];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminal(status: RunStatus): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export interface ToolCallState {
  id: string;
  /** The agent's own id for the call; how later events find it again. */
  ref: string;
  seq: number;
  name: string;
  kind: AgentToolKind;
  title: string | null;
  input: Record<string, unknown>;
  output: string | null;
  outputTruncated: boolean;
  exitCode: number | null;
  subagentId: string | null;
  status: ToolCallStatus;
  approvalId: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ApprovalState {
  id: string;
  ref: string;
  kind: AgentApprovalKind;
  status: ApprovalStatus;
  title: string;
  description: string | null;
  command: string | null;
  choices: AgentChoice[];
  allowAlways: boolean;
  answerMode: 'choice' | 'text' | 'both';
  toolCallId: string | null;
  remember: boolean;
  requestedAt: number;
  respondedAt: number | null;
  expiresAt: number | null;
  /** `respondedBy` is null when nobody answered: the request ran out of time. */
  response: { decision: string | null; answer: string | null; respondedBy: string | null } | null;
}

export interface UsageState {
  modelLabel: string;
  providerId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicroUsd: number;
  costSource: 'provider' | 'estimated' | 'unknown';
}

/**
 * One model turn: the model speaking once — before the first tool call, between tool calls,
 * or after the last one. The hub cannot see the agent's own model calls, so it infers them
 * from the stream: a turn opens when the run starts and whenever the last running tool has
 * finished, and closes when a tool starts, a person is asked something, or the run ends.
 * Offsets point into `RunState.text` / `RunState.reasoning`, so a turn's words can be cut out
 * of the finished message later (the trajectory, contract decision §43).
 */
export interface ModelTurnState {
  startedAt: number;
  endedAt: number | null;
  /**
   * How many tool calls had started before this turn opened: where the turn sits among
   * them, by what happened rather than by clock (two events can share a millisecond).
   */
  toolsBefore: number;
  /** The first word or thought of the turn. */
  firstTokenAt: number | null;
  textStart: number;
  textEnd: number | null;
  reasoningStart: number;
  reasoningEnd: number | null;
  reasoningStartedAt: number | null;
  reasoningEndedAt: number | null;
}

export interface RunState {
  status: RunStatus;
  /** The assistant message the run writes into; minted before the first delta. */
  messageId: string;
  text: string;
  reasoning: string;
  reasoningStartedAt: number | null;
  reasoningMs: number | null;
  toolCalls: ToolCallState[];
  approvals: ApprovalState[];
  /** The model's turns, in order; the last is open while the model is speaking. */
  turns: ModelTurnState[];
  usage: UsageState[];
  context: { usedTokens: number; windowTokens: number | null; estimated: boolean } | null;
  /** The agent is compressing the context inside this run (decision §57). */
  compressing: boolean;
  interruptRequested: boolean;
  error: { code: string; message: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Tool names approved for the rest of the session ("always" / "for this session"). */
  rememberedTools: string[];
}

/** Everything that can move a run. Agent frames arrive wrapped in `agent`. */
export type RunInput =
  | { type: 'accepted' }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'interrupt' }
  | {
      type: 'approval_resolved';
      approvalId: string;
      status: Exclude<ApprovalStatus, 'pending'>;
      decision: string | null;
      answer: string | null;
      respondedBy: string | null;
      remember: boolean;
    }
  | { type: 'stream_ended' }
  | { type: 'timeout' }
  | { type: 'abort'; code: string; message: string };

/**
 * What the engine must do about a step. Ids point into `state`; the engine
 * reads the object it needs from there, writes it, and emits the event.
 */
export type RunAction =
  | { type: 'status'; from: RunStatus; to: RunStatus }
  | { type: 'message_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_started'; toolCallId: string }
  | { type: 'tool_completed'; toolCallId: string }
  | { type: 'tool_failed'; toolCallId: string }
  | { type: 'approval_requested'; approvalId: string }
  | { type: 'approval_resolved'; approvalId: string }
  | { type: 'usage'; modelLabel: string }
  | { type: 'context' }
  | { type: 'compression'; phase: 'started' | 'finished' }
  | { type: 'finished'; status: TerminalRunStatus };

export interface ReduceContext {
  now: number;
  newId: () => string;
  /** Tool output longer than this is stored truncated (contract: 16 KB). */
  maxOutputBytes?: number;
}

export interface ReduceResult {
  state: RunState;
  actions: RunAction[];
}

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

export function initialRunState(messageId: string): RunState {
  return {
    status: 'queued',
    messageId,
    text: '',
    reasoning: '',
    reasoningStartedAt: null,
    reasoningMs: null,
    toolCalls: [],
    approvals: [],
    turns: [],
    usage: [],
    context: null,
    compressing: false,
    interruptRequested: false,
    error: null,
    startedAt: null,
    finishedAt: null,
    rememberedTools: [],
  };
}

export function reduceRun(state: RunState, input: RunInput, ctx: ReduceContext): ReduceResult {
  if (isTerminal(state.status)) return { state, actions: [] };
  const actions: RunAction[] = [];
  const next: RunState = { ...state };

  const moveTo = (to: RunStatus): void => {
    if (next.status === to) return;
    actions.push({ type: 'status', from: next.status, to });
    next.status = to;
    if (to === 'starting' && next.startedAt === null) next.startedAt = ctx.now;
    if (isTerminal(to)) {
      closeTurn();
      next.finishedAt = ctx.now;
      actions.push({ type: 'finished', status: to });
    }
  };

  const openTurn = (): ModelTurnState => {
    const last = next.turns.at(-1);
    if (last && last.endedAt === null) return last;
    const turn: ModelTurnState = {
      startedAt: ctx.now,
      endedAt: null,
      toolsBefore: next.toolCalls.length,
      firstTokenAt: null,
      textStart: next.text.length,
      textEnd: null,
      reasoningStart: next.reasoning.length,
      reasoningEnd: null,
      reasoningStartedAt: null,
      reasoningEndedAt: null,
    };
    next.turns = [...next.turns, turn];
    return turn;
  };

  /** Replace the open turn (turns are immutable like the rest of the state). */
  const updateTurn = (patch: Partial<ModelTurnState>): void => {
    const index = next.turns.length - 1;
    const last = next.turns[index];
    if (!last || last.endedAt !== null) return;
    next.turns = next.turns.with(index, { ...last, ...patch });
  };

  const closeTurn = (): void => {
    const last = next.turns.at(-1);
    if (!last || last.endedAt !== null) return;
    const said = next.text.length > last.textStart || next.reasoning.length > last.reasoningStart;
    // A turn that said nothing and lasted no time at all is not a turn: the run ended the
    // moment the last tool did.
    if (!said && ctx.now === last.startedAt && last.firstTokenAt === null) {
      next.turns = next.turns.slice(0, -1);
      return;
    }
    updateTurn({
      endedAt: ctx.now,
      textEnd: next.text.length,
      reasoningEnd: next.reasoning.length,
      reasoningEndedAt:
        last.reasoningStartedAt !== null && last.reasoningEndedAt === null
          ? ctx.now
          : last.reasoningEndedAt,
    });
  };

  /** The model has the floor again once no tool runs and nobody is being asked anything. */
  const resumeModelIfIdle = (): void => {
    if (isTerminal(next.status)) return;
    const toolBusy = next.toolCalls.some((c) => c.status === 'pending' || c.status === 'running');
    const asking = next.approvals.some((a) => a.status === 'pending');
    if (!toolBusy && !asking) openTurn();
  };

  /** Any agent frame proves the turn is alive; a blocked run resumes on it. */
  const liven = (): void => {
    if (next.status === 'queued') moveTo('starting');
    if (next.status !== 'streaming') moveTo('streaming');
  };

  const finishOpenWork = (toolStatus: ToolCallStatus, approvalStatus: ApprovalStatus): void => {
    next.toolCalls = next.toolCalls.map((call) =>
      call.status === 'pending' || call.status === 'running'
        ? { ...call, status: toolStatus, finishedAt: ctx.now }
        : call,
    );
    next.approvals = next.approvals.map((approval) =>
      approval.status === 'pending'
        ? { ...approval, status: approvalStatus, respondedAt: ctx.now }
        : approval,
    );
  };

  switch (input.type) {
    case 'accepted':
      moveTo('starting');
      openTurn();
      break;

    case 'interrupt':
      next.interruptRequested = true;
      break;

    case 'timeout':
      next.error = { code: 'timeout', message: 'agent timeout' };
      finishOpenWork('cancelled', 'expired');
      moveTo('timed_out');
      break;

    case 'abort':
      next.error = { code: input.code, message: input.message };
      finishOpenWork('cancelled', 'cancelled');
      moveTo(input.code === 'cancelled' ? 'cancelled' : 'failed');
      break;

    case 'stream_ended':
      // The adapter stopped talking without a terminal frame.
      finishOpenWork(next.interruptRequested ? 'cancelled' : 'failed', 'cancelled');
      if (next.interruptRequested) {
        moveTo('cancelled');
      } else {
        next.error = next.error ?? { code: 'agent_error', message: 'stream ended unexpectedly' };
        moveTo('failed');
      }
      break;

    case 'approval_resolved': {
      const index = next.approvals.findIndex((a) => a.id === input.approvalId);
      const approval = next.approvals[index];
      if (!approval || approval.status !== 'pending') break;
      const resolved: ApprovalState = {
        ...approval,
        status: input.status,
        respondedAt: ctx.now,
        remember: input.remember,
        response: {
          decision: input.decision,
          answer: input.answer,
          respondedBy: input.respondedBy,
        },
      };
      next.approvals = next.approvals.with(index, resolved);
      actions.push({ type: 'approval_resolved', approvalId: resolved.id });

      if (resolved.toolCallId) {
        const toolIndex = next.toolCalls.findIndex((c) => c.id === resolved.toolCallId);
        const call = next.toolCalls[toolIndex];
        if (call) {
          // A skipped question is not a refused tool: the agent's tool still runs, and
          // says what it got (Hermes's `clarify` returns the empty answer).
          if (input.status === 'denied' && resolved.kind !== 'question') {
            next.toolCalls = next.toolCalls.with(toolIndex, {
              ...call,
              status: 'denied',
              finishedAt: ctx.now,
            });
            actions.push({ type: 'tool_failed', toolCallId: call.id });
          } else if (input.status === 'approved') {
            next.toolCalls = next.toolCalls.with(toolIndex, { ...call, status: 'running' });
          }
          if (input.remember && !next.rememberedTools.includes(call.name)) {
            next.rememberedTools = [...next.rememberedTools, call.name];
          }
        }
      }
      // Unblock only when nothing else is pending.
      if (!next.approvals.some((a) => a.status === 'pending')) moveTo('streaming');
      resumeModelIfIdle();
      break;
    }

    case 'agent': {
      const event = input.event;
      switch (event.type) {
        case 'message_delta': {
          liven();
          if (next.reasoningStartedAt !== null && next.reasoningMs === null) {
            next.reasoningMs = ctx.now - next.reasoningStartedAt;
          }
          if (event.text.length > 0) {
            const turn = openTurn();
            updateTurn({
              firstTokenAt: turn.firstTokenAt ?? ctx.now,
              ...(turn.reasoningStartedAt !== null && turn.reasoningEndedAt === null
                ? { reasoningEndedAt: ctx.now }
                : {}),
            });
          }
          next.text += event.text;
          if (event.text.length > 0) actions.push({ type: 'message_delta', delta: event.text });
          break;
        }

        case 'reasoning_delta': {
          liven();
          if (next.reasoningStartedAt === null) next.reasoningStartedAt = ctx.now;
          if (event.text.length > 0) {
            const turn = openTurn();
            updateTurn({
              firstTokenAt: turn.firstTokenAt ?? ctx.now,
              reasoningStartedAt: turn.reasoningStartedAt ?? ctx.now,
            });
          }
          next.reasoning += event.text;
          if (event.text.length > 0) actions.push({ type: 'reasoning_delta', delta: event.text });
          break;
        }

        case 'tool_started': {
          liven();
          const existing = next.toolCalls.find((c) => c.ref === event.ref);
          if (existing) break;
          // The model has handed over to a tool: its turn ends here.
          closeTurn();
          const call: ToolCallState = {
            id: ctx.newId(),
            ref: event.ref,
            seq: next.toolCalls.length + 1,
            name: event.name,
            kind: event.kind ?? 'custom',
            title: event.title ?? null,
            input: event.input ?? {},
            output: null,
            outputTruncated: false,
            exitCode: null,
            subagentId: event.subagentId ?? null,
            status: 'running',
            approvalId: null,
            startedAt: ctx.now,
            finishedAt: null,
          };
          next.toolCalls = [...next.toolCalls, call];
          actions.push({ type: 'tool_started', toolCallId: call.id });
          break;
        }

        case 'tool_completed':
        case 'tool_failed': {
          liven();
          const index = next.toolCalls.findIndex((c) => c.ref === event.ref);
          const call = next.toolCalls[index];
          if (!call) break;
          const { text, truncated } = truncate(event.output ?? null, ctx.maxOutputBytes);
          next.toolCalls = next.toolCalls.with(index, {
            ...call,
            status: event.type === 'tool_completed' ? 'succeeded' : 'failed',
            output: text,
            outputTruncated: truncated,
            exitCode: event.exitCode ?? null,
            finishedAt: ctx.now,
          });
          actions.push({
            type: event.type === 'tool_completed' ? 'tool_completed' : 'tool_failed',
            toolCallId: call.id,
          });
          resumeModelIfIdle();
          break;
        }

        case 'approval_requested': {
          liven();
          if (next.approvals.some((a) => a.ref === event.ref)) break;
          const toolIndex = event.toolRef
            ? next.toolCalls.findIndex((c) => c.ref === event.toolRef)
            : -1;
          const toolCall = toolIndex >= 0 ? next.toolCalls[toolIndex] : undefined;
          const approval: ApprovalState = {
            id: ctx.newId(),
            ref: event.ref,
            kind: event.kind,
            status: 'pending',
            title: event.title,
            description: event.description ?? null,
            command: event.command ?? null,
            choices: event.choices ?? [],
            allowAlways: event.allowAlways ?? false,
            answerMode: event.answerMode ?? (event.kind === 'question' ? 'both' : 'choice'),
            toolCallId: toolCall?.id ?? null,
            remember: false,
            requestedAt: ctx.now,
            respondedAt: null,
            expiresAt: event.expiresInMs ? ctx.now + event.expiresInMs : null,
            response: null,
          };
          next.approvals = [...next.approvals, approval];
          if (toolCall && toolIndex >= 0) {
            next.toolCalls = next.toolCalls.with(toolIndex, {
              ...toolCall,
              status: 'pending',
              approvalId: approval.id,
            });
          }
          actions.push({ type: 'approval_requested', approvalId: approval.id });
          // Waiting on a person is nobody's model time.
          closeTurn();
          moveTo(event.kind === 'question' ? 'waiting_input' : 'waiting_approval');
          break;
        }

        case 'usage': {
          const modelLabel = event.modelLabel ?? 'unknown';
          const index = next.usage.findIndex((u) => u.modelLabel === modelLabel);
          const merged: UsageState = {
            modelLabel,
            providerId: event.providerId ?? null,
            inputTokens: event.inputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            cacheReadTokens: event.cacheReadTokens ?? 0,
            cacheWriteTokens: event.cacheWriteTokens ?? 0,
            reasoningTokens: event.reasoningTokens ?? 0,
            costMicroUsd: event.costMicroUsd ?? 0,
            costSource: event.costSource ?? 'unknown',
          };
          // Adapters report cumulative totals for a turn, so replace, never add.
          next.usage = index >= 0 ? next.usage.with(index, merged) : [...next.usage, merged];
          actions.push({ type: 'usage', modelLabel });
          break;
        }

        case 'context': {
          next.context = {
            usedTokens: event.usedTokens,
            windowTokens: event.windowTokens ?? null,
            estimated: event.estimated === true,
          };
          actions.push({ type: 'context' });
          break;
        }

        case 'compression': {
          // A repeated phase is the agent restating it; the event goes out once.
          const compressing = event.phase === 'started';
          if (next.compressing === compressing) break;
          next.compressing = compressing;
          actions.push({ type: 'compression', phase: event.phase });
          break;
        }

        case 'completed': {
          if (next.reasoningStartedAt !== null && next.reasoningMs === null) {
            next.reasoningMs = ctx.now - next.reasoningStartedAt;
          }
          if (next.interruptRequested) {
            finishOpenWork('cancelled', 'cancelled');
            moveTo('cancelled');
          } else {
            finishOpenWork('succeeded', 'cancelled');
            moveTo('succeeded');
          }
          break;
        }

        case 'failed': {
          next.error = { code: event.code ?? 'agent_error', message: event.message };
          finishOpenWork('failed', 'cancelled');
          moveTo(next.interruptRequested ? 'cancelled' : 'failed');
          break;
        }
      }
      break;
    }
  }

  return { state: next, actions };
}

function truncate(
  value: string | null,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  // Cut on a character boundary: decoding a sliced buffer replaces a split
  // code point with U+FFFD, so drop a trailing replacement character.
  const cut = bytes.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
  return { text: cut, truncated: true };
}
