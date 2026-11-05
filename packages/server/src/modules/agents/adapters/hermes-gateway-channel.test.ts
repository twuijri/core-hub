import { describe, expect, it } from 'vitest';
import {
  GATEWAY_WS_PROTOCOL,
  gatewayTuiChannel,
  modelSelection,
  type GatewayBootstrap,
  type GatewaySocket,
} from './hermes-gateway-channel.js';
import { HermesTuiSession, type TuiChannel } from './hermes-tui.js';

type Json = Record<string, unknown>;

/**
 * A scripted gateway socket: records what the hub sends, answers each call with `answer`, and
 * lets the test push events the way Hermes's gateway does (`tui_gateway/ws.py`).
 */
class FakeGateway implements GatewaySocket {
  protocol = GATEWAY_WS_PROTOCOL;
  readyState = 1;
  readonly sent: Json[] = [];
  closedWith: number | null = null;
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  constructor(private readonly answer: (method: string, params: Json) => Json | { error: Json }) {
    setImmediate(() => {
      this.emit('open', {});
      this.push({ method: 'event', params: { type: 'gateway.ready', payload: {} } });
    });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Json;
    this.sent.push(frame);
    if (typeof frame.method !== 'string' || frame.id === undefined) return;
    const answer = this.answer(frame.method, (frame.params ?? {}) as Json);
    setImmediate(() =>
      this.push(
        'error' in answer && Object.keys(answer).length === 1
          ? { id: frame.id, error: answer.error }
          : { id: frame.id, result: answer },
      ),
    );
  }

  close(code = 1000): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.emit('close', { code, reason: '' });
  }

  push(frame: Json): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  event(sessionId: string, type: string, payload: Json, generation?: number): void {
    this.push({
      method: 'event',
      params: {
        type,
        session_id: sessionId,
        payload,
        ...(generation !== undefined ? { execution_generation: generation } : {}),
      },
    });
  }

  calls(method: string): Json[] {
    return this.sent
      .filter((frame) => frame.method === method)
      .map((frame) => frame.params as Json);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A gateway that creates `local-1` at revision 3 and accepts everything else. */
function scripted(overrides: Record<string, (params: Json) => Json | { error: Json }> = {}) {
  const sockets: FakeGateway[] = [];
  const tickets: Array<string | null> = [];
  const channel = gatewayTuiChannel({
    bootstrap: async (profile): Promise<GatewayBootstrap> => {
      tickets.push(profile);
      return { kind: 'attach', url: 'ws://127.0.0.1:1/api/ws', protocols: [GATEWAY_WS_PROTOCOL] };
    },
    fallback: () => {
      throw new Error('no stdio here');
    },
    socket: () => {
      const socket = new FakeGateway((method, params) => {
        const override = overrides[method];
        if (override) return override(params);
        if (method === 'session.create' || method === 'session.resume') {
          return {
            session_id: 'local-1',
            stored_session_id: 'local-1',
            execution_generation: 0,
            revision: 3,
          };
        }
        if (method === 'prompt.submit') return { admission_id: 'a1', status: 'queued' };
        if (method === 'session.mutate') return { session_id: params.session_id, revision: 4 };
        return {};
      });
      sockets.push(socket);
      return socket;
    },
  });
  return { channel, sockets, tickets };
}

describe('the Hermes gateway channel', () => {
  it("speaks the gateway's canonical session verbs for the hub's calls", async () => {
    const { channel, sockets } = scripted();
    const session = await HermesTuiSession.open(channel, null, {
      model: 'fake-1',
      provider: 'custom',
      reasoningEffort: 'high',
      cwd: '/work',
    });
    const socket = sockets[0]!;
    // `source` from the gateway's closed list, `reasoning` instead of `reasoning_effort`.
    expect(socket.calls('session.create')[0]).toEqual({
      source: 'gui',
      cwd: '/work',
      model: 'fake-1',
      provider: 'custom',
      reasoning: 'high',
    });
    expect(session.id).toBe('local-1');

    const events: string[] = [];
    void (async () => {
      for await (const event of session.stream()) events.push(event.type);
    })();
    const turn = session.send({ text: 'hello' });
    await tick();
    await tick();
    const submitted = socket.calls('prompt.submit')[0]!;
    expect(submitted.text).toBe('hello');
    expect(typeof submitted.submission_id).toBe('string');

    // The turn's generation travels on its events; interrupt and steer name it.
    socket.event('local-1', 'message.delta', { text: 'hi' }, 1);
    await session.steer('shorter');
    expect(socket.calls('session.steer')[0]).toMatchObject({
      session_id: 'local-1',
      text: 'shorter',
      execution_generation: 1,
    });
    await session.interrupt();
    expect(socket.calls('session.interrupt')[0]).toEqual({
      session_id: 'local-1',
      execution_generation: 1,
    });
    socket.event('local-1', 'message.complete', { status: 'complete', text: 'hi' }, 1);
    expect(await turn).toEqual({ stopReason: 'completed' });
    expect(events).toContain('message.delta');

    await session.close();
    expect(socket.calls('session.detach')).toEqual([{ session_id: 'local-1' }]);
    expect(socket.calls('session.close')).toEqual([]);
  });

  it('switches the model and the effort with revision-fenced session.mutate', async () => {
    const { channel, sockets } = scripted();
    const session = await HermesTuiSession.open(channel, null, { model: 'a', provider: 'p' });
    const socket = sockets[0]!;
    socket.event('local-1', 'session.info', { revision: 5 });
    void session.send({ text: 'x', model: 'b', modelProvider: 'q', reasoningEffort: 'low' });
    await tick();
    await tick();
    await tick();
    const [model, effort] = socket.calls('session.mutate');
    expect(model).toMatchObject({
      session_id: 'local-1',
      operation: 'model',
      payload: { model: 'b', provider: 'q' },
      expected_revision: 5,
    });
    expect(typeof model!.request_id).toBe('string');
    // The answer's revision fences the next edit.
    expect(effort).toMatchObject({
      operation: 'reasoning',
      payload: { effort: 'low' },
      expected_revision: 5,
    });
    expect(socket.calls('config.set')).toEqual([]);
  });

  it('puts an approval and a question to the person and answers them fenced to the turn', async () => {
    const { channel, sockets } = scripted();
    const session = await HermesTuiSession.open(channel, null);
    const socket = sockets[0]!;
    const seen: Json[] = [];
    void (async () => {
      for await (const event of session.stream()) seen.push(event as unknown as Json);
    })();
    void session.send({ text: 'run it' });
    await tick();
    socket.event(
      'local-1',
      'tool.start',
      { tool_id: 't1', name: 'terminal', context: 'rm -rf x' },
      2,
    );
    socket.event(
      'local-1',
      'approval.request',
      {
        prompt_id: 'p1',
        execution_generation: 2,
        command: 'rm -rf x',
        description: 'delete',
        choices: ['once', 'deny'],
      },
      2,
    );
    await tick();
    const asked = seen.find((event) => event.type === 'approval.requested')!;
    expect(asked).toMatchObject({ id: 'p1', command: 'rm -rf x', toolId: 't1' });
    await session.respond('p1', 'once');
    await tick();
    expect(socket.calls('approval.respond')).toEqual([
      { session_id: 'local-1', execution_generation: 2, prompt_id: 'p1', choice: 'once' },
    ]);

    socket.event(
      'local-1',
      'clarify.request',
      {
        prompt_id: 'q1',
        execution_generation: 2,
        question: 'Which?',
        choices: ['red (Recommended)', 'blue'],
      },
      2,
    );
    await tick();
    const question = seen.find((event) => event.type === 'question.asked')!;
    expect(question).toMatchObject({ question: 'Which?', choices: ['red (Recommended)', 'blue'] });
    await session.answer(String(question.id), 'red (Recommended)');
    await tick();
    expect(socket.calls('clarify.respond')).toEqual([
      { session_id: 'local-1', execution_generation: 2, prompt_id: 'q1', answer: 'red' },
    ]);
  });

  it('opens one socket per profile, each with its own ticket', async () => {
    const { channel, sockets, tickets } = scripted();
    await channel.request('session.create', { profile: 'work' });
    await channel.request('session.list', {});
    await channel.request('session.create', { profile: 'default' });
    expect(tickets).toEqual(['work', null]);
    expect(sockets).toHaveLength(2);
  });

  it('waits for a gateway that is starting, and says why when it never comes', async () => {
    let asked = 0;
    const channel = gatewayTuiChannel({
      bootstrap: async () => {
        asked += 1;
        return { kind: 'unavailable', reason: 'gateway starting: not ready' };
      },
      fallback: () => {
        throw new Error('no stdio here');
      },
      readyTimeoutMs: 30,
      retryMs: 5,
    });
    await expect(channel.request('session.create', {})).rejects.toThrow(
      'the Hermes gateway could not be reached (gateway starting: not ready)',
    );
    expect(asked).toBeGreaterThan(1);
    // Not given up for good: the next call asks again.
    await expect(channel.request('session.create', {})).rejects.toThrow();
  });

  it('is gone when the gateway closes the socket, and its sessions stop waiting', async () => {
    const { channel, sockets } = scripted();
    const session = await HermesTuiSession.open(channel, null);
    const reasons: string[] = [];
    channel.onExit((reason) => reasons.push(reason));
    const turn = session.send({ text: 'long' });
    // Admitted: the turn is running when the gateway goes away.
    await tick();
    await tick();
    await tick();
    expect(sockets[0]!.calls('prompt.submit')).toHaveLength(1);
    sockets[0]!.close(1012);
    expect(await turn).toEqual({ stopReason: 'failed' });
    expect(channel.alive).toBe(false);
    expect(reasons[0]).toContain('the Hermes gateway closed the connection (1012');
  });

  it('refuses a socket that does not speak the gateway protocol', async () => {
    const channel = gatewayTuiChannel({
      bootstrap: async () => ({ kind: 'attach', url: 'ws://x', protocols: [] }),
      fallback: () => {
        throw new Error('no stdio here');
      },
      socket: () => {
        const socket = new FakeGateway(() => ({}));
        socket.protocol = '';
        return socket;
      },
    });
    await expect(channel.request('session.list', {})).rejects.toThrow('answered with protocol');
  });

  it('speaks stdio to a Hermes that still serves a home beside its gateway', async () => {
    const calls: string[] = [];
    let exit: (reason: string) => void = () => {};
    const stdio: TuiChannel = {
      alive: true,
      pid: 777,
      busy: false,
      request: async (method) => {
        calls.push(method);
        return { session_id: 'live-1', stored_session_id: 'stored-1' };
      },
      attach: () => () => undefined,
      onExit: (listener) => {
        exit = listener;
        return () => undefined;
      },
      close: async () => undefined,
    };
    const channel = gatewayTuiChannel({
      bootstrap: async () => ({ kind: 'unsupported' }),
      fallback: () => stdio,
    });
    expect(channel.pid).toBeNull();
    await channel.request('session.create', { source: 'core-hub' });
    expect(calls).toEqual(['session.create']);
    expect(channel.pid).toBe(777);
    const reasons: string[] = [];
    channel.onExit((reason) => reasons.push(reason));
    exit('the Hermes TUI gateway exited (code 1)');
    expect(reasons).toEqual(['the Hermes TUI gateway exited (code 1)']);
    expect(channel.alive).toBe(false);
  });
});

describe('modelSelection', () => {
  it("reads the hub's config.set model value", () => {
    expect(modelSelection('gpt-6 --provider custom:x --session')).toEqual({
      model: 'gpt-6',
      provider: 'custom:x',
    });
    expect(modelSelection('qwen3 --session')).toEqual({ model: 'qwen3' });
  });
});
