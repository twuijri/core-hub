/**
 * The run engine: it drives one agent turn from `queued` to a terminal state,
 * writing what must survive and emitting what the clients watch.
 *
 * Shape of a turn:
 *
 *   POST /sessions/{id}/runs      user message stored, run queued, 202 returned
 *          |                       (message.created, run.queued)
 *          v
 *   engine.kick(session)          one run at a time per session, in order
 *          |
 *          v
 *   runner.start()                adapter accepts -> assistant message shell
 *          |                       (message.created, run.started)
 *          v
 *   for await (event of runner.stream(runId))
 *          |                      reduceRun() decides what changed
 *          v                      (message.delta, reasoning.delta, tool.*,
 *   terminal state                 approval.requested, context.updated)
 *          |
 *          v
 *   persist + (run.completed | run.failed | run.cancelled) + session.updated
 *
 * The reducer (`run-reducer.ts`) owns *what happens*; this file owns *what is
 * written and sent*. Keeping them apart is what makes a whole run assertable
 * in a unit test without a database or a socket.
 *
 * Deltas are never persisted (docs/domain/README.md §What is deliberately not
 * stored); the final message is written once, at the end, and every emitted
 * envelope is journaled so a reconnecting client can be given exactly what it
 * missed (`journal.ts`).
 */
import { HubError } from '../../lib/errors.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Language } from '../../i18n/index.js';
import { newUlid } from '../../db/ids.js';
import type { AuditService } from '../audit/index.js';
import {
  toApproval,
  toMessage,
  toRun,
  toSession,
  toToolCall,
  type ApprovalRow,
  type MessageRow,
  type RunRow,
  type SessionRow,
  type ToolCallRow,
} from './mappers.js';
import type { AgentEvent, AgentInfo, AgentPromptBlock, SessionsPorts } from './ports.js';
import {
  initialRunState,
  isTerminal,
  reduceRun,
  type ApprovalState,
  type RunAction,
  type RunInput,
  type RunState,
  type ToolCallState,
} from './run-reducer.js';
import type { SessionsRealtime } from './realtime.js';
import type { SessionsStore } from './store.js';
import { preview } from './store.js';

export interface EngineScope {
  workspace: string;
  profile: string;
  userId: string;
  userName: string;
  /** The request language, so a per-item error in a bulk result is localised. */
  language: Language;
}

interface ActiveRun {
  runId: string;
  jobId: string;
  sessionId: string;
  scope: EngineScope;
  agent: AgentInfo;
  state: RunState;
}

export interface EngineDeps {
  store: SessionsStore;
  audit: AuditService;
  realtime: SessionsRealtime;
  ports: SessionsPorts;
  log: FastifyBaseLogger;
}

export class RunEngine {
  private readonly active = new Map<string, ActiveRun>();
  /** One chain per session guarantees runs execute in order, never in parallel. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: EngineDeps) {}

  /** Start the session's next queued run, after whatever is already chained. */
  kick(scope: EngineScope, sessionId: string): Promise<void> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.drain(scope, sessionId))
      .catch((error: unknown) => {
        this.deps.log.error({ err: error, sessionId }, 'sessions: run chain failed');
      });
    this.chains.set(sessionId, next);
    return next;
  }

  /** Test and shutdown hook: wait until a session has nothing left to run. */
  async settled(sessionId: string): Promise<void> {
    let chain = this.chains.get(sessionId);
    while (chain) {
      await chain.catch(() => undefined);
      const current = this.chains.get(sessionId);
      if (current === chain) break;
      chain = current;
    }
  }

  async settledAll(): Promise<void> {
    await Promise.all([...this.chains.keys()].map((id) => this.settled(id)));
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Ask the adapter to stop; the stream ends on its own afterwards. */
  async requestInterrupt(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (run) run.state = reduceRun(run.state, { type: 'interrupt' }, this.ctx()).state;
    try {
      await this.deps.ports.runner.interrupt(runId);
    } catch (error) {
      this.deps.log.warn({ err: error, runId }, 'sessions: adapter refused the interrupt');
    }
  }

  /**
   * Record a person's answer on a pending approval and hand it to the agent.
   * Returns the stored approval row.
   */
  async resolveApproval(
    scope: EngineScope,
    approval: ApprovalRow,
    input: {
      status: 'approved' | 'denied' | 'answered';
      decision: string | null;
      answer: string | null;
    },
  ): Promise<ApprovalRow> {
    const remember = input.decision === 'approve_session' || input.decision === 'approve_always';
    const run = this.active.get(approval.runId);
    const ref = (approval.payload as { ref?: unknown }).ref;

    if (run) {
      const result = reduceRun(
        run.state,
        {
          type: 'approval_resolved',
          approvalId: approval.id,
          status: input.status,
          decision: input.decision,
          answer: input.answer,
          respondedBy: scope.userId,
          remember,
        },
        this.ctx(),
      );
      run.state = result.state;
      this.apply(run, result.actions);
      if (remember) this.rememberTools(scope, run);
      await this.deps.ports.runner.send(run.runId, {
        approvalRef: typeof ref === 'string' ? ref : approval.id,
        decision: (input.decision ?? null) as never,
        answer: input.answer,
      });
      return this.deps.store.getApproval(scope.workspace, approval.id) as ApprovalRow;
    }

    // The run is not live here (server restarted, or it already ended): record
    // the decision so the inbox is honest, but do not pretend the agent heard it.
    const stored = this.deps.store.upsertApproval(
      scope.workspace,
      approval.ownerId,
      approval.runId,
      {
        id: approval.id,
        toolCallId: approval.toolCallId,
        kind: approval.kind,
        status: input.status,
        title: approval.title,
        description: approval.description,
        payload: approval.payload,
        response: { decision: input.decision, answer: input.answer },
        respondedByUserId: scope.userId,
        remember,
        requestedAt: approval.requestedAt,
        respondedAt: new Date(),
        expiresAt: approval.expiresAt,
      },
    );
    this.emitApproval(scope, stored, 'approval.resolved');
    return stored;
  }

  // ------------------------------------------------------------- internals

  private ctx() {
    return { now: Date.now(), newId: newUlid };
  }

  private async drain(scope: EngineScope, sessionId: string): Promise<void> {
    for (;;) {
      const next = this.deps.store.nextQueuedRun(scope.workspace, sessionId);
      if (!next) return;
      await this.execute(scope, next);
    }
  }

  private async execute(scope: EngineScope, runRow: RunRow): Promise<void> {
    const { store, audit, ports, log } = this.deps;
    const session = store.getSession(scope.workspace, runRow.sessionId);
    if (!session) return;

    const agent = await ports.agents.find(scope.workspace, runRow.agentId);
    if (!agent || !agent.available) {
      this.failBeforeStart(scope, runRow, {
        code: 'agent_unavailable',
        message: agent ? (agent.unavailableReason ?? 'agent unavailable') : 'agent not found',
      });
      return;
    }

    audit.startJob(runRow.jobId);

    // The assistant message shell: it exists before the first delta so every
    // delta has a message to append to (contract: run.started).
    const shell = store.appendMessage({
      workspace: scope.workspace,
      ownerId: scope.userId,
      sessionId: session.id,
      runId: runRow.id,
      role: 'assistant',
      authorKind: 'agent',
      authorId: agent.id,
      content: '',
      parts: [],
      attachmentIds: [],
    });

    const active: ActiveRun = {
      runId: runRow.id,
      jobId: runRow.jobId,
      sessionId: session.id,
      scope,
      agent,
      state: initialRunState(shell.id),
    };
    this.active.set(runRow.id, active);

    try {
      const accepted = await ports.runner.start({
        runId: runRow.id,
        sessionId: session.id,
        workspace: scope.workspace,
        agentId: agent.id,
        agentSessionRef: session.agentSessionRef,
        workingDir: session.workingDir,
        model: runRow.modelLabel,
        provider: runRow.provider,
        reasoningEffort: runRow.reasoningEffort,
        prompt: promptOf(store, scope.workspace, runRow),
        allowedTools: allowedToolsOf(session),
      });
      if (accepted.agentSessionRef && accepted.agentSessionRef !== session.agentSessionRef) {
        store.updateSession(scope.workspace, session.id, {
          agentSessionRef: accepted.agentSessionRef,
        });
      }
      if (accepted.agentRunRef) {
        store.updateRun(scope.workspace, runRow.id, { agentRunRef: accepted.agentRunRef });
      }
    } catch (error) {
      this.active.delete(runRow.id);
      store.updateMessage(scope.workspace, shell.id, { content: '' });
      this.failBeforeStart(scope, runRow, {
        code: error instanceof HubError ? error.code : 'agent_error',
        message: error instanceof Error ? error.message : 'the agent refused the turn',
      });
      return;
    }

    // starting -> the shell is visible -> run.started
    this.step(active, { type: 'accepted' });
    this.emitToSession(scope, session.id, 'message.created', {
      message: this.messageView(scope, shell, active),
    });
    this.emitRun(scope, store.getRun(scope.workspace, runRow.id) as RunRow, 'run.started');
    this.emitSession(scope, session.id);

    try {
      for await (const event of withTimeout(ports.runner.stream(runRow.id), ports.agentTimeoutMs)) {
        if (event === TIMEOUT) {
          this.step(active, { type: 'timeout' });
          break;
        }
        this.step(active, { type: 'agent', event });
        if (isTerminal(active.state.status)) break;
      }
      if (!isTerminal(active.state.status)) this.step(active, { type: 'stream_ended' });
    } catch (error) {
      log.error({ err: error, runId: runRow.id }, 'sessions: adapter stream failed');
      this.step(active, {
        type: 'abort',
        code: 'agent_error',
        message: error instanceof Error ? error.message : 'adapter stream failed',
      });
    } finally {
      this.active.delete(runRow.id);
      this.finalise(active, shell.id);
    }
  }

  /** Reduce one input and carry out everything it implies. */
  private step(run: ActiveRun, input: RunInput): void {
    const result = reduceRun(run.state, input, this.ctx());
    run.state = result.state;
    this.apply(run, result.actions);
  }

  private apply(run: ActiveRun, actions: RunAction[]): void {
    const { store, audit } = this.deps;
    const { scope, sessionId, state } = run;
    for (const action of actions) {
      switch (action.type) {
        case 'message_delta':
          this.emitToSession(scope, sessionId, 'message.delta', {
            session_id: sessionId,
            message_id: state.messageId,
            run_id: run.runId,
            delta: action.delta,
          });
          break;

        case 'reasoning_delta':
          this.emitToSession(scope, sessionId, 'reasoning.delta', {
            session_id: sessionId,
            message_id: state.messageId,
            run_id: run.runId,
            delta: action.delta,
          });
          break;

        case 'tool_started':
        case 'tool_completed':
        case 'tool_failed': {
          const call = state.toolCalls.find((c) => c.id === action.toolCallId);
          if (!call) break;
          const row = this.writeToolCall(run, call);
          this.emitToSession(
            scope,
            sessionId,
            action.type === 'tool_started'
              ? 'tool.started'
              : action.type === 'tool_completed'
                ? 'tool.completed'
                : 'tool.failed',
            {
              session_id: sessionId,
              message_id: state.messageId,
              run_id: run.runId,
              tool_call: toToolCall(row),
            },
          );
          break;
        }

        case 'approval_requested':
        case 'approval_resolved': {
          const approval = state.approvals.find((a) => a.id === action.approvalId);
          if (!approval) break;
          const row = this.writeApproval(run, approval);
          this.emitApproval(
            scope,
            row,
            action.type === 'approval_requested' ? 'approval.requested' : 'approval.resolved',
            run,
          );
          break;
        }

        case 'usage': {
          const usage = state.usage.find((u) => u.modelLabel === action.modelLabel);
          if (!usage) break;
          const runRow = store.getRun(scope.workspace, run.runId);
          audit.recordUsage({
            workspace: scope.workspace,
            ownerId: scope.userId,
            runId: run.runId,
            sessionId,
            agentId: run.agent.id,
            providerId: usage.providerId,
            modelLabel: usage.modelLabel,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            costMicroUsd: usage.costMicroUsd,
            costSource: usage.costSource,
            originKind: runRow?.originKind ?? 'user',
            originId: runRow?.originId ?? null,
          });
          break;
        }

        case 'context': {
          if (!state.context) break;
          this.emitToSession(scope, sessionId, 'context.updated', {
            session_id: sessionId,
            context: {
              used_tokens: state.context.usedTokens,
              window_tokens: state.context.windowTokens,
            },
            usage: null,
          });
          break;
        }

        case 'status': {
          store.updateRun(scope.workspace, run.runId, {
            status: action.to,
            ...(action.to === 'starting' ? { startedAt: new Date() } : {}),
          });
          // The session's live state follows the run's (`Session.status`).
          // `queued -> starting` is announced by execute() right after
          // `run.started`, so the pair the contract documents stays together.
          if (
            action.to !== 'starting' &&
            statusClass(action.from) !== statusClass(action.to) &&
            !isTerminal(action.to)
          ) {
            this.emitSession(scope, sessionId);
          }
          break;
        }

        case 'finished':
          // Handled in finalise(), which needs the final message too.
          break;
      }
    }
  }

  private writeToolCall(run: ActiveRun, call: ToolCallState): ToolCallRow {
    return this.deps.store.upsertToolCall(run.scope.workspace, run.scope.userId, run.runId, {
      id: call.id,
      messageId: run.state.messageId,
      seq: call.seq,
      ref: call.ref,
      name: call.name,
      kind: call.kind,
      title: call.title,
      input: call.input,
      output: call.output,
      outputTruncated: call.outputTruncated,
      subagentId: call.subagentId,
      status: call.status,
      approvalId: call.approvalId,
      startedAt: new Date(call.startedAt),
      finishedAt: call.finishedAt === null ? null : new Date(call.finishedAt),
      exitCode: call.exitCode,
    });
  }

  private writeApproval(run: ActiveRun, approval: ApprovalState): ApprovalRow {
    return this.deps.store.upsertApproval(run.scope.workspace, run.scope.userId, run.runId, {
      id: approval.id,
      toolCallId: approval.toolCallId,
      kind: approval.kind,
      status: approval.status,
      title: approval.title,
      description: approval.description,
      payload: {
        ref: approval.ref,
        command: approval.command,
        choices: approval.choices,
        allow_always: approval.allowAlways,
        answer_mode: approval.answerMode,
      },
      response: approval.response
        ? { decision: approval.response.decision, answer: approval.response.answer }
        : null,
      respondedByUserId: approval.response?.respondedBy ?? null,
      remember: approval.remember,
      requestedAt: new Date(approval.requestedAt),
      respondedAt: approval.respondedAt === null ? null : new Date(approval.respondedAt),
      expiresAt: approval.expiresAt === null ? null : new Date(approval.expiresAt),
    });
  }

  private rememberTools(scope: EngineScope, run: ActiveRun): void {
    const session = this.deps.store.getSession(scope.workspace, run.sessionId);
    if (!session) return;
    const current = allowedToolsOf(session);
    const merged = [...new Set([...current, ...run.state.rememberedTools])];
    if (merged.length === current.length) return;
    this.deps.store.updateSession(scope.workspace, session.id, {
      metadata: { ...session.metadata, allowedTools: merged },
    });
  }

  /** A run that never reached the adapter: no deltas, one terminal event. */
  private failBeforeStart(
    scope: EngineScope,
    runRow: RunRow,
    error: { code: string; message: string },
  ): void {
    const updated = this.deps.store.updateRun(scope.workspace, runRow.id, {
      status: 'failed',
      finishedAt: new Date(),
      errorCode: error.code,
      errorMessage: error.message,
    });
    this.deps.audit.finishJob(runRow.jobId, 'failed', {
      errorCode: error.code,
      errorMessage: error.message,
    });
    if (updated) this.emitRun(scope, updated, 'run.failed');
    this.emitSession(scope, runRow.sessionId);
  }

  /** Write the final message and run, then emit the one terminal event. */
  private finalise(run: ActiveRun, messageId: string): void {
    const { store, audit } = this.deps;
    const { scope, state } = run;
    const status = state.status;
    const terminal = isTerminal(status) ? status : 'failed';

    const message = store.updateMessage(scope.workspace, messageId, {
      content: state.text,
      parts: state.text ? [{ type: 'text', text: state.text }] : [],
      reasoning: state.reasoning || null,
    });

    const runRow = store.updateRun(scope.workspace, run.runId, {
      status: terminal,
      finishedAt: new Date(),
      finalMessageId: messageId,
      errorCode: state.error?.code ?? null,
      errorMessage: state.error?.message ?? null,
    });

    const session = store.getSession(scope.workspace, run.sessionId);
    if (session) {
      store.updateSession(scope.workspace, session.id, {
        lastRunId: run.runId,
        lastMessageAt: new Date(),
        preview: preview(state.text) ?? session.preview,
      });
    }

    audit.finishJob(
      run.jobId,
      terminal === 'succeeded' ? 'succeeded' : terminal === 'cancelled' ? 'cancelled' : 'failed',
      state.error
        ? { errorCode: state.error.code, errorMessage: state.error.message }
        : { result: { message_id: messageId } },
    );

    if (runRow && message) {
      const event =
        terminal === 'succeeded'
          ? 'run.completed'
          : terminal === 'cancelled'
            ? 'run.cancelled'
            : 'run.failed';
      if (event === 'run.completed') {
        this.emitToSession(scope, run.sessionId, 'run.completed', {
          run: this.runPayload(scope, runRow),
          message: this.messageView(scope, message, run),
        });
      } else {
        this.emitRun(scope, runRow, event);
      }
    }
    this.emitSession(scope, run.sessionId);
  }

  // ------------------------------------------------------------- emitters

  private emitToSession(
    scope: EngineScope,
    sessionId: string,
    event: Parameters<SessionsRealtime['emitToSession']>[2],
    payload: unknown,
  ): void {
    this.deps.realtime.emitToSession(scope.profile, sessionId, event, payload);
  }

  private runPayload(scope: EngineScope, row: RunRow): Record<string, unknown> {
    return toRun(
      { row, queuePosition: null, usage: this.deps.audit.totalsForRun(scope.workspace, row.id) },
      scope.profile,
    );
  }

  private emitRun(
    scope: EngineScope,
    row: RunRow,
    event: 'run.queued' | 'run.started' | 'run.failed' | 'run.cancelled',
  ): void {
    this.emitToSession(scope, row.sessionId, event, { run: this.runPayload(scope, row) });
  }

  private emitSession(scope: EngineScope, sessionId: string): void {
    const session = this.deps.store.getSession(scope.workspace, sessionId);
    if (!session) return;
    this.deps.realtime.emitToProfile(scope.profile, 'session.updated', {
      session: this.sessionPayload(scope, session),
    });
  }

  sessionPayload(scope: EngineScope, session: SessionRow): Record<string, unknown> {
    const live = this.deps.store.liveRuns(scope.workspace, session.id);
    const lastRun =
      live[0] ??
      (session.lastRunId ? this.deps.store.getRun(scope.workspace, session.lastRunId) : undefined);
    return toSession(
      {
        row: session,
        lastRunStatus: lastRun?.status ?? null,
        activeRunId: live[0]?.id ?? null,
        usage: this.deps.audit.totalsForSession(scope.workspace, session.id),
      },
      scope.profile,
    );
  }

  private emitApproval(
    scope: EngineScope,
    row: ApprovalRow,
    event: 'approval.requested' | 'approval.resolved',
    run?: ActiveRun,
  ): void {
    const sessionId = run?.sessionId ?? this.deps.store.sessionIdOfApproval(scope.workspace, row);
    if (!sessionId) return;
    const agent = run
      ? { id: run.agent.id, name: run.agent.name }
      : agentRefOf(this.deps.store, scope.workspace, row.runId);
    const payload = {
      approval: toApproval(
        { row, sessionId, messageId: run?.state.messageId ?? null, agent },
        scope.profile,
      ),
    };
    // Profile-wide (the pending-actions bar shows it from any screen), and
    // journaled under the session so a reconnecting client is told about it.
    this.deps.realtime.emitToProfileFor(scope.profile, sessionId, event, payload);
  }

  private messageView(
    scope: EngineScope,
    row: MessageRow,
    run: ActiveRun,
  ): Record<string, unknown> {
    const calls =
      this.deps.store.toolCallsForRuns(scope.workspace, [run.runId]).get(run.runId) ?? [];
    return toMessage(
      {
        row,
        author: { kind: 'agent', id: run.agent.id, name: run.agent.name, avatar: null },
        toolCalls: calls,
        status: messageStatusOf(run.state.status),
        usage: this.deps.audit.totalsForRun(scope.workspace, run.runId),
      },
      scope.profile,
    );
  }
}

function statusClass(status: RunState['status']): 'queued' | 'running' | 'waiting' | 'done' {
  if (status === 'queued') return 'queued';
  if (status === 'waiting_approval' || status === 'waiting_input') return 'waiting';
  return isTerminal(status) ? 'done' : 'running';
}

export function messageStatusOf(
  runStatus: RunState['status'],
): 'complete' | 'streaming' | 'failed' | 'interrupted' {
  switch (runStatus) {
    case 'succeeded':
      return 'complete';
    case 'cancelled':
      return 'interrupted';
    case 'failed':
    case 'timed_out':
      return 'failed';
    default:
      return 'streaming';
  }
}

function agentRefOf(
  store: SessionsStore,
  workspace: string,
  runId: string,
): { id: string; name: string } {
  const run = store.getRun(workspace, runId);
  return { id: run?.agentId ?? runId, name: 'agent' };
}

function allowedToolsOf(session: SessionRow): string[] {
  const value = (session.metadata as { allowedTools?: unknown }).allowedTools;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The prompt handed to the adapter: the content blocks of the trigger message. */
function promptOf(store: SessionsStore, workspace: string, run: RunRow): AgentPromptBlock[] {
  if (!run.triggerMessageId) return [];
  const message = store.getMessage(workspace, run.triggerMessageId);
  if (!message) return [];
  const blocks: AgentPromptBlock[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image')
      blocks.push({ type: 'attachment', attachmentId: part.attachmentId, kind: 'image' });
    else if (part.type === 'file')
      blocks.push({ type: 'attachment', attachmentId: part.attachmentId, kind: 'file' });
  }
  if (blocks.length === 0 && message.content) blocks.push({ type: 'text', text: message.content });
  return blocks;
}

export const TIMEOUT = Symbol('agent-timeout');

/**
 * Yields the adapter's events, or `TIMEOUT` once `ms` pass with silence —
 * the `streaming -> timed_out` arrow of the run state machine.
 */
export async function* withTimeout(
  source: AsyncIterable<AgentEvent>,
  ms: number,
): AsyncGenerator<AgentEvent | typeof TIMEOUT> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms);
      timer.unref?.();
    });
    const result = await Promise.race([iterator.next(), deadline]);
    clearTimeout(timer);
    if (result === TIMEOUT) {
      await iterator.return?.(undefined);
      yield TIMEOUT;
      return;
    }
    if (result.done) return;
    yield result.value;
  }
}
