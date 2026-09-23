/**
 * Hermes conversations over its TUI gateway (ADR 0013).
 *
 * `python -m tui_gateway.entry` is Hermes's own conversation surface — the one its TUI, its
 * desktop app and its dashboard chat use — spoken as newline-delimited JSON-RPC over stdio
 * (`tui_gateway/AGENTS.md`, `apps/shared/src/gateway-contract.openrpc.json` in Hermes's MIT
 * source). Unlike the API server's run surface it carries the model's reasoning, each
 * tool's arguments and result, and the questions the agent asks.
 *
 * Three kinds of frame arrive on stdout:
 *
 *   {"id": 7, "result": …}                       the answer to one of our calls
 *   {"method": "event", "params": {type, session_id, payload}}
 *   {"id": "srq-3", "method": "clarify", "params": {session_id, …}}
 *                                                 Hermes asking the person; it waits for
 *                                                 our `{"id": "srq-3", "result": …}`
 *
 * One process serves every conversation; each is a live session id inside it, and the
 * stored id (`stored_session_id`) is what continues it after a restart.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { HubError } from '../../../lib/errors.js';
import { EventQueue } from './event-queue.js';
import type { AgentEvent, AgentSession, PromptInput } from './types.js';

type Json = Record<string, unknown>;

export interface TuiFrame {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

/** One running `tui_gateway`, shared by every conversation. */
export interface TuiChannel {
  readonly alive: boolean;
  request(method: string, params: Json): Promise<Json>;
  /** Events and requests for one live session id. Returns the unsubscribe. */
  attach(
    sessionId: string,
    handlers: {
      event(type: string, payload: Json): void;
      request(method: string, params: Json): Promise<Json>;
    },
  ): () => void;
  /** Called once when the process is gone, so its sessions can stop pretending. */
  onExit(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
}

export interface Spawned {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  kill(): void;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface StdioChannelOptions {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injected in tests. */
  spawn?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ) => Spawned;
  /** How long to wait for `gateway.ready` before calls fail. */
  readyTimeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

const defaultSpawn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Spawned =>
  nodeSpawn(command, [...args], {
    env,
    ...(cwd ? { cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcess as unknown as Spawned;

/** The channel over a child's stdio. Calls made before `gateway.ready` wait for it. */
export function stdioTuiChannel(options: StdioChannelOptions): TuiChannel {
  const child = (options.spawn ?? defaultSpawn)(
    options.command,
    options.args,
    options.env,
    options.cwd,
  );
  let alive = true;
  let counter = 0;
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (e: Error) => void }>();
  const sessions = new Map<
    string,
    {
      event(type: string, payload: Json): void;
      request(method: string, params: Json): Promise<Json>;
    }
  >();
  const exitListeners = new Set<(reason: string) => void>();
  let markReady: () => void = () => {};
  let failReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // A rejection nobody awaits yet (the process died before the first call) must not crash.
  ready.catch(() => undefined);
  const readyTimer = setTimeout(
    () => failReady(new Error('the Hermes TUI gateway did not start')),
    options.readyTimeoutMs ?? 60_000,
  );
  readyTimer.unref?.();

  const write = (frame: TuiFrame) => {
    if (!alive) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  };

  const gone = (reason: string) => {
    if (!alive) return;
    alive = false;
    clearTimeout(readyTimer);
    failReady(new Error(reason));
    for (const call of pending.values()) call.reject(new Error(reason));
    pending.clear();
    for (const listener of exitListeners) listener(reason);
  };

  child.on('exit', (code, signal) =>
    gone(`the Hermes TUI gateway exited (${signal ?? `code ${code ?? '?'}`})`),
  );
  // stderr is Hermes's log; kept out of the protocol and out of the hub's own log volume.
  child.stderr?.on('data', () => undefined);

  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame: TuiFrame;
    try {
      frame = JSON.parse(line) as TuiFrame;
    } catch {
      return; // not a protocol line
    }
    if (frame.method === 'event') {
      const params = (frame.params ?? {}) as { type?: string; session_id?: string; payload?: Json };
      if (params.type === 'gateway.ready') {
        clearTimeout(readyTimer);
        markReady();
        return;
      }
      const target = params.session_id ? sessions.get(params.session_id) : undefined;
      target?.event(String(params.type ?? ''), params.payload ?? {});
      return;
    }
    if (frame.method && frame.id !== undefined) {
      // Hermes asks the person something. Nobody attached means nobody can answer: say
      // so at once rather than leave the agent thread blocked until its own timeout.
      const sid = String((frame.params ?? {}).session_id ?? '');
      const target = sessions.get(sid);
      const id = frame.id;
      if (!target) {
        write({ id, error: { code: -32601, message: 'no client is attached to this session' } });
        return;
      }
      target
        .request(frame.method, frame.params ?? {})
        .then((result) => write({ id, result }))
        .catch((error: unknown) =>
          write({
            id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      return;
    }
    if (typeof frame.id === 'number') {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      if (frame.error)
        call.reject(new TuiError(frame.error.code ?? 0, frame.error.message ?? 'error'));
      else call.resolve((frame.result ?? {}) as Json);
    }
  });

  return {
    get alive() {
      return alive;
    },
    async request(method, params) {
      await ready;
      if (!alive) throw new Error('the Hermes TUI gateway is not running');
      const id = ++counter;
      return new Promise<Json>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
    },
    attach(sessionId, handlers) {
      sessions.set(sessionId, handlers);
      return () => {
        if (sessions.get(sessionId) === handlers) sessions.delete(sessionId);
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async close() {
      gone('the Hermes TUI gateway was stopped');
      child.kill();
    },
  };
}

/** An error the gateway answered with, code and all (`4090`: the session is busy elsewhere). */
export class TuiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'TuiError';
  }
}

/** Hermes marks its suggested choice this way; the card shows it, the answer drops it. */
const RECOMMENDED = / \(Recommended\)$/i;
const MAX_OUTPUT = 64 * 1024;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function capped(value: string | null): string | null {
  return value && value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}…` : value;
}

/**
 * One conversation. `open()` creates it — or resumes the stored one this hub kept — before
 * the first turn, because the runner records `id` as soon as the session exists.
 */
export class HermesTuiSession implements AgentSession {
  private readonly queue = new EventQueue();
  private detach: () => void = () => {};
  private stopExit: () => void = () => {};
  private turn: { resolve: (stopReason: string) => void } | null = null;
  private readonly approvals = new Map<string, (choice: string) => void>();
  private readonly questions = new Map<string, (answer: string | null) => void>();
  private readonly openTools: Array<{ id: string; name: string }> = [];
  private counter = 0;
  private isClosed = false;

  /** What this conversation is running on, so a turn that names something else switches. */
  private current: { model: string | null; provider: string | null; effort: string | null } = {
    model: null,
    provider: null,
    effort: null,
  };

  private constructor(
    private readonly channel: TuiChannel,
    private readonly liveId: string,
    private readonly storedId: string,
  ) {}

  /**
   * `sessionRef` is the stored id this conversation had, or `null` for a new one. A stored
   * id Hermes no longer knows starts a fresh conversation rather than failing the turn.
   */
  static async open(
    channel: TuiChannel,
    sessionRef: string | null,
    options: {
      model?: string | null;
      provider?: string | null;
      reasoningEffort?: string | null;
    } = {},
  ): Promise<HermesTuiSession> {
    let result: Json | null = null;
    if (sessionRef) {
      try {
        result = await channel.request('session.resume', {
          session_id: sessionRef,
          omit_messages: true,
        });
      } catch {
        result = null;
      }
    }
    if (!result?.session_id) {
      result = await channel.request('session.create', {
        source: 'majlis',
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.reasoningEffort && options.reasoningEffort !== 'none'
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      });
    }
    const liveId = String(result.session_id);
    const storedId = String(result.stored_session_id ?? sessionRef ?? liveId);
    const session = new HermesTuiSession(channel, liveId, storedId);
    session.current = {
      model: options.model ?? null,
      provider: options.provider ?? null,
      effort: options.reasoningEffort ?? null,
    };
    session.detach = channel.attach(liveId, {
      event: (type, payload) => session.onEvent(type, payload),
      request: (method, params) => session.onRequest(method, params),
    });
    session.stopExit = channel.onExit((reason) => session.onExit(reason));
    return session;
  }

  get id(): string {
    return this.storedId;
  }

  get closed(): boolean {
    return this.isClosed || !this.channel.alive;
  }

  stream(): AsyncIterable<AgentEvent> {
    return this.queue.iterator();
  }

  async send(prompt: PromptInput): Promise<{ stopReason: string }> {
    if (this.closed) throw new HubError('state_invalid', { message: 'Hermes session is closed' });
    if (this.turn) throw new HubError('already_running', { details: { session: this.storedId } });
    const done = new Promise<string>((resolve) => {
      this.turn = { resolve };
    });
    try {
      await this.select(prompt);
      await this.channel.request('prompt.submit', { session_id: this.liveId, text: prompt.text });
    } catch (error) {
      this.turn = null;
      throw error;
    }
    const stopReason = await done;
    return { stopReason };
  }

  /**
   * The model and reasoning effort are per turn in the hub (the composer can change them
   * between messages). Hermes keeps them per session, so a turn that names something else
   * switches this session first — `--session`, so Hermes's own default stays as it is.
   */
  private async select(prompt: PromptInput): Promise<void> {
    const model = prompt.model ?? null;
    const provider = prompt.modelProvider ?? null;
    if (model && (model !== this.current.model || provider !== this.current.provider)) {
      await this.channel.request('config.set', {
        session_id: this.liveId,
        key: 'model',
        value: `${model}${provider ? ` --provider ${provider}` : ''} --session`,
      });
      this.current.model = model;
      this.current.provider = provider;
    }
    const effort = prompt.reasoningEffort ?? null;
    if (effort && effort !== 'none' && effort !== this.current.effort) {
      await this.channel.request('config.set', {
        session_id: this.liveId,
        key: 'reasoning',
        value: effort,
        scope: 'session',
      });
      this.current.effort = effort;
    }
  }

  async respond(approvalId: string, optionId: string): Promise<void> {
    const answer = this.approvals.get(approvalId);
    if (!answer) throw new HubError('state_invalid', { details: { reason: 'unknown_approval' } });
    this.approvals.delete(approvalId);
    answer(optionId);
  }

  async answer(questionId: string, reply: string | null): Promise<void> {
    const answer = this.questions.get(questionId);
    if (!answer) throw new HubError('state_invalid', { details: { reason: 'unknown_question' } });
    this.questions.delete(questionId);
    answer(reply);
  }

  async interrupt(): Promise<void> {
    if (!this.turn || this.closed) return;
    await this.channel
      .request('session.interrupt', { session_id: this.liveId })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.detach();
    this.stopExit();
    if (this.channel.alive) {
      await this.channel
        .request('session.close', { session_id: this.liveId })
        .catch(() => undefined);
    }
    this.queue.end();
  }

  // ------------------------------------------------------------ from Hermes

  private onEvent(type: string, payload: Json): void {
    switch (type) {
      case 'message.delta': {
        const delta = text(payload.text);
        if (delta) this.queue.push({ type: 'message.delta', text: delta });
        return;
      }
      case 'reasoning.delta': {
        // The model's own reasoning. `reasoning.available` is not: it is the reply's text
        // again (`_relay_thinking`), and `thinking.delta` is a decorative status line.
        const delta = text(payload.text);
        if (delta) this.queue.push({ type: 'reasoning.delta', text: delta });
        return;
      }
      case 'tool.start': {
        const id = String(payload.tool_id ?? `tool-${++this.counter}`);
        const name = String(payload.name ?? 'tool');
        this.openTools.push({ id, name });
        const preview = text(payload.context) ?? text(payload.preview);
        this.queue.push({
          type: 'tool.started',
          id,
          name,
          title: preview ?? name,
          kind: name,
          input: (payload.args as Json | null) ?? (preview ? { preview } : {}),
          raw: payload,
        });
        return;
      }
      case 'tool.complete': {
        const id = String(payload.tool_id ?? '');
        const at = this.openTools.findIndex((tool) => tool.id === id);
        if (at >= 0) this.openTools.splice(at, 1);
        const result = payload.result as Json | null | undefined;
        const failed =
          !!result &&
          typeof result === 'object' &&
          (result.success === false || (typeof result.error === 'string' && result.error !== ''));
        this.queue.push({
          type: failed ? 'tool.failed' : 'tool.completed',
          id,
          title: String(payload.name ?? 'tool'),
          output: capped(text(payload.result_text) ?? text(payload.summary) ?? text(result)),
          raw: payload,
        });
        return;
      }
      case 'message.complete':
        this.finish(payload);
        return;
      case 'error': {
        // An error with no turn in flight is Hermes talking about the session, not a run.
        if (!this.turn) return;
        this.queue.push({
          type: 'run.failed',
          error: text(payload.message) ?? 'Hermes reported an error',
        });
        this.end('failed');
        return;
      }
      default:
        return;
    }
  }

  private finish(payload: Json): void {
    const usage = (payload.usage ?? null) as Json | null;
    if (usage) {
      const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
      const input = number(usage.input) || number(usage.prompt);
      const output = number(usage.output) || number(usage.completion);
      this.queue.push({
        type: 'usage',
        modelLabel: text(usage.model),
        providerId: null,
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
        ...(number(usage.reasoning) ? { reasoningTokens: number(usage.reasoning)! } : {}),
      });
    }
    const status = String(payload.status ?? 'complete');
    if (status === 'complete' || status === 'completed') {
      this.queue.push({ type: 'run.completed', stopReason: 'completed' });
      this.end('completed');
    } else if (status === 'interrupted' || status === 'cancelled') {
      this.queue.push({ type: 'run.completed', stopReason: 'cancelled', interrupted: true });
      this.end('cancelled');
    } else {
      this.queue.push({
        type: 'run.failed',
        error: text(payload.failure_reason) ?? text(payload.error) ?? `the turn ended ${status}`,
      });
      this.end('failed');
    }
  }

  private async onRequest(method: string, params: Json): Promise<Json> {
    if (method === 'approval') {
      const id = String(params.request_id ?? `approval-${++this.counter}`);
      const offered = Array.isArray(params.choices)
        ? params.choices.filter((c): c is string => typeof c === 'string')
        : ['once', 'deny'];
      const last = this.openTools[this.openTools.length - 1];
      const choice = new Promise<string>((resolve) => this.approvals.set(id, resolve));
      this.queue.push({
        type: 'approval.requested',
        id,
        title: text(params.description) || text(params.command) || 'Hermes needs your approval',
        description: text(params.description),
        command: text(params.command),
        toolId: last?.id ?? null,
        options: offered.map((value) => ({ id: value, label: value, kind: value })),
      });
      return { choice: await choice };
    }
    if (method === 'clarify') {
      const id = `question-${++this.counter}`;
      const choices = Array.isArray(params.choices)
        ? params.choices.filter((c): c is string => typeof c === 'string')
        : [];
      const asking = [...this.openTools].reverse().find((tool) => tool.name === 'clarify');
      const reply = new Promise<string | null>((resolve) => this.questions.set(id, resolve));
      this.queue.push({
        type: 'question.asked',
        id,
        question: text(params.question) ?? '',
        choices,
        toolId: asking?.id ?? null,
      });
      const answer = await reply;
      // Hermes defines skip as the empty answer; a chosen label loses the "(Recommended)"
      // mark Hermes itself added to it.
      return { answer: answer === null ? '' : answer.replace(RECOMMENDED, '') };
    }
    // Secrets, sudo, the desktop's own bridges: nothing in the hub can answer them, and
    // an unanswered request blocks the agent until its timeout. Refuse at once.
    throw new Error(`the hub cannot answer "${method}"`);
  }

  private onExit(reason: string): void {
    if (this.turn) this.queue.push({ type: 'run.failed', error: reason });
    this.end('failed');
    this.isClosed = true;
    for (const answer of this.questions.values()) answer(null);
    this.questions.clear();
  }

  private end(stopReason: string): void {
    const turn = this.turn;
    this.turn = null;
    this.openTools.length = 0;
    turn?.resolve(stopReason);
  }
}
