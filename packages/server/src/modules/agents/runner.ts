/**
 * `AgentRunner` — the `sessions` port (`start`, `stream`, `send`, `interrupt`) on top of
 * the adapters (ADR 0002).
 *
 * One hub session maps to one live `AgentSession` (an ACP child process, or a Hermes
 * conversation keyed by its `session_id`); one hub run maps to one turn of it. The
 * sessions engine runs a session's turns strictly one after another, so a turn can read
 * the session's shared event stream until its own terminal event and leave nothing
 * behind for the next.
 *
 * The runner also owns the translation from an adapter's coarse events
 * (`adapters/types.ts`) to the sessions module's (`ports.ts`), which is what the engine
 * folds into the contract's `/rt/sessions` events. That translation is a pure function
 * (`toRunnerEvent`) so a test can assert it frame by frame.
 *
 * Approvals: an adapter names its choices in the agent's words (`once`, `allow_always`,
 * …); the runner exposes them to the contract as `approve_once` / `approve_session` /
 * `approve_always` / `deny` and remembers, per approval, which agent option each decision
 * stands for, so `send()` can hand the agent exactly the option it offered.
 */
import { derived } from '@corehub/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HubError, agentUnavailable } from '../../lib/errors.js';
import type { AdapterSet } from './adapters/index.js';
import {
  OneshotUnavailable,
  type AgentEvent,
  type AgentSession,
  type ApprovalOption,
  type PromptInput as RunnerPromptInput,
} from './adapters/types.js';
import type {
  AgentRunnerPort,
  RunnerAskRequest,
  RunnerApprovalKind,
  RunnerChoice,
  RunnerCompressRequest,
  RunnerCompressResult,
  RunnerDecision,
  RunnerEvent,
  RunnerFileExchange,
  RunnerPromptBlock,
  RunnerRunAccepted,
  RunnerRunInput,
  RunnerRunRequest,
  RunnerSubagentControl,
  RunnerSubagentSignal,
  RunnerToolKind,
} from './ports.js';
import type { AgentsService } from './service.js';
import type { RunLeases } from './hub-tools/leases.js';

/**
 * How long a question waits for the person (owner decision, 2026-09-23: five minutes, as in
 * Ekko). The card shows it counting down; at zero the hub answers Hermes with a skip.
 */
export const QUESTION_WAIT_MS = 5 * 60_000;

/**
 * The ceiling for a one-shot's answer. A title is a handful of tokens; the rest is room for a
 * model that reasons before it answers and counts that against the same limit.
 */
export const ASK_MAX_TOKENS = 512;

/** How a hub decision maps onto the options an agent offered, per approval. */
type DecisionMap = Map<RunnerDecision, string>;

interface LiveSession {
  session: AgentSession;
  adapterKind: string;
  /** The registry row it runs, so an update can retire the sessions of that agent. */
  agentId: string;
  /** Set when the agent was updated under a running turn: closed as soon as it ends. */
  retire?: boolean;
  /** The hub session the agent session serves; the map key, kept for logging. */
  sessionId: string;
  /** Stops forwarding its subagent reports (§56). */
  unwatch: () => void;
}

interface LiveRun {
  runId: string;
  sessionId: string;
  live: LiveSession;
  queue: RunnerEvent[];
  waiting: ((result: IteratorResult<RunnerEvent>) => void)[];
  ended: boolean;
  interruptRequested: boolean;
  decisions: Map<string, DecisionMap>;
  /** Questions the agent asked in this run and still waits on (`question.asked`). */
  questions: Set<string>;
  /** Tools in flight, by id, so an end can be matched to what started. */
  tools: Map<string, { name: string; input: unknown }>;
  /** Where files for the person go this turn (`sessions`' output folder), if anywhere. */
  outputDir: string | null;
}

export interface AgentRunnerDeps {
  service: AgentsService;
  adapters: AdapterSet;
  log: FastifyBaseLogger;
  /** Who each live run acts for, for the hub's own tools (`hub-tools/leases.ts`). */
  leases?: RunLeases;
}

export class AgentRunner implements AgentRunnerPort {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly runs = new Map<string, LiveRun>();
  private readonly subagentListeners = new Set<
    (sessionId: string, signal: RunnerSubagentSignal) => void
  >();

  constructor(private readonly deps: AgentRunnerDeps) {}

  async start(request: RunnerRunRequest): Promise<RunnerRunAccepted> {
    const { service } = this.deps;
    const row = await this.readyRow(request.agentId);
    if (row.installState !== 'installed') {
      throw agentUnavailable({ agent_id: row.id, status: row.installState });
    }

    // Resolved every turn, not only when the conversation opens. The composer can change
    // the model between turns, and a live Hermes session is deliberately never evicted —
    // so a selection read once at `start()` would pin the conversation to its first model
    // for the life of the process (the defect of 2026-09-22).
    const selection = service.selectionFor(row, request.workspace, {
      model: request.model,
      provider: request.provider,
    });

    const live = await this.open(row, request);

    const run: LiveRun = {
      runId: request.runId,
      sessionId: request.sessionId,
      live,
      queue: [],
      waiting: [],
      ended: false,
      interruptRequested: false,
      decisions: new Map(),
      questions: new Set(),
      tools: new Map(),
      outputDir: request.files?.outputDir ?? null,
    };
    this.runs.set(request.runId, run);
    // From here until the run ends, a call to the hub's own tools from this profile may act
    // for the run's owner (contract decision §67).
    this.deps.leases?.open({
      runId: request.runId,
      sessionId: request.sessionId,
      workspaceId: request.workspace,
      userId: request.userId ?? null,
    });

    // The turn: events are pumped from the session stream while `send()` drives the agent.
    // Neither is awaited here — the engine consumes `stream()` and `send()` resolves on the
    // agent's own terms.
    void this.pump(run);
    const prompt: RunnerPromptInput = {
      text: promptText(request.prompt, request.files),
      // The same turn, unflattened, for an adapter that carries the bytes itself
      // instead of pointing an agent at a path (`adapters/direct.ts`).
      blocks: request.prompt,
      model: selection.model,
      modelProvider: selection.provider,
      modelProviderId: selection.providerId,
      modelProviderSlug: service.providerSlugOf(request.workspace, selection),
      fallbacks: service.fallbacksFor(request.workspace, selection),
      reasoningEffort: request.reasoningEffort,
    };
    void live.session.send(prompt).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'the agent refused the turn';
      const code = error instanceof HubError ? error.code : 'agent_error';
      this.push(run, {
        type: 'failed',
        // A refusal that is really "nothing is configured" says so, whichever side of the
        // wire noticed it: Hermes answers 4xx here and streams the same text there.
        code: code === 'agent_error' ? failureCode(message) : code,
        message,
      });
    });

    return { agentSessionRef: live.session.id, agentRunRef: null };
  }

  /**
   * The conversation's live agent session, opened (or reopened by its stored ref) when there
   * is none. A run and a compression of the same hub session share it.
   */
  private async open(
    row: ReturnType<AgentsService['loadAgent']>,
    request: Pick<
      RunnerRunRequest,
      | 'sessionId'
      | 'workspace'
      | 'agentSessionRef'
      | 'workingDir'
      | 'model'
      | 'provider'
      | 'reasoningEffort'
    >,
  ): Promise<LiveSession> {
    const { service, adapters } = this.deps;
    let live = this.sessions.get(request.sessionId);
    if (live && isClosed(live.session)) {
      // Its process went away between turns — a Hermes TUI gateway retired after a key
      // change and closed once idle: reopen by the stored ref rather than hand the turn to
      // a session that can only refuse it ("Hermes session is closed").
      live.unwatch();
      this.sessions.delete(request.sessionId);
      live = undefined;
    }
    if (!live) {
      const target = service.targetFor(row, request.workspace, {
        sessionRef: request.agentSessionRef ?? mintSessionRef(row.adapterKind, request.sessionId),
        cwd: request.workingDir,
        model: request.model,
        provider: request.provider,
        reasoningEffort: request.reasoningEffort,
      });
      const session = await adapters.byKind(row.adapterKind).start(target);
      const sessionId = request.sessionId;
      // A subagent's reports are the conversation's, not the turn's: forwarded as they come,
      // between turns too (Hermes's asynchronous delegation).
      const unwatch =
        session.subagents?.watch((signal) => {
          for (const listener of this.subagentListeners) listener(sessionId, signal);
        }) ?? (() => undefined);
      live = { session, adapterKind: row.adapterKind, agentId: row.id, sessionId, unwatch };
      this.sessions.set(request.sessionId, live);
    }
    return live;
  }

  /**
   * Compress the conversation's context between turns (decision §57). The agent session is
   * the one the next run would use, so what is compressed is what the next turn reads.
   */
  async compress(request: RunnerCompressRequest): Promise<RunnerCompressResult> {
    const row = this.deps.service.loadAgent(request.agentId);
    if (row.installState !== 'installed') {
      throw agentUnavailable({ agent_id: row.id, status: row.installState });
    }
    if (!row.capabilities.includes('compress')) throw commandUnsupported('compress', row.id);
    const live = await this.open(row, request);
    if (!live.session.compress) throw commandUnsupported('compress', row.id);
    const outcome = await live.session.compress(request.focus);
    return { agentSessionRef: live.session.id, ...outcome };
  }

  /** Guidance into the run in flight (`sessions.steerRun`); the run is not interrupted. */
  async steer(runId: string, text: string): Promise<'queued' | 'rejected'> {
    const run = this.runs.get(runId);
    if (!run || run.ended) {
      throw new HubError('state_invalid', { details: { reason: 'run_not_live', runId } });
    }
    if (!run.live.session.steer) throw commandUnsupported('steer', run.live.adapterKind);
    return run.live.session.steer(text);
  }

  /**
   * Whether any turn is in flight. The `models` module asks before recycling the agent
   * runtime: a restart mid-turn kills the run the person is watching, and a provider
   * change can wait the few seconds a turn takes (ADR 0010 §Consequences).
   */
  get busy(): boolean {
    return this.runs.size > 0;
  }

  /**
   * Whether a turn of this agent is in flight. The update policy asks before an
   * auto-update: it never replaces an agent's CLI under a running turn
   * (`update-policy.ts`).
   */
  busyFor(agentId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.live.agentId === agentId) return true;
    }
    return false;
  }

  /**
   * After an agent was installed again or updated: its open sessions still run the old
   * process, so each idle one is closed now and each busy one as soon as its turn ends.
   * The next turn opens a fresh session on the new CLI, resuming the conversation by
   * its stored ref.
   */
  retireSessionsOf(agentId: string): void {
    const busy = new Set([...this.runs.values()].map((run) => run.live));
    for (const [sessionId, live] of [...this.sessions.entries()]) {
      if (live.agentId !== agentId) continue;
      if (busy.has(live)) {
        live.retire = true;
        continue;
      }
      live.unwatch();
      this.sessions.delete(sessionId);
      void live.session.close().catch((error: unknown) => {
        this.deps.log.warn({ err: error, sessionId }, 'agents: close after update failed');
      });
    }
  }

  /**
   * The agent's row, once it can run: a turn asked for while the agent is being updated
   * waits for the update to end instead of starting on a CLI that is being replaced
   * (`AgentsService.settled`, bounded by `HOLD_FOR_UPDATE_MS`).
   */
  private async readyRow(agentId: string) {
    const { service } = this.deps;
    const row = service.loadAgent(agentId);
    if (row.installState !== 'updating') return row;
    await service.settled(row.id);
    return service.loadAgent(agentId);
  }

  stream(runId: string): AsyncIterable<RunnerEvent> {
    const run = this.runs.get(runId);
    const next = (): Promise<IteratorResult<RunnerEvent>> => {
      if (!run) return Promise.resolve({ value: undefined as never, done: true });
      const buffered = run.queue.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (run.ended) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((resolve) => run.waiting.push(resolve));
    };
    return { [Symbol.asyncIterator]: () => ({ next }) };
  }

  async send(runId: string, input: RunnerRunInput): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new HubError('state_invalid', { details: { reason: 'run_not_live', runId } });
    if (run.questions.has(input.approvalRef)) {
      // A question: the person's words, or nothing when they skipped it. Skip is "deny"
      // on the wire, because the contract's decisions are the one way to say "no answer".
      const answer = run.live.session.answer;
      if (!answer) {
        throw new HubError('state_invalid', {
          details: { reason: 'answer_not_supported', adapter: run.live.adapterKind },
        });
      }
      run.questions.delete(input.approvalRef);
      const text = input.decision === 'deny' ? null : (input.answer ?? null);
      await answer.call(run.live.session, input.approvalRef, text);
      return;
    }
    const options = run.decisions.get(input.approvalRef);
    if (!options) {
      throw new HubError('state_invalid', {
        details: { reason: 'unknown_approval', approval_ref: input.approvalRef },
      });
    }
    if (!input.decision) {
      // Free-text answers need an agent surface that asks questions; neither ACP's
      // permission request nor Hermes's run approval takes text.
      throw new HubError('state_invalid', {
        details: { reason: 'answer_not_supported', adapter: run.live.adapterKind },
      });
    }
    const optionId = options.get(input.decision) ?? fallbackOption(options, input.decision);
    if (!optionId) {
      throw new HubError('state_invalid', {
        details: { reason: 'decision_not_offered', decision: input.decision },
      });
    }
    await run.live.session.respond(input.approvalRef, optionId);
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.interruptRequested = true;
    await run.live.session.interrupt();
  }

  /**
   * One question answered by the model alone (`RunnerAskRequest`): the hub names a session
   * with it. It is never a turn of an agent that has tools — a title is not worth the risk of
   * a model writing a file or sending a message on its way to six words (the defect of
   * 2026-09-26: every profile tool was offered to the naming request). In order:
   *
   * 1. The agent's own tool-free one-shot on the model of the conversation being named: the
   *    live conversation lends its model when it is open (Hermes: `llm.oneshot` with its
   *    session), else the adapter opens a throwaway one in the same profile and model.
   * 2. Otherwise the conversation's model directly, through the provider the hub knows (the
   *    `builtin` adapter, which offers no tools), when the selection names one.
   * 3. Otherwise `null`, and the caller names the session from its first message.
   *
   * Nothing here produces a `LiveRun`, so `busy` stays false; nothing is put in
   * `this.sessions`; and it is bounded by `timeoutMs` — past it the caller gets `null`.
   */
  async ask(request: RunnerAskRequest): Promise<string | null> {
    const row = await this.readyRow(request.agentId);
    if (row.installState !== 'installed') return null;
    try {
      return await withDeadline(this.askToolFree(row, request), request.timeoutMs);
    } catch (error) {
      this.deps.log.info(
        { err: error, agentId: row.id, sessionId: request.sessionId },
        'agents: the agent answered no question',
      );
      return null;
    }
  }

  private async askToolFree(
    row: ReturnType<AgentsService['loadAgent']>,
    request: RunnerAskRequest,
  ): Promise<string | null> {
    const { service, adapters } = this.deps;
    const oneshot = {
      prompt: request.prompt,
      maxTokens: ASK_MAX_TOKENS,
      timeoutMs: request.timeoutMs,
    };

    const live = this.sessions.get(request.sessionId);
    if (live && !isClosed(live.session) && live.session.oneshot) {
      return live.session.oneshot(oneshot);
    }

    const target = service.targetFor(row, request.workspace, {
      sessionRef: null,
      cwd: null,
      model: request.model,
      provider: request.provider,
      reasoningEffort: null,
    });
    const adapter = adapters.byKind(row.adapterKind);
    if (adapter.oneshot) {
      try {
        return await adapter.oneshot(target, oneshot);
      } catch (error) {
        if (!(error instanceof OneshotUnavailable)) throw error;
      }
    }

    // The conversation's model straight from its provider: the `builtin` adapter is one model
    // request with no tools, whatever agent the conversation itself runs on.
    if (!target.modelProviderId || !target.model) return null;
    const direct = adapters.byKind('builtin');
    const session = await direct.start({
      ...target,
      // The agent's own settings (a system prompt, for the `builtin` agent) are not the question.
      settings: {},
      sessionRef: null,
    });
    let text = '';
    try {
      const collect = (async () => {
        for await (const event of session.stream()) {
          if (event.type === 'message.delta') text += event.text;
          if (event.type === 'run.completed' || event.type === 'run.failed') return;
        }
      })();
      await Promise.all([
        session.send({
          text: request.prompt,
          model: target.model,
          modelProvider: target.modelProvider ?? null,
          modelProviderId: target.modelProviderId,
        }),
        collect,
      ]);
    } finally {
      await session.close().catch(() => undefined);
    }
    return text.trim() === '' ? null : text;
  }

  onSubagent(listener: (sessionId: string, signal: RunnerSubagentSignal) => void): () => void {
    this.subagentListeners.add(listener);
    return () => this.subagentListeners.delete(listener);
  }

  subagents(sessionId: string): RunnerSubagentControl | null {
    const live = this.sessions.get(sessionId);
    const control = live && !isClosed(live.session) ? live.session.subagents : undefined;
    if (!control) return null;
    // Only the verbs: `watch` stays here, where every report is already forwarded.
    return {
      support: control.support,
      ...(control.list ? { list: () => control.list!() } : {}),
      ...(control.interrupt ? { interrupt: (id: string) => control.interrupt!(id) } : {}),
      ...(control.steer ? { steer: (id: string, text: string) => control.steer!(id, text) } : {}),
      ...(control.tail ? { tail: (id: string) => control.tail!(id) } : {}),
    };
  }

  /** Shutdown: end every live agent session (ACP children exit, Hermes streams close). */
  async closeAll(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      open.map((live) =>
        live.session.close().catch((error: unknown) => {
          this.deps.log.warn({ err: error, sessionId: live.sessionId }, 'agents: close failed');
        }),
      ),
    );
    for (const run of this.runs.values()) this.end(run);
    this.runs.clear();
  }

  // -------------------------------------------------------------- internals

  private async pump(run: LiveRun): Promise<void> {
    try {
      for await (const event of run.live.session.stream()) {
        const mapped = this.translate(run, event);
        for (const out of mapped) this.push(run, out);
        if (mapped.some((out) => out.type === 'completed' || out.type === 'failed')) break;
      }
      if (!run.ended) {
        // The session closed under the run (agent exited): the engine reads a silent
        // end as `agent_error` on its own; say why when the adapter told us.
        this.end(run);
      }
    } catch (error) {
      this.push(run, {
        type: 'failed',
        code: 'agent_error',
        message: error instanceof Error ? error.message : 'adapter stream failed',
      });
    }
  }

  private translate(run: LiveRun, event: AgentEvent): RunnerEvent[] {
    if (event.type === 'file.produced') {
      const copied = handOver(event.path, run.outputDir);
      if (copied.ok) {
        this.deps.log.debug({ runId: run.runId, file: copied.path }, 'agents: produced file');
      } else {
        this.deps.log.warn(
          { runId: run.runId, file: event.path, reason: copied.reason },
          'agents: a file the agent produced could not be handed to the reply',
        );
      }
      return [];
    }
    if (event.type === 'tool.started') {
      const started = { name: event.name ?? event.title, input: event.input };
      this.deps.leases?.toolStarted(run.runId, started.name, started.input);
      run.tools.set(event.id, started);
    }
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const started = run.tools.get(event.id);
      this.deps.leases?.toolEnded(run.runId, started?.name, started?.input);
      run.tools.delete(event.id);
    }
    if (event.type === 'question.asked') {
      run.questions.add(event.id);
      return [
        {
          type: 'approval_requested',
          ref: event.id,
          kind: 'question',
          title: event.question,
          description: null,
          command: null,
          // The value is the words: a chosen answer reaches the agent as the text it offered.
          choices: event.choices.map((label) => ({ value: label, label })),
          allowAlways: false,
          // Always a line to write one's own answer, as Hermes's clarify promises.
          answerMode: event.choices.length > 0 ? 'both' : 'text',
          toolRef: event.toolId ?? null,
          // The card counts this down; when it runs out the hub skips the question.
          expiresInMs: QUESTION_WAIT_MS,
        },
      ];
    }
    if (event.type === 'approval.requested') {
      const { choices, decisions } = approvalChoices(event.options);
      run.decisions.set(event.id, decisions);
      return [toRunnerEvent(event, { choices, interruptRequested: run.interruptRequested })];
    }
    return [toRunnerEvent(event, { interruptRequested: run.interruptRequested })].filter(
      (out): out is RunnerEvent => out !== null,
    );
  }

  private push(run: LiveRun, event: RunnerEvent): void {
    if (run.ended) return;
    const waiter = run.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else run.queue.push(event);
    if (event.type === 'completed' || event.type === 'failed') this.end(run);
  }

  private end(run: LiveRun): void {
    if (run.ended) return;
    run.ended = true;
    for (const waiter of run.waiting.splice(0)) waiter({ value: undefined as never, done: true });
    this.runs.delete(run.runId);
    this.deps.leases?.close(run.runId);
    // A session whose process died is not reusable; forget it so the next turn opens a
    // fresh one (an ACP child, or the Hermes TUI gateway). Hermes's HTTP sessions stay.
    if (isClosed(run.live.session)) {
      if (this.sessions.get(run.sessionId) === run.live) run.live.unwatch();
      this.sessions.delete(run.sessionId);
    } else if (run.live.retire && this.sessions.get(run.sessionId) === run.live) {
      // Updated under this turn: the process is the old CLI, so it goes now.
      run.live.unwatch();
      this.sessions.delete(run.sessionId);
      void run.live.session.close().catch(() => undefined);
    }
  }
}

/** The agent has no such command (decision §57): `409 state_invalid`, said plainly. */
function commandUnsupported(command: string, agent: string): HubError {
  return new HubError('state_invalid', {
    details: { reason: 'command_unsupported', command, agent },
  });
}

/** Resolve, or give up. The work behind it is abandoned, never awaited. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        // Optional work: a title still being waited for must never be the reason a
        // process stays alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isClosed(session: AgentSession): boolean {
  const flag = (session as { closed?: unknown }).closed;
  return flag === true;
}

/** Hermes keys a conversation by the id the client chooses: derive it from the hub's. */
export function mintSessionRef(adapterKind: string, sessionId: string): string | null {
  // New conversations say the product's name; one started before the rename keeps the ref it
  // stored (`majlis-…`), which is what Hermes knows it by.
  return adapterKind === 'hermes' ? `${derived.serviceName}-${sessionId.toLowerCase()}` : null;
}

/**
 * Hermes's own words for "this host has no provider to run with", recognised so the hub
 * can answer with a code a client branches on instead of one opaque `agent_error`.
 *
 * Why match on text: the run surface flattens the failure into one string
 * (`gateway/platforms/api_server_runs.py` finishes the run with
 * `"⚠️ Provider authentication failed: {exc}"`), so the `AuthError.code`
 * (`no_provider_configured`, raised in `hermes_cli/auth.py` §`resolve_provider`) never
 * reaches the wire. Both the code token and the sentence it is raised with are matched,
 * because Hermes prints one or the other depending on the surface. Anything we do not
 * recognise stays `agent_error` — the message is never rewritten, only labelled.
 */
const NO_PROVIDER_MARKERS = [
  'no_provider_configured',
  'no inference provider configured',
  // Hermes's own name for "the request went out with no Authorization header at all"
  // (`hermes_cli/auth.py` §_openrouter_auto_detected quotes this exact string as the
  // symptom of a credential that never reached the resolver). It is the upstream's 401,
  // but its cause is entirely ours: the key did not reach the runtime.
  'missing authentication header',
] as const;

/**
 * A key the provider looked at and refused. Different from the above in the one way that
 * matters to the person: the credential *did* travel, so the thing to change is the key,
 * not the workspace's defaults. A 401 on the hub-to-gateway hop never reaches here — the
 * transport turns that into `agent_unavailable` before a run is started.
 */
const REJECTED_KEY_MARKERS = [
  'invalid api key',
  'incorrect api key',
  'no auth credentials found',
  'invalid_api_key',
  'unauthorized',
  'http 401',
  'http 403',
] as const;

export function failureCode(message: string | null | undefined): string {
  const text = (message ?? '').toLowerCase();
  if (NO_PROVIDER_MARKERS.some((marker) => text.includes(marker))) {
    return 'provider_not_configured';
  }
  if (REJECTED_KEY_MARKERS.some((marker) => text.includes(marker))) {
    return 'provider_unauthorized';
  }
  return 'agent_error';
}

export function promptText(blocks: RunnerPromptBlock[], files?: RunnerFileExchange | null): string {
  const parts: string[] = [];
  const attachments: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'attachment') {
      attachments.push(describeAttachment(block));
    } else {
      parts.push(`[location ${block.latitude},${block.longitude}]`);
    }
  }
  if (attachments.length > 0) {
    parts.push(`Attached files (read them from these paths):\n${attachments.join('\n')}`);
  }
  if (files) {
    parts.push(
      `Write any file the user should be able to download into: ${files.outputDir}\n` +
        'Files left there when the turn ends are attached to your reply automatically.',
    );
  }
  return parts.join('\n\n');
}

function describeAttachment(block: Extract<RunnerPromptBlock, { type: 'attachment' }>): string {
  const name = block.name ?? block.attachmentId;
  const facts = [block.mime, block.sizeBytes === undefined ? null : `${block.sizeBytes} bytes`]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(', ');
  const described = facts ? `${name} (${facts})` : name;
  return block.path
    ? `- ${described} — ${block.path}`
    : `- ${described} — [attachment ${block.kind} ${block.attachmentId}, not available on disk]`;
}

const TOOL_KINDS: Array<[RegExp, RunnerToolKind]> = [
  [/^(terminal|shell|bash|execute|command|process)/i, 'shell'],
  [/^(read|read_file|search_files|list|glob|view)/i, 'file_read'],
  [/^(write|write_file|edit|patch|delete|create|move)/i, 'file_write'],
  [/^(search|grep|find)/i, 'search'],
  [/^(web|fetch|browser|http|web_search|web_extract)/i, 'web'],
  [/^mcp/i, 'mcp'],
  [/^(device|phone|camera|location)/i, 'device'],
];

/** The contract's `ToolCall.kind` from the agent's own word for the tool. */
export function toolKindOf(kind: string, name?: string): RunnerToolKind {
  for (const candidate of [kind, name ?? '']) {
    for (const [pattern, mapped] of TOOL_KINDS) if (pattern.test(candidate)) return mapped;
  }
  return 'custom';
}

/** ACP permission kinds and Hermes choices, as hub decisions. */
function decisionOf(option: ApprovalOption): RunnerDecision | null {
  const word = `${option.kind} ${option.id}`.toLowerCase();
  if (/reject|deny|no\b/.test(word)) return 'deny';
  if (/always|permanent/.test(word)) return 'approve_always';
  if (/session/.test(word)) return 'approve_session';
  if (/allow|once|approve|yes\b|accept/.test(word)) return 'approve_once';
  return null;
}

export function approvalChoices(options: ApprovalOption[]): {
  choices: RunnerChoice[];
  decisions: DecisionMap;
} {
  const decisions: DecisionMap = new Map();
  const choices: RunnerChoice[] = [];
  for (const option of options) {
    const decision = decisionOf(option);
    if (!decision || decisions.has(decision)) continue;
    decisions.set(decision, option.id);
    choices.push({ value: decision, label: option.label });
  }
  return { choices, decisions };
}

/** A decision the agent did not offer degrades to the nearest one it did. */
function fallbackOption(options: DecisionMap, decision: RunnerDecision): string | undefined {
  const order: RunnerDecision[] =
    decision === 'deny'
      ? ['deny']
      : decision === 'approve_always'
        ? ['approve_always', 'approve_session', 'approve_once']
        : decision === 'approve_session'
          ? ['approve_session', 'approve_once']
          : ['approve_once'];
  for (const candidate of order) {
    const option = options.get(candidate);
    if (option) return option;
  }
  return undefined;
}

export interface TranslateContext {
  choices?: RunnerChoice[];
  interruptRequested: boolean;
}

/** Adapter event -> sessions event. Pure; `null` when the contract has no event for it. */
export function toRunnerEvent(event: AgentEvent, ctx: TranslateContext): RunnerEvent;
export function toRunnerEvent(event: AgentEvent, ctx: TranslateContext): RunnerEvent | null {
  switch (event.type) {
    case 'message.delta':
      return { type: 'message_delta', text: event.text };
    case 'reasoning.delta':
      return { type: 'reasoning_delta', text: event.text };
    case 'tool.started':
      return {
        type: 'tool_started',
        ref: event.id,
        name: event.name ?? event.title,
        kind: toolKindOf(event.kind, event.name),
        title: event.title,
        input: event.input ?? {},
        subagentId: event.subagentId ?? null,
      };
    case 'tool.completed':
      return {
        type: 'tool_completed',
        ref: event.id,
        output: event.output,
        exitCode: event.exitCode ?? null,
      };
    case 'tool.failed':
      return {
        type: 'tool_failed',
        ref: event.id,
        output: event.output,
        exitCode: event.exitCode ?? null,
      };
    case 'question.asked':
      // Handled by `translate`, which records the question on the run it belongs to.
      return null;
    case 'approval.requested': {
      const choices = ctx.choices ?? approvalChoices(event.options).choices;
      const kind: RunnerApprovalKind = 'tool_call';
      return {
        type: 'approval_requested',
        ref: event.id,
        kind,
        title: event.title,
        description: event.description ?? null,
        command: event.command ?? null,
        choices,
        allowAlways: choices.some((c) => c.value === 'approve_always'),
        answerMode: 'choice',
        toolRef: event.toolId ?? null,
      };
    }
    case 'usage':
      return {
        type: 'usage',
        modelLabel: event.modelLabel ?? null,
        providerId: event.providerId ?? null,
        ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
        ...(event.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: event.cacheWriteTokens }
          : {}),
        ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
        ...(event.costMicroUsd !== undefined ? { costMicroUsd: event.costMicroUsd } : {}),
        // `unknown` stays the default: an adapter that reports tokens and no price has
        // not told us what the turn cost, and zero would be a claim.
        costSource: event.costSource ?? 'unknown',
      };
    case 'context':
      return {
        type: 'context',
        usedTokens: event.usedTokens,
        windowTokens: event.windowTokens ?? null,
        ...(event.estimated ? { estimated: true } : {}),
      };
    case 'compression':
      return { type: 'compression', phase: event.phase };
    case 'run.completed':
      if (event.interrupted && !ctx.interruptRequested) {
        // The agent stopped on its own; the hub never asked. Not a success.
        return { type: 'failed', code: 'cancelled', message: 'the agent cancelled the turn' };
      }
      return { type: 'completed' };
    case 'run.failed':
      // An adapter that made the request itself already knows the code; only the
      // gateway adapters, which get one flattened sentence, have it read out of text.
      return {
        type: 'failed',
        code: event.code ?? failureCode(event.error),
        message: event.error,
      };
    case 'model.fallback':
      return {
        type: 'model_fallback',
        failed: event.failed.map((attempt) => ({ ...attempt })),
        answered: { ...event.answered },
      };
    case 'plan':
      // No `/rt/sessions` event carries a plan yet; it is not a message.
      return null;
    case 'file.produced':
      // Handled by `translate`: the file is copied into the run's output folder, and the
      // engine attaches it to the reply when the run ends.
      return null;
  }
}

/** What an image or other file a tool made is allowed to be before it is handed over. */
const HANDOVER_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Copy a file an agent's own tool produced (`file.produced`) into the run's output folder, where
 * the sessions engine picks up whatever the turn leaves for the person (decision §72: Hermes's
 * `image_generate` saves into its own cache). A copy, so the agent's cache stays as it was; a
 * link, a folder, a file that is gone or too large, or a run without an output folder is refused
 * and said why — the turn itself never fails for it.
 */
export function handOver(
  source: string,
  outputDir: string | null,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!outputDir) return { ok: false, reason: 'no_output_folder' };
  if (!path.isAbsolute(source)) return { ok: false, reason: 'not_absolute' };
  let stats;
  try {
    stats = lstatSync(source);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'not_a_file' };
  if (stats.size > HANDOVER_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const name = path.basename(source);
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  try {
    mkdirSync(outputDir, { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const target = path.join(
        outputDir,
        attempt === 0 ? name : `${stem}-${attempt + 1}${extension}`,
      );
      try {
        copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
        return { ok: true, path: target };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return { ok: false, reason: 'name_taken' };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code ?? 'copy_failed' };
  }
}
