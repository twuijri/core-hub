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
 *
 * One process also serves **every profile** (ADR 0014 stage 3). `session.create` and
 * `session.resume` take a `profile`: Hermes then binds that profile's home for the session's
 * build and for every turn — its `config.yaml` (model, providers, MCP), its `.env` over the
 * process environment, `SOUL.md`, `memories/`, skills and its own `state.db` — and a resume
 * looks the stored id up in that profile's store (adopting one left in the default store by
 * an older hub). No `profile` is the process's own home: Hermes's `default`.
 */
import { derived } from '@corehub/contracts';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { HubError } from '../../../lib/errors.js';
import { EventQueue } from './event-queue.js';
import {
  SubagentSignals,
  hermesLiveSubagent,
  hermesSubagentSignal,
  type LiveSubagent,
  type SubagentControl,
  type SubagentTailText,
} from './subagents.js';
import type {
  AgentEvent,
  AgentSession,
  CompressOutcome,
  FallbackModel,
  PromptInput,
} from './types.js';

type Json = Record<string, unknown>;

export interface TuiFrame {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

/** What one live session id hands the channel when it attaches. */
export interface TuiSessionHandlers {
  event(type: string, payload: Json): void;
  request(method: string, params: Json): Promise<Json>;
  /** Whether this conversation has a turn in flight (a question waiting counts). */
  busy?(): boolean;
}

/** One running `tui_gateway`, shared by every conversation. */
export interface TuiChannel {
  readonly alive: boolean;
  /** The process's id, for the Performance screen; absent for a scripted channel. */
  readonly pid?: number | null;
  /**
   * Whether closing it now would cut something short: a conversation on it has a turn in
   * flight, or a call is still waiting for its answer. The runtime asks before it recycles
   * a gateway that was started with keys that have since changed.
   */
  readonly busy: boolean;
  request(method: string, params: Json): Promise<Json>;
  /** Events and requests for one live session id. Returns the unsubscribe. */
  attach(sessionId: string, handlers: TuiSessionHandlers): () => void;
  /** Called once when the process is gone, so its sessions can stop pretending. */
  onExit(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
}

export interface Spawned {
  pid?: number | undefined;
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
  /**
   * How long, after the process exits, to wait for its last stderr lines — Node can report
   * the exit before the pipe is drained, and the line that says why is the last one.
   */
  exitGraceMs?: number;
  log?: (message: string, detail?: unknown) => void;
  /**
   * Every line of the gateway's stderr — Hermes's own log — for the Logs screen's ring
   * (`lib/log-ring.ts`), which is bounded; it still never reaches the hub's log volume.
   */
  onStderrLine?: (line: string) => void;
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
  /** The process is gone and its last stderr lines are being read: accept nothing new. */
  let exiting = false;
  let counter = 0;
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (e: Error) => void }>();
  const sessions = new Map<string, TuiSessionHandlers>();
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
    if (!alive || exiting) return;
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

  // stderr is Hermes's log; kept out of the protocol and out of the hub's own log volume —
  // except the one line the gateway prints on its way out. Every exit path of
  // `tui_gateway/entry.py` is `sys.exit(0)`, so the code says nothing; the reason is the
  // `[gateway-exit] …` or `[gateway-signal] …` line it writes to stderr just before.
  const exitReasons = stderrExitReasons(child.stderr, options.onStderrLine);

  child.on('exit', (code, signal) => {
    const report = () => {
      const why = exitReasons.last();
      const status = signal ?? `code ${code ?? '?'}`;
      gone(`the Hermes TUI gateway exited (${why ? `${status}: ${why}` : status})`);
    };
    if (!alive) return;
    exiting = true;
    exitReasons.drained(options.exitGraceMs ?? 250).then(report, report);
  });
  // A write racing the exit fails with EPIPE; the exit above already says what happened.
  child.stdin.on('error', () => undefined);

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
      return alive && !exiting;
    },
    get pid() {
      return child.pid ?? null;
    },
    get busy() {
      if (!alive || exiting) return false;
      if (pending.size > 0) return true;
      for (const handlers of sessions.values()) if (handlers.busy?.()) return true;
      return false;
    },
    async request(method, params) {
      await ready;
      if (!alive || exiting) throw new Error('the Hermes TUI gateway is not running');
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
      gone(TUI_STOPPED);
      child.kill();
    },
  };
}

/** The reason `close()` gives: the hub stopped the gateway itself, nothing went wrong. */
export const TUI_STOPPED = 'the Hermes TUI gateway was stopped';

const EXIT_MARKER = /^\[gateway-(exit|signal)\]\s*(.*)$/;
/** Enough for "why did it stop"; a marker line is a fixed phrase, never a payload. */
const EXIT_REASONS_KEPT = 3;
const EXIT_REASON_MAX = 200;
/** A line longer than this is Hermes's log, not a marker; it is skipped, not buffered. */
const STDERR_LINE_MAX = 4096;

/**
 * Reads the gateway's stderr for its exit markers, keeping the last few, and hands every
 * line to `onLine` (the Logs screen's bounded ring) — nothing else of the stream is kept or
 * logged, and memory stays bounded however much it writes.
 */
function stderrExitReasons(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine?: (line: string) => void,
): {
  last(): string | null;
  /** Resolves once stderr has ended, or after `graceMs`, whichever is first. */
  drained(graceMs: number): Promise<void>;
} {
  const reasons: string[] = [];
  let ended = !stream;
  const endWaiters: Array<() => void> = [];
  if (stream) {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let skipping = false;
    const line = (text: string) => {
      const trimmed = text.trimEnd();
      if (trimmed && onLine) {
        try {
          onLine(trimmed);
        } catch {
          // the ring is a convenience; the exit reason is not
        }
      }
      const match = EXIT_MARKER.exec(text.trim());
      if (!match) return;
      const detail = (match[2] ?? '').slice(0, EXIT_REASON_MAX);
      reasons.push(match[1] === 'signal' ? `signal ${detail}` : detail);
      if (reasons.length > EXIT_REASONS_KEPT) reasons.shift();
    };
    stream.on('data', (chunk: Buffer | string) => {
      const parts = (carry + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split(
        '\n',
      );
      carry = parts.pop() ?? '';
      for (const part of parts) {
        if (skipping) skipping = false;
        else line(part);
      }
      if (carry.length > STDERR_LINE_MAX) {
        carry = '';
        skipping = true;
      }
    });
    const finish = () => {
      if (ended) return;
      ended = true;
      if (carry && !skipping) line(carry);
      carry = '';
      for (const waiter of endWaiters.splice(0)) waiter();
    };
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  }
  return {
    last: () => reasons[reasons.length - 1] ?? null,
    drained(graceMs) {
      if (ended) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref?.();
        endWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
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

/**
 * The picture Hermes's own `image_generate` tool drew, or null. Its answer is
 * `{"success": true, "image": "<path>", …}` (Hermes's MIT source, `tools/image_generation_tool.py`
 * and `agent/image_gen_provider.py` `success_response`); a backend that saves the file — the
 * hub's `corehub-images` among them — gives an absolute path under Hermes's `cache/images/`,
 * one that answers with a link gives a URL, which is left to the model's words.
 */
export function producedImageOf(tool: string, result: unknown): string | null {
  if (tool !== 'image_generate' || !result || typeof result !== 'object') return null;
  const answer = result as { success?: unknown; image?: unknown };
  if (answer.success !== true || typeof answer.image !== 'string') return null;
  const image = answer.image.trim();
  return image.startsWith('/') ? image : null;
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
  private readonly subagentSignals = new SubagentSignals();
  private counter = 0;
  private isClosed = false;
  /**
   * Hermes reports the usage of its whole live session on every `message.complete` (its
   * counters add up across turns), while a hub run is one turn. What was reported for the
   * earlier turns is kept here and subtracted, so each run records its own tokens.
   */
  private reported = { input: 0, output: 0, reasoning: 0 };

  /**
   * The turn in flight, as the hub asked for it: the model and provider it named, and the
   * fallback chain (contract decision §54), so a switch Hermes makes can be said in the hub's
   * names. `notes` are Hermes's own "Model fallback" lines from this turn.
   */
  private asked: {
    model: string | null;
    provider: string | null;
    slug: string | null;
    fallbacks: readonly FallbackModel[];
    notes: FallbackNote[];
  } = { model: null, provider: null, slug: null, fallbacks: [], notes: [] };

  /** Hermes said it is compressing inside the turn in flight; `finished` is still owed. */
  private compressing = false;

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
      /** The Hermes profile the conversation runs in; absent or `default` = the root home. */
      profile?: string | null;
      /** The conversation's working folder, where its tools run. */
      cwd?: string | null;
    } = {},
  ): Promise<HermesTuiSession> {
    const scope = profileParams(options.profile);
    let result: Json | null = null;
    let resumed = false;
    if (sessionRef) {
      try {
        result = await channel.request('session.resume', {
          session_id: sessionRef,
          omit_messages: true,
          ...scope,
        });
        resumed = !!result?.session_id;
      } catch {
        result = null;
      }
    }
    if (!result?.session_id) {
      result = await channel.request('session.create', {
        source: derived.serviceName,
        ...scope,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.reasoningEffort && options.reasoningEffort !== 'none'
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      });
    }
    const liveId = String(result.session_id);
    const storedId = String(result.stored_session_id ?? sessionRef ?? liveId);
    if (resumed && options.cwd && workingFolderOf(result) !== options.cwd) {
      // A conversation stored before the hub named its folder (or somewhere else) runs its
      // tools where the hub keeps the session's files from now on. Best effort: a folder
      // Hermes refuses leaves the conversation where it was rather than failing the turn.
      await channel
        .request('session.cwd.set', { session_id: liveId, cwd: options.cwd })
        .catch(() => undefined);
    }
    const session = new HermesTuiSession(channel, liveId, storedId);
    session.current = {
      model: options.model ?? null,
      provider: options.provider ?? null,
      effort: options.reasoningEffort ?? null,
    };
    session.detach = channel.attach(liveId, {
      event: (type, payload) => session.onEvent(type, payload),
      request: (method, params) => session.onRequest(method, params),
      busy: () => session.turn !== null,
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

  /**
   * Hermes's delegations (contract decision §56): its `subagent.*` events, and its calls to
   * list, stop, steer and read a subagent of this session. The calls name the live session,
   * which is what Hermes checks the caller's authority against.
   */
  readonly subagents: SubagentControl = {
    support: 'full',
    watch: (listener) => this.subagentSignals.watch(listener),
    list: async (): Promise<LiveSubagent[]> => {
      if (this.closed) return [];
      const result = await this.channel.request('subagent.list', { session_id: this.liveId });
      const rows = Array.isArray(result.subagents) ? result.subagents : [];
      return rows.map(hermesLiveSubagent).filter((row): row is LiveSubagent => row !== null);
    },
    interrupt: async (id) => {
      if (this.closed) return false;
      const result = await this.channel.request('subagent.interrupt', {
        session_id: this.liveId,
        subagent_id: id,
      });
      return result.found === true;
    },
    steer: async (id, note) => {
      if (this.closed) return 'rejected';
      const result = await this.channel.request('subagent.steer', {
        session_id: this.liveId,
        subagent_id: id,
        text: note,
      });
      return result.status === 'queued' ? 'queued' : 'rejected';
    },
    tail: async (id): Promise<SubagentTailText> => {
      const none = { available: false, text: '', truncated: false };
      if (this.closed) return none;
      const result = await this.channel.request('subagent.tail', {
        session_id: this.liveId,
        subagent_id: id,
      });
      if (result.available !== true) return none;
      return {
        available: true,
        text: typeof result.text === 'string' ? result.text : '',
        truncated: result.truncated === true,
      };
    },
  };

  stream(): AsyncIterable<AgentEvent> {
    return this.queue.iterator();
  }

  async send(prompt: PromptInput): Promise<{ stopReason: string }> {
    if (this.closed) throw new HubError('state_invalid', { message: 'Hermes session is closed' });
    if (this.turn) throw new HubError('already_running', { details: { session: this.storedId } });
    const done = new Promise<string>((resolve) => {
      this.turn = { resolve };
    });
    this.asked = {
      model: prompt.model ?? null,
      provider: prompt.modelProvider ?? null,
      slug: prompt.modelProviderSlug ?? null,
      fallbacks: prompt.fallbacks ?? [],
      notes: [],
    };
    try {
      await this.select(prompt);
      const text = await this.commandTurn(prompt);
      if (text === null) {
        // The command answered with output of its own: that is the whole turn.
        this.end('completed');
      } else {
        await this.channel.request('prompt.submit', { session_id: this.liveId, text });
      }
    } catch (error) {
      this.turn = null;
      throw error;
    }
    const stopReason = await done;
    return { stopReason };
  }

  /**
   * A message that starts with one of Hermes's own commands (`/goal`, `/plan`, `/learn`,
   * `/skill <name>`) is Hermes's to carry out, not text for the model (decision §57). Hermes's
   * `command.dispatch` answers with a prompt to run — the plan prompt, the skill loaded into
   * the turn — or with output of its own, which is then the turn's whole reply (`null` here).
   * Anything else goes to the model exactly as typed.
   *
   * The command is read from the message's own first text block, so the lines the hub adds
   * after it (attachments, where to write files) still reach the turn it becomes.
   */
  private async commandTurn(prompt: PromptInput): Promise<string | null> {
    const typed = prompt.blocks?.find((block) => block.type === 'text')?.text ?? prompt.text;
    const command = agentCommandOf(typed);
    if (!command) return prompt.text;
    let result: Json;
    try {
      result = await this.channel.request('command.dispatch', {
        session_id: this.liveId,
        name: command.name,
        arg: command.arg,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`/${command.typed}: ${why}`, { cause: error });
    }
    const kind = String(result.type ?? '');
    const message = text(result.message);
    if ((kind === 'send' || kind === 'skill') && message) {
      const after = prompt.text.startsWith(typed) ? prompt.text.slice(typed.length) : '';
      return `${message}${after}`;
    }
    const output =
      text(result.output) ?? text(result.notice) ?? text(result.display) ?? text(result.target);
    this.queue.push({ type: 'message.delta', text: output?.trim() ? output : `/${command.typed}` });
    this.queue.push({ type: 'run.completed', stopReason: 'completed' });
    return null;
  }

  /**
   * Hermes's `session.compress` (decision §57): only between turns. Its answer carries the
   * before/after estimate and the window as it now stands, which is what the meter shows.
   */
  async compress(focus: string | null): Promise<CompressOutcome> {
    if (this.closed) throw new HubError('state_invalid', { message: 'Hermes session is closed' });
    if (this.turn) throw new HubError('already_running', { details: { session: this.storedId } });
    let result: Json;
    try {
      result = await this.channel.request('session.compress', {
        session_id: this.liveId,
        ...(focus?.trim() ? { focus_topic: focus.trim() } : {}),
      });
    } catch (error) {
      if (error instanceof TuiError && error.code === 4009) {
        throw new HubError('already_running', { details: { session: this.storedId } });
      }
      throw error;
    }
    return compressOutcomeOf(result);
  }

  /** Hermes's `session.steer`: read after the next tool call; the turn is not interrupted. */
  async steer(guidance: string): Promise<'queued' | 'rejected'> {
    if (this.closed || !this.turn) return 'rejected';
    try {
      const result = await this.channel.request('session.steer', {
        session_id: this.liveId,
        text: guidance,
      });
      return result.status === 'queued' ? 'queued' : 'rejected';
    } catch (error) {
      // 4010: the agent is not built yet, so there is nothing to steer — a message instead.
      if (error instanceof TuiError) return 'rejected';
      throw error;
    }
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
    this.subagentSignals.endAll();
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
    if (type.startsWith('subagent.')) {
      // Not part of the turn: a subagent can outlive it (asynchronous delegation).
      const signal = hermesSubagentSignal(type, payload);
      if (signal) this.subagentSignals.emit(signal);
      return;
    }
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
        const picture = failed ? null : producedImageOf(String(payload.name ?? ''), result);
        if (picture) this.queue.push({ type: 'file.produced', path: picture, toolId: id });
        return;
      }
      case 'status.update': {
        // Hermes says so when it moves down its `fallback_providers` (contract decision §54).
        const note = parseFallbackNote(text(payload.text));
        if (note && this.turn) this.asked.notes.push(note);
        // Hermes compressing on its own inside a turn (`_status_update`, re-tagged
        // `compacting` for auto-compaction). A manual compress says the same between turns;
        // that one is the hub's own call, reported where it is made.
        if (!this.turn) return;
        const kind = String(payload.kind ?? '');
        if (kind === 'compressing' || kind === 'compacting') {
          if (!this.compressing) {
            this.compressing = true;
            this.queue.push({ type: 'compression', phase: 'started' });
          }
        } else {
          this.compressionDone();
        }
        return;
      }
      case 'message.complete':
        this.compressionDone();
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

  private compressionDone(): void {
    if (!this.compressing) return;
    this.compressing = false;
    this.queue.push({ type: 'compression', phase: 'finished' });
  }

  private finish(payload: Json): void {
    const usage = (payload.usage ?? null) as Json | null;
    const fallback = this.fallbackOf(text(usage?.model));
    if (fallback) this.queue.push(fallback);
    const window = usage ? contextOf(usage) : null;
    if (window) this.queue.push({ type: 'context', ...window });
    if (usage) {
      const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
      const input = number(usage.input) || number(usage.prompt);
      const output = number(usage.output) || number(usage.completion);
      const reasoning = number(usage.reasoning);
      const total = { input: input ?? 0, output: output ?? 0, reasoning: reasoning ?? 0 };
      // A counter that went down means Hermes started the session's agent afresh (a model
      // switch, a restart): its totals are this turn's alone.
      const reset =
        total.input < this.reported.input ||
        total.output < this.reported.output ||
        total.reasoning < this.reported.reasoning;
      const base = reset ? { input: 0, output: 0, reasoning: 0 } : this.reported;
      this.reported = total;
      this.queue.push({
        type: 'usage',
        modelLabel: text(usage.model),
        providerId: null,
        ...(input !== undefined ? { inputTokens: total.input - base.input } : {}),
        ...(output !== undefined ? { outputTokens: total.output - base.output } : {}),
        ...(reasoning ? { reasoningTokens: total.reasoning - base.reasoning } : {}),
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

  /**
   * Whether Hermes answered this turn on another model than the one asked for, said in the
   * hub's names (contract decision §54). Hermes's own notes say what failed and why; without
   * them, a model in the usage that is not the one asked for says it all the same.
   */
  private fallbackOf(reported: string | null): AgentEvent | null {
    const { model, provider, slug, fallbacks, notes } = this.asked;
    const slugOf = (runtime: string | null, name: string | null): string | null => {
      if (runtime !== null && runtime === provider) return slug;
      const member =
        fallbacks.find((each) => each.model === name && (!runtime || each.provider === runtime)) ??
        null;
      return member?.slug ?? null;
    };
    if (notes.length > 0) {
      const last = notes[notes.length - 1] as FallbackNote;
      return {
        type: 'model.fallback',
        failed: notes.map((note) => ({
          model: note.from,
          provider: slugOf(note.fromProvider, note.from),
          code: null,
          error: note.reason,
        })),
        answered: { model: last.to, provider: slugOf(last.toProvider, last.to) },
      };
    }
    if (!reported || !model || reported === model) return null;
    return {
      type: 'model.fallback',
      failed: [{ model, provider: slug, code: null, error: null }],
      answered: { model: reported, provider: slugOf(null, reported) },
    };
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
      const asking = [...this.openTools].reverse().find((tool) => tool.name === 'clarify');
      const ask = async (question: string, choices: string[]): Promise<string> => {
        const id = `question-${++this.counter}`;
        const reply = new Promise<string | null>((resolve) => this.questions.set(id, resolve));
        this.queue.push({
          type: 'question.asked',
          id,
          question,
          choices,
          toolId: asking?.id ?? null,
        });
        const answer = await reply;
        // Hermes defines skip as the empty answer; a chosen label loses the "(Recommended)"
        // mark Hermes itself added to it.
        return answer === null ? '' : answer.replace(RECOMMENDED, '');
      };
      // A batch (`questions`, what Hermes's clarify tool advertises to the model) is put to
      // the person one question at a time, and Hermes gets the whole set back as `answers`
      // keyed by `qid` — the single form's `{answer}` would read as "cancel all" there.
      if (Array.isArray(params.questions)) {
        const answers: Record<string, string> = {};
        for (const entry of params.questions) {
          if (this.isClosed) break;
          if (!entry || typeof entry !== 'object') continue;
          const item = entry as Json;
          const qid = text(item.qid);
          if (!qid) continue;
          answers[qid] = await ask(text(item.question) ?? '', strings(item.choices));
        }
        return { answers };
      }
      return { answer: await ask(text(params.question) ?? '', strings(params.choices)) };
    }
    // Secrets, sudo, the desktop's own bridges: nothing in the hub can answer them, and
    // an unanswered request blocks the agent until its timeout. Refuse at once.
    throw new Error(`the hub cannot answer "${method}"`);
  }

  private onExit(reason: string): void {
    this.subagentSignals.endAll(reason);
    if (this.turn) this.queue.push({ type: 'run.failed', error: reason });
    this.end('failed');
    this.isClosed = true;
    for (const answer of this.questions.values()) answer(null);
    this.questions.clear();
  }

  private end(stopReason: string): void {
    const turn = this.turn;
    this.turn = null;
    this.compressing = false;
    this.openTools.length = 0;
    turn?.resolve(stopReason);
  }
}

/**
 * The `profile` a session call carries. Hermes's `default` is the process's own home, so it
 * is sent as nothing at all — the wire a hub without profiles always spoke.
 */
function profileParams(profile: string | null | undefined): Json {
  const name = profile?.trim();
  return name && name !== 'default' ? { profile: name } : {};
}

/** The folder Hermes says a resumed session works in (`info.cwd`), when it says one. */
function workingFolderOf(result: Json): string | null {
  const info = result.info;
  if (!info || typeof info !== 'object') return null;
  const cwd = (info as Json).cwd;
  return typeof cwd === 'string' ? cwd : null;
}

/** The strings in a list Hermes sent, or none. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** One of Hermes's "Model fallback" status lines, read back into its parts. */
export interface FallbackNote {
  from: string;
  fromProvider: string;
  reason: string | null;
  to: string;
  toProvider: string;
}

/**
 * Hermes's line when it moves down `fallback_providers` (MIT source
 * `agent/chat_completion_helpers.py` §try_activate_fallback):
 * `⚠️ Model fallback: <model> via <provider> unavailable (<reason>); using <model> via <provider>.`
 * `null` for every other status line.
 */
export function parseFallbackNote(line: string | null): FallbackNote | null {
  if (!line) return null;
  const match =
    /Model fallback:\s+(\S+)\s+via\s+(\S+)\s+unavailable\s+\((.*?)\);\s+using\s+(\S+)\s+via\s+(\S+?)\.?(?:\s|$)/.exec(
      line,
    );
  if (!match) return null;
  const [, from, fromProvider, reason, to, toProvider] = match as unknown as string[];
  return {
    from: from as string,
    fromProvider: fromProvider as string,
    reason: reason ? reason : null,
    to: to as string,
    toProvider: toProvider as string,
  };
}

/** The commands Hermes carries out itself, by the word after `/` (decision §57). */
export const HERMES_COMMANDS = ['goal', 'plan', 'learn', 'skill'] as const;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * `/plan build it` → `{name: 'plan', arg: 'build it'}`; `/skill review the diff` → the skill's
 * own name, `{name: 'review', arg: 'the diff'}`, which is how Hermes invokes a skill. Anything
 * else — another `/word`, a `/skill` without a name, plain text — is `null`: a message.
 */
export function agentCommandOf(
  message: string,
): { name: string; arg: string; typed: string } | null {
  const match = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/.exec(message.trim());
  if (!match) return null;
  const word = match[1] as string;
  const arg = (match[2] ?? '').trim();
  if (!(HERMES_COMMANDS as readonly string[]).includes(word)) return null;
  if (word !== 'skill') return { name: word, arg, typed: word };
  const [skill = ''] = arg.split(/\s+/);
  if (!SKILL_NAME.test(skill)) return null;
  const name = skillCommandName(skill);
  if (!name) return null;
  return { name, arg: arg.slice(skill.length).trim(), typed: `skill ${skill}` };
}

/**
 * The command Hermes registers a skill under (`agent/skill_commands.py` §slugify_skill_name):
 * lower case, spaces and underscores as hyphens, anything but word characters and hyphens
 * dropped, hyphens not doubled nor at the ends. The hub lists a skill by its folder, which is
 * usually its name already; this makes `Code_Review` and `code-review` the same command.
 */
export function skillCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/_/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The window Hermes reports with its usage (`context_used` of `context_max`), when it does. */
function contextOf(
  usage: Json,
): { usedTokens: number; windowTokens: number | null; estimated: boolean } | null {
  const used = usage.context_used;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const max = usage.context_max;
  return {
    usedTokens: Math.round(used),
    windowTokens: typeof max === 'number' && max > 0 ? Math.round(max) : null,
    estimated: usage.context_estimated === true,
  };
}

/** Hermes's `session.compress` answer in the contract's terms. */
export function compressOutcomeOf(result: Json): CompressOutcome {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const summary = (result.summary ?? null) as Json | null;
  const words = [summary?.headline, summary?.token_line, summary?.note, result.message]
    .map((value) => text(value)?.trim() ?? '')
    .filter((value) => value !== '');
  const usage = (result.usage ?? (result.info as Json | undefined)?.usage ?? null) as Json | null;
  let status: CompressOutcome['status'];
  if (result.lock_held === true || result.compressed === false) status = 'skipped';
  else if (
    result.status === 'aborted' ||
    summary?.noop === true ||
    summary?.aborted === true ||
    count(result.removed) === 0
  )
    status = 'unchanged';
  else status = 'compressed';
  return {
    status,
    beforeTokens: count(result.before_tokens),
    afterTokens: count(result.after_tokens),
    beforeMessages: count(result.before_messages),
    afterMessages: count(result.after_messages),
    context: usage ? contextOf(usage) : null,
    message: words.length > 0 ? [...new Set(words)].join('\n') : null,
  };
}
