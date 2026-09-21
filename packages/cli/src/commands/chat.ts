// chat SESSION_ID — the streamed conversation: `sessions.createRun` over HTTP, the session's
// events over `/rt/sessions` with `after_seq` resume, approvals answered through
// `sessions.respondApproval`, Ctrl+C mapped to `sessions.cancelRun`.
import { HubApiError } from '@majlis/contracts';
import type { Socket } from 'socket.io-client';
import type { CommandSpec } from '../args.js';
import {
  belongsToSession,
  initialState,
  reduce,
  sessionTitle,
  type Chunk,
  type TranscriptOptions,
  type TranscriptState,
} from '../chat/transcript.js';
import type { CommandContext } from '../context.js';
import { CliError, UsageError, describeError } from '../errors.js';
import type { AuthenticatedClient } from '../client.js';
import {
  EnvelopeValidator,
  SESSIONS_NAMESPACE,
  connectNamespace,
  isEnvelope,
  subscribe,
  type Envelope,
} from '../realtime.js';
import {
  DECISIONS,
  DECISION_OF,
  parseAnswer,
  parseDecision,
  type Decision,
} from '../chat/approvals.js';
import type { Approval, ApprovalDecision, SessionDetail } from '../types.js';
import { optionEnum, optionInteger, optionString, requireSession } from './shared.js';

const SESSION_EVENTS = [
  'session.created',
  'session.updated',
  'session.deleted',
  'message.created',
  'message.delta',
  'reasoning.delta',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'run.queued',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'approval.requested',
  'approval.resolved',
  'context.updated',
] as const;

type Terminal = 'succeeded' | 'failed' | 'cancelled' | 'deleted';

export const chatCommand: CommandSpec = {
  path: ['chat'],
  description: 'cmd.chat',
  positionals: [{ name: 'SESSION_ID', description: 'arg.session_id', required: true }],
  options: {
    message: { type: 'string', short: 'm', description: 'option.message', value: 'TEXT' },
    once: { type: 'boolean', description: 'option.once' },
    reasoning: { type: 'boolean', description: 'option.reasoning' },
    approve: { type: 'string', description: 'option.approve', value: 'DECISION' },
    timeout: { type: 'string', description: 'option.timeout', value: 'SECONDS' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const chat = new Chat(ctx);
    try {
      return await chat.run();
    } finally {
      chat.dispose();
    }
  },
};

class Chat {
  private readonly sessionId: string;
  private readonly auth: AuthenticatedClient;
  private readonly json: boolean;
  private readonly validator: EnvelopeValidator | undefined;
  private readonly autoApprove: Decision | undefined;
  private readonly timeoutMs: number;
  private readonly ownMessageIds = new Set<string>();
  private readonly ownTexts = new Set<string>();
  /** Terminal status per run id: a run can end before `waitFor` is reached (fast agents). */
  private readonly finished = new Map<string, Terminal>();
  private readonly options: TranscriptOptions;
  private state: TranscriptState = initialState();
  private socket: Socket | undefined;
  private chain: Promise<void> = Promise.resolve();
  private awaitingRunId: string | null = null;
  private terminal: ((status: Terminal) => void) | undefined;
  private cancelling = false;
  private interrupted = false;
  private detail: SessionDetail | undefined;
  private removeInterrupt: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private fatal: ((error: unknown) => void) | undefined;
  private closing = false;

  constructor(private readonly ctx: CommandContext) {
    this.auth = requireSession(ctx);
    this.sessionId = ctx.positionals[0] ?? '';
    this.json = ctx.globals.json;
    this.validator = ctx.globals.strict ? new EnvelopeValidator() : undefined;
    const approve = optionString(ctx, 'approve');
    this.autoApprove =
      approve === undefined ? undefined : optionEnum(ctx, 'approve', DECISIONS, 'deny');
    this.timeoutMs = optionInteger(ctx, 'timeout', 0, { min: 0, max: 86_400 }) * 1000;
    this.options = {
      sessionId: this.sessionId,
      t: ctx.t,
      style: ctx.out.style,
      showReasoning: ctx.options.reasoning === true,
      ownMessageIds: this.ownMessageIds,
      ownTexts: this.ownTexts,
    };
  }

  async run(): Promise<number> {
    const { ctx } = this;
    const { t } = ctx;
    const once = ctx.options.once === true;
    const message = optionString(ctx, 'message');
    if (once && message === undefined)
      throw new UsageError('usage.missing_argument', { name: '--message' });

    this.detail = (
      await this.auth.client.request('get', '/sessions/{session_id}', {
        params: { session_id: this.sessionId },
      })
    ).data;
    if (!this.json) {
      ctx.out.line(
        ctx.out.style.bold(
          t('chat.header', {
            title: sessionTitle(this.detail, t),
            agent: this.detail.agent_id,
            status: this.detail.status,
          }),
        ),
      );
      if (message === undefined && ctx.prompter.isTTY)
        ctx.out.line(ctx.out.style.dim(t('chat.hint')));
    }

    await this.connect();
    this.removeInterrupt = ctx.prompter.onInterrupt(() => void this.onInterrupt());

    // Decisions the agent was already waiting for before we arrived.
    for (const approval of this.detail.pending_approvals) await this.answerApproval(approval);
    // A run already in flight: follow it to its end before accepting input.
    if (this.detail.active_run_id && this.detail.status !== 'idle') {
      if (!this.json) ctx.out.notice(ctx.out.style.dim(t('chat.waiting_run')));
      await this.waitFor(this.detail.active_run_id);
    }

    let code = 0;
    if (message !== undefined) {
      const status = await this.send(message);
      code = status === 'succeeded' ? 0 : 1;
      if (once || this.interrupted) return code;
    }
    if (this.interrupted) return code;

    for (;;) {
      const line = await ctx.prompter.ask(this.json ? '' : t('chat.prompt'));
      if (line === null || this.interrupted) break;
      const text = line.trim();
      if (text === '') continue;
      const status = await this.send(text);
      code = status === 'succeeded' ? 0 : 1;
      if (status === 'deleted' || this.interrupted) break;
    }
    if (!this.json && ctx.prompter.isTTY) ctx.out.line(ctx.out.style.dim(t('chat.bye')));
    return code;
  }

  /** Socket lifecycle on stderr when MAJLIS_DEBUG is set; for field diagnosis, never for scripts. */
  private debug(message: string): void {
    if (this.ctx.io.env.MAJLIS_DEBUG) this.ctx.out.notice(`[rt] ${message}`);
  }

  dispose(): void {
    this.closing = true;
    this.removeInterrupt?.();
    if (this.timer) clearTimeout(this.timer);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
  }

  // ------------------------------------------------------------ transport

  private connect(): Promise<void> {
    const session = this.auth.session();
    const socket = connectNamespace({
      server: session.server,
      namespace: SESSIONS_NAMESPACE,
      token: session.token,
      profile: this.ctx.globals.profile ?? session.profile,
    });
    this.socket = socket;
    for (const name of SESSION_EVENTS)
      socket.on(name, (envelope: unknown) => this.enqueue(envelope));
    socket.on('disconnect', (reason: string) => {
      this.debug(`disconnected: ${reason}`);
      if (this.closing) return;
      if (!this.json) this.ctx.out.notice(this.ctx.out.style.dim(this.ctx.t('chat.disconnected')));
      // A drop the hub initiated (restart, kicked socket) is not retried by socket.io-client on
      // its own; the session is still ours, so come back and resume like after any other drop.
      if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1_000);
    });
    socket.io.on('reconnect_attempt', (attempt: number) =>
      this.debug(`reconnect attempt ${attempt}`),
    );
    socket.on('connect_error', (error: Error) => this.debug(`connect_error: ${error.message}`));
    let first = true;
    return new Promise<void>((resolve, reject) => {
      socket.on('connect_error', (error: Error) => {
        if (error.message === 'unauthorized' || error.message === 'token_expired') {
          const failure = new CliError('errors.socket', { reason: error.message }, 3);
          if (first) reject(failure);
          else this.fail(failure);
        } else if (first) {
          // No realtime yet: keep trying in the background; HTTP already answered.
          first = false;
          resolve();
        }
      });
      socket.on('connect', () => {
        const initial = first;
        first = false;
        this.debug(`connected ${socket.id ?? ''} (initial=${initial})`);
        void this.resubscribe(initial).then(resolve, (error: unknown) => {
          if (initial) reject(error);
          else this.fail(error);
        });
      });
    });
  }

  /** Subscribe (again) with `after_seq`; a truncated replay means re-reading the session. */
  private async resubscribe(initial: boolean): Promise<void> {
    if (!this.socket) return;
    const afterSeq = this.state.lastSeq;
    const ack = await subscribe(this.socket, this.sessionId, afterSeq);
    this.debug(`subscribe after_seq=${afterSeq}: ${JSON.stringify(ack)}`);
    if (!ack.ok)
      throw new CliError('errors.socket', { reason: `${ack.code ?? '?'}: ${ack.error ?? ''}` });
    if (initial) return;
    if (!this.json)
      this.ctx.out.notice(
        this.ctx.out.style.dim(this.ctx.t('chat.reconnected', { replayed: ack.replayed ?? 0 })),
      );
    if (ack.truncated && afterSeq > 0) await this.resync();
  }

  private async resync(): Promise<void> {
    const { ctx } = this;
    if (!this.json) ctx.out.notice(ctx.out.style.dim(ctx.t('chat.resync')));
    const detail = (
      await this.auth.client.request('get', '/sessions/{session_id}', {
        params: { session_id: this.sessionId },
      })
    ).data;
    this.detail = detail;
    for (const approval of detail.pending_approvals)
      this.enqueueLocal(() => this.answerApproval(approval));
    const waiting = this.awaitingRunId;
    if (
      waiting &&
      detail.active_run_id !== waiting &&
      !detail.runs.some((run) => run.id === waiting)
    ) {
      const run = (
        await this.auth.client.request('get', '/sessions/{session_id}/runs/{run_id}', {
          params: { session_id: this.sessionId, run_id: waiting },
        })
      ).data;
      if (!this.json)
        ctx.out.line(ctx.out.style.dim(ctx.t('chat.run_ended_while_away', { status: run.status })));
      this.finish(
        run.status === 'succeeded'
          ? 'succeeded'
          : run.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      );
    }
  }

  // --------------------------------------------------------------- events

  private enqueue(envelope: unknown): void {
    this.enqueueLocal(() => this.handle(envelope));
  }

  private enqueueLocal(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => this.fail(error));
  }

  private async handle(raw: unknown): Promise<void> {
    if (this.validator) {
      const problems = this.validator.problems(raw);
      if (problems.length > 0)
        throw new CliError('errors.envelope_invalid', {
          event: isEnvelope(raw) ? raw.event : '?',
          problems: problems.join('; '),
        });
    }
    if (!isEnvelope(raw)) return;
    const envelope: Envelope = raw;
    if (this.json) {
      if (belongsToSession(envelope, this.sessionId)) this.ctx.out.jsonLine(envelope);
      this.state = { ...this.state, lastSeq: Math.max(this.state.lastSeq, envelope.seq) };
      await this.act(chunksOf(envelope, this.state, this.options));
      return;
    }
    const { state, chunks } = reduce(this.state, envelope, this.options);
    this.state = state;
    await this.act(chunks);
  }

  private async act(chunks: Chunk[]): Promise<void> {
    for (const chunk of chunks) {
      switch (chunk.kind) {
        case 'text':
          if (!this.json) this.ctx.out.write(chunk.text);
          break;
        case 'line':
          if (!this.json) this.ctx.out.line(chunk.text);
          break;
        case 'approval':
          await this.answerApproval(chunk.approval);
          break;
        case 'run':
          this.finished.set(chunk.run.id, chunk.status);
          if (chunk.run.id === this.awaitingRunId) this.finish(chunk.status);
          break;
        case 'deleted':
          this.finish('deleted');
          break;
      }
    }
  }

  // ------------------------------------------------------------ approvals

  private async answerApproval(approval: Approval): Promise<void> {
    if (approval.status !== 'pending') return;
    const { ctx } = this;
    const { t, out } = ctx;
    const isQuestion = approval.kind === 'question' || approval.answer_mode !== 'choice';
    let decision: ApprovalDecision | null = null;
    let answer: string | null = null;

    if (this.autoApprove !== undefined || !ctx.prompter.isTTY) {
      const auto = this.autoApprove ?? 'deny';
      decision = DECISION_OF[auto];
      out.notice(out.style.yellow(t('chat.approval_auto', { decision })));
    } else {
      out.notice(
        out.style.yellow(
          t('chat.approval_title', { agent: approval.agent.name, title: approval.title }),
        ),
      );
      if (approval.description) out.notice(`  ${approval.description}`);
      if (approval.command)
        out.notice(`  ${t('chat.approval_command', { command: approval.command })}`);
      if (isQuestion) {
        if (approval.choices.length > 0)
          out.notice(`  ${approval.choices.map((c, i) => `[${i + 1}] ${c.label}`).join('  ')}`);
        const reply = (await ctx.prompter.ask(t('chat.approval_answer'))) ?? '';
        answer = parseAnswer(reply, approval.choices);
        if (answer === null) decision = 'deny';
      } else {
        const menu = t(
          approval.allow_always ? 'chat.approval_choices' : 'chat.approval_choices_no_always',
        );
        out.notice(`  ${menu}`);
        for (;;) {
          const reply = (await ctx.prompter.ask(t('chat.approval_choose'))) ?? '4';
          const picked = parseDecision(reply, approval.allow_always);
          if (picked) {
            decision = DECISION_OF[picked];
            break;
          }
          out.notice(`  ${menu}`);
        }
      }
    }
    try {
      await this.auth.client.request('post', '/approvals/{approval_id}/respond', {
        params: { approval_id: approval.id },
        body: { decision, answer },
      });
    } catch (error) {
      // Someone else answered first, or it expired: the resolved event tells the story.
      if (!(error instanceof HubApiError && error.status === 409)) throw error;
    }
  }

  // ----------------------------------------------------------------- runs

  private async send(text: string): Promise<Terminal> {
    const { ctx } = this;
    this.ownTexts.add(text);
    let accepted;
    try {
      accepted = (
        await this.auth.client.request('post', '/sessions/{session_id}/runs', {
          params: { session_id: this.sessionId },
          body: { content: [{ type: 'text', text }], when: 'queue' },
        })
      ).data;
    } catch (error) {
      if (ctx.options.once === true || !(error instanceof HubApiError)) throw error;
      ctx.out.error(describeError(error, ctx.t));
      return 'failed';
    }
    this.ownMessageIds.add(accepted.message_id);
    if (this.json) ctx.out.jsonLine({ accepted });
    return this.waitFor(accepted.run_id);
  }

  private waitFor(runId: string): Promise<Terminal> {
    this.cancelling = false;
    const already = this.finished.get(runId);
    if (already) return Promise.resolve(already);
    this.awaitingRunId = runId;
    return new Promise<Terminal>((resolve, reject) => {
      this.terminal = resolve;
      this.fatal = reject;
      if (this.timeoutMs > 0)
        this.timer = setTimeout(() => {
          reject(new CliError('errors.timeout', { seconds: this.timeoutMs / 1000 }));
        }, this.timeoutMs);
    }).finally(() => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.awaitingRunId = null;
      this.terminal = undefined;
      this.fatal = undefined;
    });
  }

  private finish(status: Terminal): void {
    const resolve = this.terminal;
    this.terminal = undefined;
    resolve?.(status);
  }

  private fail(error: unknown): void {
    const reject = this.fatal;
    this.fatal = undefined;
    if (reject) reject(error);
    else {
      this.ctx.out.error(describeError(error, this.ctx.t));
    }
  }

  private async onInterrupt(): Promise<void> {
    const { ctx } = this;
    const runId = this.awaitingRunId;
    if (runId && !this.cancelling) {
      this.cancelling = true;
      if (!this.json) ctx.out.notice(ctx.out.style.yellow(ctx.t('chat.cancelling')));
      try {
        await this.auth.client.request('post', '/sessions/{session_id}/runs/{run_id}/cancel', {
          params: { session_id: this.sessionId, run_id: runId },
        });
      } catch (error) {
        // Already finished: the terminal event is on its way.
        if (!(error instanceof HubApiError && error.status === 409)) this.fail(error);
      }
      return;
    }
    this.interrupted = true;
    ctx.prompter.close();
    this.finish('cancelled');
  }
}

/** In `--json` mode only approvals and terminal runs need acting on; the text is not rendered. */
function chunksOf(envelope: Envelope, state: TranscriptState, options: TranscriptOptions): Chunk[] {
  const { chunks } = reduce(state, envelope, options);
  return chunks.filter(
    (chunk) => chunk.kind === 'approval' || chunk.kind === 'run' || chunk.kind === 'deleted',
  );
}
