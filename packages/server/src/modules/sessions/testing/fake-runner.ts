/**
 * A scripted `AgentRunner` and `AgentDirectory`, so the streaming path can be
 * exercised end to end before any real adapter exists.
 *
 * This is **test scaffolding that lives in the source tree on purpose**: the
 * `agents` module and its ACP / Hermes adapters are built in a parallel
 * branch, and `sessions` must not wait for them nor import their internals
 * (ARCHITECTURE §Modules). It implements the same `ports.ts` interfaces the
 * real adapter will, so the wiring swap is one line in
 * `src/modules/index.ts` and nothing in this module changes.
 *
 * It is never wired into the default module list — `unavailable.ts` is. A
 * test (or a demo) passes it explicitly to `createSessionsModule`.
 */
import type {
  AgentAskRequest,
  AgentCompressRequest,
  AgentCompressResult,
  AgentDirectory,
  AgentEvent,
  AgentInfo,
  AgentRunAccepted,
  AgentRunInput,
  AgentRunRequest,
  AgentRunner,
} from '../ports.js';

export class FakeAgentDirectory implements AgentDirectory {
  private readonly byId = new Map<string, AgentInfo>();

  constructor(agents: AgentInfo[] = []) {
    for (const agent of agents) this.byId.set(agent.id, agent);
  }

  add(agent: AgentInfo): AgentInfo {
    this.byId.set(agent.id, agent);
    return agent;
  }

  async find(_workspace: string, agentId: string): Promise<AgentInfo | null> {
    return this.byId.get(agentId) ?? null;
  }
}

/** One step of a script: an event to emit, or a pause until a person answers. */
export type ScriptStep = AgentEvent | { type: 'await_input' };

export interface FakeRunnerOptions {
  /** Events for the next run, in order. */
  script?: ScriptStep[];
  /** Throw instead of accepting the turn (tests the `starting -> failed` arrow). */
  failOnStart?: Error;
  /** Do not end the stream on `interrupt()`; used to test the timeout arrow. */
  ignoreInterrupt?: boolean;
  /**
   * Called when the turn is accepted, before its events are read: a test's stand-in
   * for the agent doing work — reading what was put in `request.files.inputDir` and
   * writing into `request.files.outputDir`.
   */
  onStart?(request: AgentRunRequest): void | Promise<void>;
  /**
   * What the agent answers a one-shot question with (`AgentRunner.ask`) — the session
   * title, in the tests that exercise naming. A function may throw to play an agent that
   * refuses; `undefined` leaves the runner without an `ask` at all, which is how a test
   * proves the fallback.
   */
  answer?: string | null | ((request: AgentAskRequest) => string | null | Promise<string | null>);
  /**
   * What `compress` answers (decision §52); a function may throw to play a refusal.
   * `undefined` leaves the runner without `compress`, as an agent that cannot.
   */
  compress?:
    | AgentCompressResult
    | ((request: AgentCompressRequest) => AgentCompressResult | Promise<AgentCompressResult>);
  /** What `steer` answers; `undefined` leaves the runner without `steer`. */
  steer?: 'queued' | 'rejected';
}

interface RunChannel {
  queue: ScriptStep[];
  waiting: ((value: IteratorResult<AgentEvent>) => void)[];
  pending: AgentEvent[];
  closed: boolean;
  blocked: boolean;
}

export class FakeAgentRunner implements AgentRunner {
  readonly started: AgentRunRequest[] = [];
  /** Every one-shot question this runner was asked, in order. */
  readonly asked: AgentAskRequest[] = [];
  readonly inputs: Array<{ runId: string; input: AgentRunInput }> = [];
  readonly interrupted: string[] = [];
  private readonly channels = new Map<string, RunChannel>();
  private script: ScriptStep[];

  /**
   * Assigned, not declared: an adapter with no one-shot surface declares no `ask` at all
   * (the port is optional precisely so that is expressible), and an absent own property
   * is the only faithful way to play one.
   */
  readonly ask?: (request: AgentAskRequest) => Promise<string | null>;
  readonly compress?: (request: AgentCompressRequest) => Promise<AgentCompressResult>;
  readonly steer?: (runId: string, text: string) => Promise<'queued' | 'rejected'>;
  /** Every compression asked for, and every piece of guidance sent, in order. */
  readonly compressed: AgentCompressRequest[] = [];
  readonly steered: Array<{ runId: string; text: string }> = [];

  constructor(private readonly options: FakeRunnerOptions = {}) {
    this.script = [...(options.script ?? [])];
    if (options.answer !== undefined) {
      this.ask = async (request: AgentAskRequest) => {
        this.asked.push(request);
        const answer = options.answer;
        return typeof answer === 'function' ? answer(request) : (answer ?? null);
      };
    }
    const compress = options.compress;
    if (compress !== undefined) {
      this.compress = async (request: AgentCompressRequest) => {
        this.compressed.push(request);
        return typeof compress === 'function' ? compress(request) : compress;
      };
    }
    const steer = options.steer;
    if (steer !== undefined) {
      this.steer = async (runId: string, text: string) => {
        this.steered.push({ runId, text });
        return steer;
      };
    }
  }

  /** Replace the script used by the next `start()`. */
  play(script: ScriptStep[]): void {
    this.script = [...script];
  }

  async start(request: AgentRunRequest): Promise<AgentRunAccepted> {
    if (this.options.failOnStart) throw this.options.failOnStart;
    this.started.push(request);
    await this.options.onStart?.(request);
    this.channels.set(request.runId, {
      queue: [...this.script],
      waiting: [],
      pending: [],
      closed: false,
      blocked: false,
    });
    return {
      agentSessionRef: request.agentSessionRef ?? `fake-session-${request.sessionId}`,
      agentRunRef: `fake-run-${request.runId}`,
    };
  }

  async *stream(runId: string): AsyncIterable<AgentEvent> {
    const channel = this.channels.get(runId);
    if (!channel) return;
    for (;;) {
      this.pump(channel);
      const next = channel.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (channel.closed) return;
      // Blocked on a person: wait for send() or interrupt() to wake us.
      const event = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        channel.waiting.push(resolve);
      });
      if (event.done) return;
      yield event.value;
    }
  }

  async send(runId: string, input: AgentRunInput): Promise<void> {
    this.inputs.push({ runId, input });
    const channel = this.channels.get(runId);
    if (!channel) return;
    channel.blocked = false;
    this.wake(channel);
  }

  async interrupt(runId: string): Promise<void> {
    this.interrupted.push(runId);
    if (this.options.ignoreInterrupt) return;
    const channel = this.channels.get(runId);
    if (!channel) return;
    channel.queue = [];
    channel.blocked = false;
    channel.closed = true;
    channel.pending.push({ type: 'completed' });
    this.wake(channel);
  }

  /** Move script steps into the pending queue until the script blocks or ends. */
  private pump(channel: RunChannel): void {
    while (!channel.blocked && channel.queue.length > 0) {
      const step = channel.queue.shift() as ScriptStep;
      if (step.type === 'await_input') {
        channel.blocked = true;
        return;
      }
      channel.pending.push(step);
    }
    if (!channel.blocked && channel.queue.length === 0) channel.closed = true;
  }

  private wake(channel: RunChannel): void {
    this.pump(channel);
    while (channel.waiting.length > 0 && (channel.pending.length > 0 || channel.closed)) {
      const resolve = channel.waiting.shift();
      if (!resolve) break;
      const next = channel.pending.shift();
      if (next) resolve({ value: next, done: false });
      else resolve({ value: undefined as never, done: true });
    }
  }
}

/** A Hermes-shaped registry entry, the default agent of a fresh hub (ADR 0006). */
export function fakeHermes(id: string): AgentInfo {
  return {
    id,
    name: 'Hermes',
    adapterKind: 'hermes',
    defaultModel: 'hermes-4',
    defaultProvider: 'nous',
    available: true,
  };
}
