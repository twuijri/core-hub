/**
 * Hermes conversations through the gateway that already runs (Hermes v0.22.2 and later).
 *
 * From v0.22.2 Hermes's standalone `python -m tui_gateway.entry` refuses a home its gateway owns
 * ("refused: <home> is owned by a running gateway; attach to it instead", `tui_gateway/entry.py`
 * §_claim_launch_home in its MIT source): the gateway reserves `gateway.lock` in every home it
 * serves, and the stdio entry opens `state.db` as a writer, so it must be the only owner. The hub
 * always runs that gateway (the API server and the channels live in it), so every conversation of
 * an image with Hermes v0.22.5 failed on its first message.
 *
 * Hermes's own clients — its TUI and its desktop app — attach instead
 * (`ui-tui/scripts/gateway_bootstrap.py`): discover the profile's gateway, ask its private control
 * socket for a session ticket, and open `<api_origin>/api/ws` with the subprotocols
 * `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>`. The frames are the same
 * newline-delimited JSON-RPC as over stdio, and `gateway.ready` arrives right after the upgrade;
 * the session verbs are the gateway's canonical ones (`tui_gateway/contracts/canonical_sessions.py`):
 *
 * - `session.create` takes `source` from a closed list and `reasoning` (not `reasoning_effort`);
 * - `prompt.submit` needs a `submission_id` (an admission, retried by that id);
 * - `session.interrupt` and `session.steer` name the turn's `execution_generation`;
 * - the model, the reasoning effort, the working folder and a compress are `session.mutate`
 *   operations fenced by the session's `revision`, not `config.set` or verbs of their own;
 * - `session.close` is `session.detach`;
 * - an approval and a question arrive as events (`approval.request`, `clarify.request`, one per
 *   question) and are answered with `approval.respond` / `clarify.respond`.
 *
 * This channel speaks that, and shows the hub's sessions (`hermes-tui.ts`) the same `TuiChannel`
 * as the stdio one, so a conversation does not know which it runs on. A ticket is bound to one
 * profile, so each profile gets its own socket; they all reach the same gateway process, and when
 * one closes the gateway went away (a restart, a crash) and the whole channel is gone, as the
 * stdio child was when it exited. A Hermes whose stdio entry still serves a home beside the
 * gateway is spoken to over stdio exactly as before (`fallback`).
 */
import { randomUUID } from 'node:crypto';
import { TUI_STOPPED, TuiError, type TuiChannel, type TuiSessionHandlers } from './hermes-tui.js';

type Json = Record<string, unknown>;

/** What the bootstrap found for one profile. */
export type GatewayBootstrap =
  | { kind: 'attach'; url: string; protocols: string[] }
  /** This Hermes predates the refusal: its stdio entry is still the way in. */
  | { kind: 'unsupported' }
  /** Not attachable yet (the gateway is starting or restarting), or not at all, with why. */
  | { kind: 'unavailable'; reason: string };

/** The part of a WebSocket this channel uses (the global one in Node 22 and later). */
export interface GatewaySocket {
  readonly protocol: string;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export interface GatewayChannelOptions {
  /** A fresh ticket for the profile's gateway; `null` is Hermes's `default` (the root home). */
  bootstrap(profile: string | null): Promise<GatewayBootstrap>;
  /** The stdio channel, for a Hermes that still has one (`unsupported`). */
  fallback(): TuiChannel;
  /** How long a profile's socket may take to be ready, bootstrap retries included. */
  readyTimeoutMs?: number;
  /** Between two bootstraps while the gateway is not attachable yet. */
  retryMs?: number;
  /** Injected in tests. */
  socket?: (url: string, protocols: string[]) => GatewaySocket;
  log?: (message: string, detail?: unknown) => void;
}

/** The protocol the gateway echoes after the upgrade (`hermes_cli/gateway_client.py`). */
export const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1';

/** What the hub's conversations are, among the `source` values the gateway accepts. */
const SESSION_SOURCE = 'gui';

/** One profile's socket. */
interface Connection {
  readonly profile: string | null;
  readonly ready: Promise<void>;
  request(method: string, params: Json): Promise<Json>;
  close(): void;
}

/** What the channel keeps per live session: where it lives and its fences. */
interface SessionState {
  connection: Connection;
  /** The gateway's turn counter for this session; interrupt, steer and answers name it. */
  generation: number;
  /** The session's revision, which a `session.mutate` must name. */
  revision: number;
  handlers: TuiSessionHandlers | null;
}

const defaultSocket = (url: string, protocols: string[]): GatewaySocket =>
  new WebSocket(url, protocols) as unknown as GatewaySocket;

/**
 * The channel, attaching per profile on first use. It decides once, on its first bootstrap,
 * whether this Hermes is attached to or spoken to over stdio.
 */
export function gatewayTuiChannel(options: GatewayChannelOptions): TuiChannel {
  let alive = true;
  let fallback: TuiChannel | null = null;
  const connections = new Map<string, Promise<Connection>>();
  const sessions = new Map<string, SessionState>();
  const exitListeners = new Set<(reason: string) => void>();
  let inFlight = 0;
  const log = options.log ?? (() => undefined);

  const gone = (reason: string) => {
    if (!alive) return;
    alive = false;
    for (const listener of exitListeners) listener(reason);
    for (const pending of connections.values()) {
      void pending.then((connection) => connection.close()).catch(() => undefined);
    }
    connections.clear();
  };

  /** The decision and the socket for one profile, made once and shared. */
  const connectionFor = (profile: string | null): Promise<Connection | 'stdio'> => {
    if (fallback) return Promise.resolve('stdio');
    const key = profile ?? '';
    let pending = connections.get(key);
    if (!pending) {
      pending = connect(profile);
      connections.set(key, pending);
      // A profile that could not be attached is tried afresh next time, not failed forever.
      pending.catch(() => {
        if (connections.get(key) === pending) connections.delete(key);
      });
    }
    return pending.then(
      (connection) => connection,
      (error: unknown) => {
        if (error instanceof StdioInstead) return 'stdio';
        throw error;
      },
    );
  };

  const connect = async (profile: string | null): Promise<Connection> => {
    const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
    let why: string;
    for (;;) {
      const found = await options.bootstrap(profile);
      if (found.kind === 'unsupported') {
        if (!fallback) {
          fallback = options.fallback();
          // Its exit is this channel's: the runtime starts a new one, sessions stop waiting.
          fallback.onExit((reason) => gone(reason));
        }
        throw new StdioInstead();
      }
      if (found.kind === 'attach') {
        const connection = openConnection(profile, found, deadline);
        await connection.ready;
        return connection;
      }
      why = found.reason;
      if (Date.now() + (options.retryMs ?? 1000) > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 1000));
      if (!alive) throw new Error(TUI_STOPPED);
    }
    throw new Error(`the Hermes gateway could not be reached (${why})`);
  };

  const openConnection = (
    profile: string | null,
    ticket: { url: string; protocols: string[] },
    deadline: number,
  ): Connection => {
    const socket = (options.socket ?? defaultSocket)(ticket.url, ticket.protocols);
    const pending = new Map<
      number,
      { resolve: (value: Json) => void; reject: (e: Error) => void }
    >();
    let counter = 0;
    let open = true;
    let markReady: () => void = () => {};
    let failReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    ready.catch(() => undefined);
    const timer = setTimeout(
      () => {
        failReady(new Error('the Hermes gateway did not answer'));
        socket.close();
      },
      Math.max(1000, deadline - Date.now()),
    );
    timer.unref?.();

    const write = (frame: Json) => {
      if (open) socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
    };
    const closed = (reason: string) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      failReady(new Error(reason));
      for (const call of pending.values()) call.reject(new Error(reason));
      pending.clear();
      gone(reason);
    };

    const connection: Connection = {
      profile,
      ready,
      request(method, params) {
        if (!open) return Promise.reject(new Error('the Hermes gateway connection is closed'));
        const id = ++counter;
        return new Promise<Json>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          write({ id, method, params });
        });
      },
      close() {
        open = false;
        clearTimeout(timer);
        socket.close(1000, 'closed by the hub');
      },
    };

    socket.addEventListener('open', () => {
      // The gateway echoes the protocol it speaks; anything else is not the gateway we asked.
      if (socket.protocol !== GATEWAY_WS_PROTOCOL) {
        closed(`the Hermes gateway answered with protocol "${socket.protocol}"`);
        socket.close();
      }
    });
    socket.addEventListener('error', () => undefined);
    socket.addEventListener('close', (event) => {
      const detail = event.reason ? `: ${event.reason}` : '';
      closed(`the Hermes gateway closed the connection (${event.code ?? '?'}${detail})`);
    });
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let frame: Json;
        try {
          frame = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        onFrame(frame, write, pending, () => {
          clearTimeout(timer);
          markReady();
        });
      }
    });
    return connection;
  };

  const onFrame = (
    frame: Json,
    write: (frame: Json) => void,
    pending: Map<number, { resolve: (value: Json) => void; reject: (e: Error) => void }>,
    ready: () => void,
  ) => {
    if (frame.method === 'event') {
      const params = (frame.params ?? {}) as Json;
      const type = String(params.type ?? '');
      if (type === 'gateway.ready') {
        ready();
        return;
      }
      const sessionId = typeof params.session_id === 'string' ? params.session_id : '';
      const state = sessions.get(sessionId);
      if (!state) return;
      if (typeof params.execution_generation === 'number') {
        state.generation = Math.max(state.generation, params.execution_generation);
      }
      const payload = (params.payload ?? {}) as Json;
      if (type === 'session.info' && typeof payload.revision === 'number') {
        state.revision = Math.max(state.revision, payload.revision);
      }
      if (type === 'approval.request' || type === 'clarify.request') {
        void ask(sessionId, state, type, payload);
        return;
      }
      state.handlers?.event(type, payload);
      return;
    }
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      // A question the gateway still asks as a request (sudo, a secret, the desktop's bridges):
      // the session answers or refuses it at once, as over stdio.
      const params = (frame.params ?? {}) as Json;
      const target = sessions.get(String(params.session_id ?? ''))?.handlers;
      const id = frame.id;
      if (!target) {
        write({ id, error: { code: -32601, message: 'no client is attached to this session' } });
        return;
      }
      target
        .request(frame.method, params)
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
      const error = frame.error as { code?: number; message?: string } | null | undefined;
      if (error) call.reject(new TuiError(error.code ?? 0, error.message ?? 'error'));
      else call.resolve((frame.result ?? {}) as Json);
    }
  };

  /**
   * An approval or a question, put to the person the way the stdio gateway asked it (a request
   * `approval` / `clarify`), and the answer sent back fenced to the turn that asked.
   */
  const ask = async (sessionId: string, state: SessionState, type: string, payload: Json) => {
    const generation =
      typeof payload.execution_generation === 'number'
        ? payload.execution_generation
        : state.generation;
    const promptId = String(payload.prompt_id ?? '');
    const handlers = state.handlers;
    if (!handlers || !promptId) return;
    try {
      if (type === 'approval.request') {
        const answer = await handlers.request('approval', {
          session_id: sessionId,
          request_id: promptId,
          command: payload.command ?? null,
          description: payload.description ?? null,
          choices: Array.isArray(payload.choices) ? payload.choices : ['once', 'deny'],
        });
        await state.connection.request('approval.respond', {
          session_id: sessionId,
          execution_generation: generation,
          prompt_id: promptId,
          choice: String(answer.choice ?? 'deny'),
        });
        return;
      }
      const answer = await handlers.request('clarify', {
        session_id: sessionId,
        question: payload.question ?? '',
        choices: Array.isArray(payload.choices) ? payload.choices : [],
      });
      await state.connection.request('clarify.respond', {
        session_id: sessionId,
        execution_generation: generation,
        prompt_id: promptId,
        answer: typeof answer.answer === 'string' ? answer.answer : '',
      });
    } catch (error) {
      log('hermes gateway: an answer could not be sent', { type, error: String(error) });
    }
  };

  /** Where a call goes: the session's own socket, else the profile it names. */
  const route = async (params: Json): Promise<Connection | 'stdio'> => {
    const known = sessions.get(String(params.session_id ?? ''));
    if (known) return known.connection;
    const profile =
      typeof params.profile === 'string' && params.profile !== 'default' ? params.profile : null;
    return connectionFor(profile);
  };

  const remember = (connection: Connection, result: Json) => {
    const id = String(result.session_id ?? '');
    if (!id) return;
    const existing = sessions.get(id);
    const generation =
      typeof result.execution_generation === 'number' ? result.execution_generation : 0;
    const revision = typeof result.revision === 'number' ? result.revision : 0;
    if (existing) {
      existing.generation = Math.max(existing.generation, generation);
      existing.revision = Math.max(existing.revision, revision);
      return;
    }
    sessions.set(id, { connection, generation, revision, handlers: null });
  };

  /** A `session.mutate`, fenced by the session's revision and generation. */
  const mutate = async (
    state: SessionState,
    sessionId: string,
    operation: string,
    payload: Json,
  ) => {
    const result = await state.connection.request('session.mutate', {
      session_id: sessionId,
      request_id: randomUUID(),
      expected_revision: state.revision,
      expected_generation: state.generation,
      operation,
      payload,
    });
    if (typeof result.revision === 'number')
      state.revision = Math.max(state.revision, result.revision);
    return result;
  };

  /** The hub's calls, in the gateway's canonical words. */
  const call = async (method: string, params: Json): Promise<Json> => {
    const target = await route(params);
    if (target === 'stdio') return (fallback as TuiChannel).request(method, params);
    const connection = target;
    const sessionId = String(params.session_id ?? '');
    const state = sessions.get(sessionId);
    switch (method) {
      case 'session.create': {
        const { source: _source, reasoning_effort: effort, ...rest } = params;
        const result = await connection.request('session.create', {
          ...rest,
          source: SESSION_SOURCE,
          ...(typeof effort === 'string' ? { reasoning: effort } : {}),
        });
        remember(connection, result);
        return result;
      }
      case 'session.resume': {
        const result = await connection.request('session.resume', params);
        remember(connection, result);
        return result;
      }
      case 'prompt.submit':
        return connection.request('prompt.submit', { ...params, submission_id: randomUUID() });
      case 'session.interrupt':
      case 'session.steer':
        return connection.request(method, {
          ...params,
          execution_generation: state?.generation ?? 0,
        });
      case 'session.close': {
        sessions.delete(sessionId);
        return connection.request('session.detach', { session_id: sessionId });
      }
      case 'session.cwd.set':
        if (!state) throw new TuiError(4004, 'unknown session');
        return mutate(state, sessionId, 'workspace', { cwd: String(params.cwd ?? '') });
      case 'session.compress': {
        if (!state) throw new TuiError(4004, 'unknown session');
        const focus = typeof params.focus_topic === 'string' ? params.focus_topic : null;
        return mutate(state, sessionId, 'compress', focus ? { focus } : {});
      }
      case 'config.set': {
        if (!state) break;
        if (params.key === 'model') {
          return mutate(state, sessionId, 'model', modelSelection(String(params.value ?? '')));
        }
        if (params.key === 'reasoning' && params.scope === 'session') {
          return mutate(state, sessionId, 'reasoning', { effort: String(params.value ?? '') });
        }
        break;
      }
      default:
        break;
    }
    return connection.request(method, params);
  };

  return {
    get alive() {
      return alive && (!fallback || fallback.alive);
    },
    get pid() {
      return fallback ? (fallback.pid ?? null) : null;
    },
    get busy() {
      if (fallback) return fallback.busy;
      if (!alive) return false;
      if (inFlight > 0) return true;
      for (const state of sessions.values()) if (state.handlers?.busy?.()) return true;
      return false;
    },
    async request(method, params) {
      if (!alive) throw new Error('the Hermes gateway connection is closed');
      inFlight += 1;
      try {
        return await call(method, params);
      } finally {
        inFlight -= 1;
      }
    },
    attach(sessionId, handlers) {
      if (fallback) return fallback.attach(sessionId, handlers);
      const state = sessions.get(sessionId);
      if (state) state.handlers = handlers;
      return () => {
        const current = sessions.get(sessionId);
        if (current?.handlers === handlers) current.handlers = null;
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async close() {
      if (fallback) return fallback.close();
      gone(TUI_STOPPED);
    },
  };
}

/** Thrown inside the channel when this Hermes is spoken to over stdio instead. */
class StdioInstead extends Error {}

/**
 * The hub's `config.set model` value (`<model> [--provider <id>] --session`) as the gateway's
 * `session.mutate model` payload.
 */
export function modelSelection(value: string): { model: string; provider?: string } {
  const words = value.trim().split(/\s+/);
  let model = '';
  let provider: string | undefined;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    if (word === '--session') continue;
    if (word === '--provider') {
      provider = words[i + 1];
      i += 1;
      continue;
    }
    if (!model) model = word;
  }
  return provider ? { model, provider } : { model };
}
