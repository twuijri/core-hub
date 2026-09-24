/**
 * The Hermes adapter against a scripted Hermes: the `/v1/runs` frames documented in
 * docs/inspirations/hermes-agent.md §API server, played back without a socket, and the
 * adapter events they must become. The SSE parser is exercised on a real byte stream.
 */
import { describe, expect, it } from 'vitest';
import {
  HermesSession,
  createHermesAdapter,
  httpHermesTransport,
  parseSse,
  type HermesRunEvent,
  type HermesTransport,
} from './hermes.js';
import type { TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

/**
 * A Hermes that answers `createRun` with a run id and plays `frames` on `events`.
 *
 * It also answers the hub's **title question** (contract decision §26), which arrives as
 * an ordinary run in a conversation of its own (`corehub-ask-…`). It is kept apart from
 * `calls.createRun` and answered from `title` in one frame, so a test's script stays a
 * script of the conversation it is about and naming never races it.
 */
export function scriptedHermes(
  frames: HermesRunEvent[] | (() => HermesRunEvent[]),
  options: { title?: string } = {},
) {
  const calls: { createRun: unknown[]; ask: unknown[]; approve: string[]; stop: string[] } = {
    createRun: [],
    ask: [],
    approve: [],
    stop: [],
  };
  const asks = new Set<string>();
  let gate: (() => void) | null = null;
  const transport: HermesTransport = {
    async createRun(body) {
      if (body.session_id.startsWith('corehub-ask-')) {
        calls.ask.push(body);
        const runId = `ask_${calls.ask.length}`;
        asks.add(runId);
        return { run_id: runId };
      }
      calls.createRun.push(body);
      return { run_id: `run_${calls.createRun.length}` };
    },
    async *events(runId) {
      if (asks.has(runId)) {
        yield {
          event: 'run.completed',
          completed: true,
          output: options.title ?? 'عنوان من الوكيل',
        };
        return;
      }
      const script = typeof frames === 'function' ? frames() : frames;
      for (const frame of script) {
        if (frame.event === '__wait__') {
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
          continue;
        }
        yield frame;
      }
    },
    async approve(runId, choice) {
      calls.approve.push(`${runId}:${choice}`);
      gate?.();
      gate = null;
    },
    async stop(runId) {
      calls.stop.push(runId);
      gate?.();
      gate = null;
    },
  };
  return { transport, calls };
}

async function collect(session: HermesSession, until: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of session.stream()) {
    out.push(event);
    if (out.length >= until) break;
  }
  return out;
}

describe('Hermes session: one turn over /v1/runs', () => {
  it('maps deltas, tools, usage and the terminal frame, in order', async () => {
    const hermes = scriptedHermes([
      { event: 'run.started' },
      { event: 'message.started' },
      { event: 'message.delta', delta: 'سأشغّل ' },
      { event: 'tool.started', tool: 'terminal', preview: 'pnpm test' },
      { event: 'tool.progress', tool: 'terminal', delta: 'noise the hub drops' },
      {
        event: 'tool.completed',
        tool: 'terminal',
        duration: 0.4,
        error: false,
        preview: '30 passed',
      },
      { event: 'message.delta', delta: 'الاختبارات الآن.' },
      // What Hermes really puts here: the reply's own text, not reasoning (dropped).
      { event: 'reasoning.available', text: 'سأشغّل الاختبارات الآن.' },
      {
        event: 'run.completed',
        session_id: 'corehub-s1',
        completed: true,
        partial: false,
        interrupted: false,
        output: 'سأشغّل الاختبارات الآن.',
        usage: {
          input_tokens: 2300,
          output_tokens: 410,
          total_tokens: 2710,
          cache_read_tokens: 12,
        },
        runtime: { provider: 'nous', model: 'hermes-4' },
      },
    ]);
    const session = new HermesSession(hermes.transport, { sessionRef: 'corehub-s1', model: null });
    const events = collect(session, 6);
    const turn = await session.send({ text: 'شغّل الاختبارات' });
    expect(turn).toEqual({ stopReason: 'completed' });
    expect(hermes.calls.createRun).toEqual([{ input: 'شغّل الاختبارات', session_id: 'corehub-s1' }]);
    expect(await events).toEqual([
      { type: 'message.delta', text: 'سأشغّل ' },
      {
        type: 'tool.started',
        id: 'tool-1',
        name: 'terminal',
        title: 'pnpm test',
        kind: 'terminal',
        input: { preview: 'pnpm test' },
        raw: expect.objectContaining({ event: 'tool.started' }),
      },
      {
        type: 'tool.completed',
        id: 'tool-1',
        title: 'terminal',
        output: '30 passed',
        raw: expect.objectContaining({ event: 'tool.completed' }),
      },
      { type: 'message.delta', text: 'الاختبارات الآن.' },
      {
        type: 'usage',
        modelLabel: 'hermes-4',
        providerId: 'nous',
        inputTokens: 2300,
        outputTokens: 410,
        cacheReadTokens: 12,
      },
      { type: 'run.completed', stopReason: 'completed' },
    ]);
  });

  it('sends the model and the reasoning effort the run asked for', async () => {
    const hermes = scriptedHermes([{ event: 'run.completed', completed: true, output: 'ok' }]);
    const session = new HermesSession(hermes.transport, {
      sessionRef: 'corehub-s2',
      model: 'hermes-4-405b',
      reasoningEffort: 'high',
    });
    await session.send({ text: 'hi' });
    expect(hermes.calls.createRun[0]).toEqual({
      input: 'hi',
      session_id: 'corehub-s2',
      model: 'hermes-4-405b',
      model_options: { reasoning_effort: 'high' },
    });
  });

  it('delivers the final `output` as one delta when nothing was streamed', async () => {
    const hermes = scriptedHermes([
      { event: 'run.completed', completed: true, output: 'مرحبا', usage: {} },
    ]);
    const session = new HermesSession(hermes.transport, { sessionRef: 'corehub-s3' });
    const events = collect(session, 3);
    await session.send({ text: 'قل مرحبا' });
    expect(await events).toEqual([
      { type: 'usage', modelLabel: null, providerId: null },
      { type: 'message.delta', text: 'مرحبا' },
      { type: 'run.completed', stopReason: 'completed' },
    ]);
  });

  it('turns an approval request into a choice list and answers it on the run', async () => {
    const hermes = scriptedHermes([
      { event: 'tool.started', tool: 'terminal', preview: 'rm -rf build' },
      {
        event: 'approval.request',
        command: 'rm -rf build',
        description: 'Delete the build directory',
        pattern_key: 'rm -rf',
        allow_permanent: true,
        allow_session: true,
        choices: ['once', 'session', 'always', 'deny'],
      },
      { event: '__wait__' },
      { event: 'approval.responded', choice: 'session', resolved: 1 },
      { event: 'tool.completed', tool: 'terminal', duration: 0.1, error: false, preview: '' },
      { event: 'run.completed', completed: true, output: 'حذفت المجلد.' },
    ]);
    const session = new HermesSession(hermes.transport, { sessionRef: 'corehub-s4' });
    const first = collect(session, 2);
    const turn = session.send({ text: 'نظّف' });
    const [started, approval] = await first;
    expect(started).toMatchObject({ type: 'tool.started', id: 'tool-1' });
    expect(approval).toEqual({
      type: 'approval.requested',
      id: 'approval-2',
      title: 'Delete the build directory',
      description: 'Delete the build directory',
      command: 'rm -rf build',
      toolId: 'tool-1',
      options: [
        { id: 'once', label: 'Allow once', kind: 'once' },
        { id: 'session', label: 'Allow for this session', kind: 'session' },
        { id: 'always', label: 'Always allow', kind: 'always' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    });
    await session.respond('approval-2', 'session');
    expect(hermes.calls.approve).toEqual(['run_1:session']);
    expect(await turn).toEqual({ stopReason: 'completed' });
    const rest = await collect(session, 3);
    expect(rest.map((e) => e.type)).toEqual(['tool.completed', 'message.delta', 'run.completed']);
  });

  it('reports a stopped run as an interrupted completion and a failed one as failed', async () => {
    const stopped = scriptedHermes([
      { event: 'message.delta', delta: 'part' },
      { event: '__wait__' },
      { event: 'run.cancelled', completed: false, interrupted: true },
    ]);
    const a = new HermesSession(stopped.transport, { sessionRef: 'corehub-s5' });
    const turnA = a.send({ text: 'go' });
    await collect(a, 1);
    await a.interrupt();
    expect(stopped.calls.stop).toEqual(['run_1']);
    expect(await turnA).toEqual({ stopReason: 'cancelled' });
    expect((await collect(a, 1))[0]).toEqual({
      type: 'run.completed',
      stopReason: 'cancelled',
      interrupted: true,
    });

    const failed = scriptedHermes([
      { event: 'run.failed', completed: false, error: 'No API key configured for provider' },
    ]);
    const b = new HermesSession(failed.transport, { sessionRef: 'corehub-s6' });
    expect(await b.send({ text: 'go' })).toEqual({ stopReason: 'failed' });
    expect((await collect(b, 1))[0]).toEqual({
      type: 'run.failed',
      error: 'No API key configured for provider',
    });
  });

  it('fails the turn, not the process, when the stream ends without a terminal frame', async () => {
    const hermes = scriptedHermes([{ event: 'message.delta', delta: 'half' }]);
    const session = new HermesSession(hermes.transport, { sessionRef: 'corehub-s7' });
    expect(await session.send({ text: 'go' })).toEqual({ stopReason: 'failed' });
    expect(await collect(session, 2)).toEqual([
      { type: 'message.delta', text: 'half' },
      { type: 'run.failed', error: 'Hermes closed the event stream early' },
    ]);
  });

  it('refuses a second turn while one is in flight', async () => {
    const hermes = scriptedHermes([
      { event: '__wait__' },
      { event: 'run.completed', completed: true },
    ]);
    const session = new HermesSession(hermes.transport, { sessionRef: 'corehub-s8' });
    const first = session.send({ text: 'one' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(session.send({ text: 'two' })).rejects.toMatchObject({ code: 'already_running' });
    await session.interrupt();
    await first;
  });
});

describe('Hermes transport: the wire', () => {
  it('parses SSE frames as Hermes writes them, skipping keepalives', async () => {
    const chunks = [
      ': keepalive\n\n',
      'data: {"event":"run.started","run_id":"run_1"}\n\n',
      'data: {"event":"message.delta","run_id":"run_1","del',
      'ta":"hi"}\n\n: stream closed\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const events: HermesRunEvent[] = [];
    for await (const event of parseSse(body)) events.push(event);
    expect(events).toEqual([
      { event: 'run.started', run_id: 'run_1' },
      { event: 'message.delta', run_id: 'run_1', delta: 'hi' },
    ]);
  });

  it('sends the bearer key on every call and reads Hermes error envelopes', async () => {
    const seen: { url: string; method: string; auth: string | null; body: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        method: init?.method ?? 'GET',
        auth: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (String(input).endsWith('/v1/runs')) {
        return new Response(JSON.stringify({ run_id: 'run_9', status: 'started' }), {
          status: 202,
        });
      }
      if (String(input).endsWith('/stop')) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Invalid gateway API key (API_SERVER_KEY)',
              code: 'gateway_auth_failed',
            },
          }),
          { status: 401 },
        );
      }
      return new Response('{}', { status: 200 });
    };
    const transport = httpHermesTransport({
      endpoint: 'http://hermes.test:8642/',
      apiKey: 'k'.repeat(32),
      fetchImpl,
    });
    const accepted = await transport.createRun(
      { input: 'hi', session_id: 'corehub-x' },
      new AbortController().signal,
    );
    expect(accepted).toEqual({ run_id: 'run_9' });
    await transport.approve('run_9', 'once');
    await expect(transport.stop('run_9')).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: expect.stringContaining('gateway_auth_failed'),
    });
    expect(seen.map((s) => [s.method, s.url, s.auth])).toEqual([
      ['POST', 'http://hermes.test:8642/v1/runs', `Bearer ${'k'.repeat(32)}`],
      ['POST', 'http://hermes.test:8642/v1/runs/run_9/approval', `Bearer ${'k'.repeat(32)}`],
      ['POST', 'http://hermes.test:8642/v1/runs/run_9/stop', `Bearer ${'k'.repeat(32)}`],
    ]);
    expect(seen[1]?.body).toBe('{"choice":"once"}');
  });

  it('starts a session through the adapter with an injected transport', async () => {
    const hermes = scriptedHermes([{ event: 'run.completed', completed: true, output: 'ok' }]);
    const adapter = createHermesAdapter({
      host: { pathValue: '/nowhere-at-all' },
      transport: () => hermes.transport,
    });
    const session = await adapter.start({
      slug: 'hermes',
      name: 'Hermes',
      command: ['hermes'],
      executablePath: null,
      endpoint: null,
      sessionRef: 'corehub-adapter',
    });
    expect(session.id).toBe('corehub-adapter');
    expect(await session.send({ text: 'hi' })).toEqual({ stopReason: 'completed' });
    await session.close();
  });

  describe('a conversation in its profile (ADR 0014 stage 3)', () => {
    /** A TUI channel that records every call and answers `session.create`. */
    function recordingChannel() {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const channel: TuiChannel = {
        alive: true,
        busy: false,
        request: async (method, params) => {
          calls.push({ method, params });
          return method === 'session.create' ? { session_id: 'l1', stored_session_id: 's1' } : {};
        },
        attach: () => () => undefined,
        onExit: () => () => undefined,
        close: async () => undefined,
      };
      return { channel, calls };
    }
    const target = {
      slug: 'hermes',
      name: 'Hermes',
      command: ['hermes'],
      executablePath: null,
      endpoint: null,
      sessionRef: 'corehub-x',
    };

    it('makes sure the profile exists, then opens the conversation there', async () => {
      const { channel, calls } = recordingChannel();
      const ensured: string[] = [];
      const adapter = createHermesAdapter({
        host: { pathValue: '/nowhere-at-all' },
        tui: () => channel,
        ensureProfile: async (name) => {
          ensured.push(name);
          calls.push({ method: '(ensure)', params: { name } });
        },
      });
      await adapter.start({ ...target, profile: 'design', cwd: '/data/workspaces/design/x' });
      expect(ensured).toEqual(['design']);
      expect(calls.map((c) => c.method)).toEqual(['(ensure)', 'session.resume', 'session.create']);
      expect(calls[2]?.params).toMatchObject({
        profile: 'design',
        cwd: '/data/workspaces/design/x',
      });
    });

    it("never makes Hermes's default profile, and refuses the turn when a profile cannot be made", async () => {
      const { channel } = recordingChannel();
      const ensured: string[] = [];
      const adapter = createHermesAdapter({
        host: { pathValue: '/nowhere-at-all' },
        tui: () => channel,
        ensureProfile: async (name) => {
          ensured.push(name);
          if (name === 'broken') throw new Error('Hermes said no');
        },
      });
      await adapter.start({ ...target, profile: 'default' });
      await adapter.start({ ...target, profile: null });
      expect(ensured).toEqual([]);
      await expect(adapter.start({ ...target, profile: 'broken' })).rejects.toThrow(
        'Hermes said no',
      );
    });
  });
});
