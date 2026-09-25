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
import { t, type Language } from '../../i18n/index.js';
import { newUlid } from '../../db/ids.js';
import type { AuditService } from '../audit/index.js';
import { skillUseOf } from './skill-use.js';
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
import type {
  AgentEvent,
  AgentFileExchange,
  AgentInfo,
  AgentPromptBlock,
  AttachmentsPort,
  SessionsPorts,
} from './ports.js';
import { SessionNamer } from './naming.js';
import { OutputWatcher, ensureRunFolders, type ProducedRefusal } from './run-files.js';
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
import type { MessagePart } from './schema.js';

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
  /** The run's output folder, watched while it is live; `null` when files are off. */
  outputs: OutputWatcher | null;
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
  /** Naming a session (decision §26). Deliberately *outside* the chains: a title must
      never make the next queued run wait. */
  readonly namer: SessionNamer;

  constructor(private readonly deps: EngineDeps) {
    this.namer = new SessionNamer({
      store: deps.store,
      realtime: deps.realtime,
      ports: deps.ports,
      log: deps.log,
      render: (scope, session) => this.sessionPayload(scope, session),
    });
  }

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
    // A title asked for by the last run is still in flight here; a shutdown that dropped
    // it would leave a session named "New chat" for no reason a person could see.
    await this.namer.settled();
  }

  /**
   * What a live run has done so far — its text, reasoning and model turns, which are only
   * written when it ends. The trajectory reads it (contract decision §43); `undefined` once
   * the run is no longer active.
   */
  liveState(runId: string): RunState | undefined {
    return this.active.get(runId)?.state;
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
    const run = approval.runId ? this.active.get(approval.runId) : undefined;
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

  /**
   * A request with a deadline (a question waits five minutes, owner decision 2026-09-23)
   * that nobody answered in time is closed as `expired`, and the agent is told "no" — for
   * a question that is Hermes's skip, the empty answer. The person sees the deadline count
   * down on the card, so the hub keeps it rather than leaving the agent to its own, longer
   * one.
   */
  private expireLater(run: ActiveRun, approvalId: string, expiresAt: number): void {
    const timer = setTimeout(
      () => void this.expire(run, approvalId),
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref?.();
  }

  private async expire(run: ActiveRun, approvalId: string): Promise<void> {
    if (this.active.get(run.runId) !== run) return;
    const approval = run.state.approvals.find((a) => a.id === approvalId);
    if (!approval || approval.status !== 'pending') return;
    this.step(run, {
      type: 'approval_resolved',
      approvalId,
      status: 'expired',
      decision: 'deny',
      answer: null,
      respondedBy: null,
      remember: false,
    });
    try {
      await this.deps.ports.runner.send(run.runId, {
        approvalRef: approval.ref,
        decision: 'deny',
        answer: null,
      });
    } catch (error) {
      this.deps.log.warn(
        { err: error, runId: run.runId },
        'sessions: the agent did not take the expiry',
      );
    }
  }

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

    // Files in and files out. A session always has a working directory
    // (`working-dir.ts`), so the only reason this is `null` is a disk that refused.
    const exchange = this.prepareFiles(scope, session.workingDir, runRow);

    const active: ActiveRun = {
      runId: runRow.id,
      jobId: runRow.jobId,
      sessionId: session.id,
      scope,
      agent,
      state: initialRunState(shell.id),
      outputs: exchange ? new OutputWatcher(exchange.files.outputDir).start() : null,
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
        prompt: exchange?.prompt ?? promptOf(store, scope.workspace, runRow),
        files: exchange?.files ?? null,
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
      active.outputs?.stop();
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
      // Silence is only the agent's while nobody else is expected to speak: a run waiting
      // on a person's approval or answer waits as long as the person takes.
      const waiting = () =>
        active.state.status === 'waiting_approval' || active.state.status === 'waiting_input';
      for await (const event of withTimeout(
        ports.runner.stream(runRow.id),
        ports.agentTimeoutMs,
        waiting,
      )) {
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
      await this.finalise(active, shell.id);
    }
  }

  /**
   * Put this turn's attachments where the agent can read them, make the folder it
   * writes back into, and build the prompt that names both.
   *
   * A failure here never fails the run: the turn still happens, without files, and the
   * reason is logged. Losing a conversation because a disk was full would be worse
   * than losing the attachment that came with it.
   */
  private prepareFiles(
    scope: EngineScope,
    workingDir: string | null,
    runRow: RunRow,
  ): { files: AgentFileExchange; prompt: AgentPromptBlock[] } | null {
    const { store, ports, log } = this.deps;
    if (!workingDir) return null;
    try {
      const folders = ensureRunFolders(workingDir, runRow.id);
      const files: AgentFileExchange = { inputDir: folders.in, outputDir: folders.out };
      return {
        files,
        prompt: promptOf(store, scope.workspace, runRow, {
          attachments: ports.attachments,
          files,
        }),
      };
    } catch (error) {
      log.warn(
        { err: error, runId: runRow.id, workingDir },
        'sessions: the run works without file exchange',
      );
      return null;
    }
  }

  /**
   * Everything the agent wrote into this run's output folder becomes an attachment on
   * the reply, so the person can download it. What the caps refused is named in the
   * message rather than dropped in silence.
   */
  private async collectProduced(
    run: ActiveRun,
  ): Promise<{ parts: MessagePart[]; ids: string[]; refused: ProducedRefusal[] }> {
    const empty = {
      parts: [] as MessagePart[],
      ids: [] as string[],
      refused: [] as ProducedRefusal[],
    };
    if (!run.outputs) return empty;
    const collected = run.outputs.collect();
    if (collected.files.length === 0 && collected.refused.length === 0) return empty;
    const parts: MessagePart[] = [];
    const ids: string[] = [];
    for (const file of collected.files) {
      try {
        const attachment = await this.deps.ports.attachments.capture(
          { workspace: run.scope.workspace, userId: run.scope.userId },
          file,
          run.state.messageId,
        );
        parts.push(
          attachment.kind === 'image'
            ? { type: 'image', attachmentId: attachment.id }
            : attachment.kind === 'audio'
              ? { type: 'audio', attachmentId: attachment.id }
              : { type: 'file', attachmentId: attachment.id },
        );
        ids.push(attachment.id);
      } catch (error) {
        this.deps.log.warn(
          { err: error, runId: run.runId, file: file.relativePath },
          'sessions: a produced file could not be stored',
        );
        collected.refused.push({
          relativePath: file.relativePath,
          reason: 'too_large',
          sizeBytes: file.sizeBytes,
        });
      }
    }
    return { parts, ids, refused: collected.refused };
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
          // A skill the agent loaded is a use of it (contract decision §50).
          if (action.type === 'tool_completed') {
            const skill = skillUseOf(call);
            if (skill) {
              try {
                audit.recordSkillUse({
                  workspace: scope.workspace,
                  ownerId: scope.userId,
                  runId: run.runId,
                  sessionId,
                  agentId: run.agent.id,
                  skill,
                });
              } catch (error) {
                // A count nobody could write is not worth failing a run over.
                this.deps.log.warn(
                  { err: error, runId: run.runId },
                  'sessions: skill use not recorded',
                );
              }
            }
          }
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
          if (action.type === 'approval_requested' && approval.expiresAt !== null) {
            this.expireLater(run, approval.id, approval.expiresAt);
          }
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
  private async finalise(run: ActiveRun, messageId: string): Promise<void> {
    const { store, audit } = this.deps;
    const { scope, state } = run;
    const status = state.status;
    const terminal = isTerminal(status) ? status : 'failed';

    // Before anything is awaited: the run has left `active`, and a trajectory read in the
    // meantime must find its turns on the row.
    store.updateRun(scope.workspace, run.runId, { timing: { turns: state.turns } });

    const produced = await this.collectProduced(run);
    const note = refusalNote(produced.refused, scope.language);
    const text = note ? [state.text, note].filter(Boolean).join('\n\n') : state.text;

    const message = store.updateMessage(scope.workspace, messageId, {
      content: text,
      parts: [...(text ? [{ type: 'text', text } as MessagePart] : []), ...produced.parts],
      attachmentIds: produced.ids,
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
        preview: preview(text) ?? session.preview,
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
    // Tell the person. Not for a run they cancelled themselves — they were watching — and
    // never in a way that can fail the run, which is why it is wrapped.
    if (terminal !== 'cancelled') {
      this.tell(() =>
        this.deps.ports.notifier.runFinished({
          workspace: scope.workspace,
          profile: scope.profile,
          userId: scope.userId,
          sessionId: run.sessionId,
          sessionTitle: session?.title ?? '',
          agentName: run.agent.name,
          outcome: terminal === 'succeeded' ? 'succeeded' : 'failed',
          reason: state.error?.message ?? null,
        }),
      );
    }
    // The session names itself from its first exchange (decision §26). After the run, not
    // inside it: `schedule` returns at once and the work is tracked separately.
    if (terminal === 'succeeded') this.namer.schedule(scope, run.sessionId);
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

  /**
   * A notice must never break a run. Anything the notifier throws is logged and dropped,
   * because the run's outcome is the truth and the notice is a courtesy about it.
   */
  private tell(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.deps.log.warn({ err: error }, 'notice not delivered');
    }
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
      : agentRefOf(this.deps.store, scope.workspace, row.runId ?? '');
    const payload = {
      approval: toApproval(
        { row, sessionId, messageId: run?.state.messageId ?? null, agent },
        scope.profile,
      ),
    };
    // Profile-wide (the pending-actions bar shows it from any screen), and
    // journaled under the session so a reconnecting client is told about it.
    this.deps.realtime.emitToProfileFor(scope.profile, sessionId, event, payload);
    // An approval is the one event that stops the work until somebody answers, so it is
    // also the one worth a notice — and only when it is raised, not when it is resolved.
    if (event === 'approval.requested') {
      this.tell(() =>
        this.deps.ports.notifier.approvalRequested({
          workspace: scope.workspace,
          profile: scope.profile,
          userId: scope.userId,
          sessionId,
          agentName: agent?.name ?? '',
          what: row.title,
        }),
      );
    }
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
        attachments:
          row.attachmentIds.length > 0
            ? this.deps.ports.attachments.resolve(scope.workspace, row.attachmentIds)
            : undefined,
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

/**
 * The prompt handed to the adapter: the content blocks of the trigger message.
 *
 * With a file exchange (`exchange`), every attachment is first copied into the run's
 * input folder and then carried as a block that names both its id and its path, so an
 * adapter whose wire is text — Hermes's `POST /v1/runs` — can still hand the agent
 * something it can open. Attachments the registry no longer has are named by id and
 * not invented.
 */
function promptOf(
  store: SessionsStore,
  workspace: string,
  run: RunRow,
  exchange?: { attachments: AttachmentsPort; files: AgentFileExchange },
): AgentPromptBlock[] {
  if (!run.triggerMessageId) return [];
  const message = store.getMessage(workspace, run.triggerMessageId);
  if (!message) return [];

  const wanted = message.parts
    .filter((part) => part.type === 'image' || part.type === 'file' || part.type === 'audio')
    .map((part) => (part as { attachmentId: string }).attachmentId);
  const landed = new Map<string, { name: string; path: string; mime: string; sizeBytes: number }>();
  if (exchange && wanted.length > 0) {
    for (const file of exchange.attachments.materialise(
      workspace,
      wanted,
      exchange.files.inputDir,
    )) {
      landed.set(file.id, file);
    }
  }

  const blocks: AgentPromptBlock[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio') continue;
    const file = landed.get(part.attachmentId);
    blocks.push({
      type: 'attachment',
      attachmentId: part.attachmentId,
      kind: part.type,
      ...(file
        ? { name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, path: file.path }
        : {}),
    });
  }
  if (blocks.length === 0 && message.content) blocks.push({ type: 'text', text: message.content });
  return blocks;
}

/**
 * What the reply says about files the caps refused.
 *
 * It is appended to the assistant's own text, in the language of the request, because
 * "where is my file?" must never be answered by an empty space (TEAM-RULES §4: no
 * silent dead end).
 */
export function refusalNote(refused: readonly ProducedRefusal[], language: Language): string {
  if (refused.length === 0) return '';
  const names = refused.map((item) => item.relativePath).join('، ');
  return t('sessions.produced_refused', language).replace('{files}', names);
}

export const TIMEOUT = Symbol('agent-timeout');

/**
 * Yields the adapter's events, or `TIMEOUT` once `ms` pass with silence —
 * the `streaming -> timed_out` arrow of the run state machine. While `paused()` says
 * the run is waiting on a person, the silence is theirs and the clock starts again.
 */
export async function* withTimeout(
  source: AsyncIterable<AgentEvent>,
  ms: number,
  paused: () => boolean = () => false,
): AsyncGenerator<AgentEvent | typeof TIMEOUT> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof TIMEOUT>((resolve) => {
      const arm = () => {
        timer = setTimeout(() => (paused() ? arm() : resolve(TIMEOUT)), ms);
        timer.unref?.();
      };
      arm();
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
