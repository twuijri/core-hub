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
  readonly inputs: Array<{ runId: string; input: AgentRunInput }> = [];
  readonly interrupted: string[] = [];
  private readonly channels = new Map<string, RunChannel>();
  private script: ScriptStep[];

  constructor(private readonly options: FakeRunnerOptions = {}) {
    this.script = [...(options.script ?? [])];
  }

  /** Replace the script used by the next `start()`. */
  play(script: ScriptStep[]): void {
    this.script = [...script];
  }

  async start(request: AgentRunRequest): Promise<AgentRunAccepted> {
    if (this.options.failOnStart) throw this.options.failOnStart;
    this.started.push(request);
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
