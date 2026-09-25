/**
 * The TUI gateway adapter against a scripted process that speaks the same frames as
 * `python -m tui_gateway.entry` (ADR 0013). The real Hermes is exercised by
 * `hermes-tui.real.test.ts`; this is the fast one, and the one that can make a process die.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import {
  HermesTuiSession,
  parseFallbackNote,
  stdioTuiChannel,
  type Spawned,
} from './hermes-tui.js';
import type { AgentEvent } from './types.js';

type Json = Record<string, unknown>;

/**
 * A fake gateway: answers calls with `script` (`null` answers with an error frame, as
 * Hermes does for a session it does not know), and can emit anything on command.
 */
function fakeGateway(script: (method: string, params: Json, api: Api) => Json | null | undefined) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exits = new EventEmitter();
  const received: Array<{
    method?: string;
    id?: unknown;
    params?: Json;
    result?: unknown;
    error?: unknown;
  }> = [];
  const api: Api = {
    event(sid, type, payload = {}) {
      stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sid, payload } })}\n`,
      );
    },
    ask(sid, method, params, id) {
      stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params: { session_id: sid, ...params } })}\n`,
      );
    },
    die() {
      stderr.end();
      exits.emit('exit', 1, null);
    },
    exit(code, lines) {
      // What `tui_gateway/entry.py` does on every way out: a line on stderr, then exit 0.
      stderr.end(lines.map((line) => `${line}\n`).join(''));
      exits.emit('exit', code, null);
    },
    stderr,
    received,
  };
  createInterface({ input: stdin }).on('line', (line) => {
    const frame = JSON.parse(line) as {
      id?: number | string;
      method?: string;
      params?: Json;
      result?: unknown;
      error?: unknown;
    };
    received.push(frame);
    if (!frame.method) return; // a response to one of our requests
    const result = script(frame.method, frame.params ?? {}, api);
    if (result === null) {
      stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 4040, message: 'session not found' } })}\n`,
      );
    } else if (result !== undefined) {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`);
    }
  });
  const spawned: Spawned = {
    stdin,
    stdout,
    stderr,
    kill: () => exits.emit('exit', null, 'SIGTERM'),
    on: (event, listener) => exits.on(event, listener),
  };
  setImmediate(() => api.event('', 'gateway.ready'));
  return { spawn: () => spawned, api };
}

interface Api {
  event(sid: string, type: string, payload?: Json): void;
  ask(sid: string, method: string, params: Json, id: string): void;
  die(): void;
  /** Exit with `code` after writing `lines` to stderr. */
  exit(code: number, lines: string[]): void;
  stderr: PassThrough;
  received: Array<{ method?: string; id?: unknown; result?: unknown; error?: unknown }>;
}

function channelOver(gateway: ReturnType<typeof fakeGateway>) {
  return stdioTuiChannel({ command: 'python', args: [], env: {}, spawn: gateway.spawn });
}

async function collect(session: HermesTuiSession, until: (e: AgentEvent) => boolean) {
  const events: AgentEvent[] = [];
  for await (const event of session.stream()) {
    events.push(event);
    if (until(event)) break;
  }
  return events;
}

const terminal = (e: AgentEvent) => e.type === 'run.completed' || e.type === 'run.failed';

describe('Hermes over the TUI gateway', () => {
  it('opens a session and reports the stored id as the conversation', async () => {
    const gateway = fakeGateway((method) =>
      method === 'session.create' ? { session_id: 'live1', stored_session_id: 'stored-1' } : {},
    );
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    expect(session.id).toBe('stored-1');
  });

  it('resumes a stored conversation, and starts afresh when Hermes no longer has it', async () => {
    const gateway = fakeGateway((method, params) => {
      if (method === 'session.resume') {
        return params.session_id === 'stored-7'
          ? { session_id: 'live7', stored_session_id: 'stored-7' }
          : null;
      }
      if (method === 'session.create')
        return { session_id: 'live8', stored_session_id: 'stored-8' };
      return {};
    });
    const channel = channelOver(gateway);
    expect((await HermesTuiSession.open(channel, 'stored-7')).id).toBe('stored-7');
    expect((await HermesTuiSession.open(channel, 'corehub-gone')).id).toBe('stored-8');
  });

  it("opens a conversation in the workspace's own profile and working folder", async () => {
    const calls: Array<{ method: string; params: Json }> = [];
    const gateway = fakeGateway((method, params) => {
      calls.push({ method, params });
      if (method === 'session.create') return { session_id: 'live1', stored_session_id: 'st-1' };
      return {};
    });
    await HermesTuiSession.open(channelOver(gateway), null, {
      profile: 'design',
      cwd: '/data/workspaces/design/s1',
    });
    expect(calls).toEqual([
      {
        method: 'session.create',
        params: { source: 'corehub', profile: 'design', cwd: '/data/workspaces/design/s1' },
      },
    ]);
  });

  it('resumes in the profile it was stored in, and moves it to the working folder', async () => {
    const calls: Array<{ method: string; params: Json }> = [];
    const gateway = fakeGateway((method, params) => {
      calls.push({ method, params });
      if (method === 'session.resume') {
        return {
          session_id: 'live7',
          stored_session_id: 'stored-7',
          info: { cwd: '/data/hermes' },
        };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), 'stored-7', {
      profile: 'design',
      cwd: '/data/workspaces/design/s1',
    });
    expect(session.id).toBe('stored-7');
    expect(calls).toEqual([
      {
        method: 'session.resume',
        params: { session_id: 'stored-7', omit_messages: true, profile: 'design' },
      },
      {
        method: 'session.cwd.set',
        params: { session_id: 'live7', cwd: '/data/workspaces/design/s1' },
      },
    ]);
  });

  it("sends no profile for Hermes's default one — the root home, as before", async () => {
    const calls: Array<{ method: string; params: Json }> = [];
    const gateway = fakeGateway((method, params) => {
      calls.push({ method, params });
      if (method === 'session.resume') {
        return { session_id: 'l', stored_session_id: 's', info: { cwd: '/w/default/s' } };
      }
      return { session_id: 'l2', stored_session_id: 's2' };
    });
    const channel = channelOver(gateway);
    await HermesTuiSession.open(channel, 's', { profile: 'default', cwd: '/w/default/s' });
    await HermesTuiSession.open(channel, null, { profile: null });
    expect(calls).toEqual([
      { method: 'session.resume', params: { session_id: 's', omit_messages: true } },
      { method: 'session.create', params: { source: 'corehub' } },
    ]);
  });

  it("carries the model's reasoning, each tool's result, and the usage", async () => {
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() => {
          api.event('s', 'thinking.delta', { text: '(°ロ°) pondering...' });
          api.event('s', 'reasoning.delta', { text: 'The user wants a file.' });
          api.event('s', 'tool.start', {
            tool_id: 't1',
            name: 'read_file',
            context: 'README.md',
            args: { path: 'README.md' },
          });
          api.event('s', 'tool.complete', {
            tool_id: 't1',
            name: 'read_file',
            duration_s: 0.1,
            result_text: '# Core Hub',
          });
          api.event('s', 'message.delta', { text: 'قرأته.' });
          api.event('s', 'reasoning.available', { text: 'قرأته.' });
          api.event('s', 'message.complete', {
            text: 'قرأته.',
            status: 'complete',
            usage: { model: 'm', input: 12, output: 3 },
          });
        });
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, terminal);
    await session.send({ text: 'read it' });
    const events = await reading;
    expect(events.map((e) => e.type)).toEqual([
      'reasoning.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
      'usage',
      'run.completed',
    ]);
    expect(events[0]).toMatchObject({ text: 'The user wants a file.' });
    expect(events[1]).toMatchObject({
      name: 'read_file',
      title: 'README.md',
      input: { path: 'README.md' },
    });
    expect(events[2]).toMatchObject({ output: '# Core Hub' });
    expect(events[4]).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });

  it("records each turn's own tokens, though Hermes reports its session's running total", async () => {
    // Hermes's `message.complete` usage adds up across the turns of a live session; a
    // counter that goes down means it started the session's agent afresh.
    const totals = [
      { model: 'm', input: 12, output: 3 },
      { model: 'm', input: 30, output: 8 },
      { model: 'm', input: 4, output: 1 },
    ];
    let turn = 0;
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        const usage = totals[turn++];
        setImmediate(() => {
          api.event('s', 'message.delta', { text: 'ok' });
          api.event('s', 'message.complete', { text: 'ok', status: 'complete', usage });
        });
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reported: Array<{ inputTokens?: number; outputTokens?: number }> = [];
    for (let i = 0; i < totals.length; i += 1) {
      const reading = collect(session, terminal);
      await session.send({ text: `turn ${i + 1}` });
      const usage = (await reading).find((e) => e.type === 'usage') as
        { inputTokens?: number; outputTokens?: number } | undefined;
      reported.push({ inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
    }
    expect(reported).toEqual([
      { inputTokens: 12, outputTokens: 3 },
      { inputTokens: 18, outputTokens: 5 },
      { inputTokens: 4, outputTokens: 1 },
    ]);
  });

  it('asks the person, and answers Hermes with their words, or "" when they skip', async () => {
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() => {
          api.event('s', 'tool.start', { tool_id: 'c1', name: 'clarify', args: {} });
          api.ask(
            's',
            'clarify',
            { question: 'Which?', choices: ['A (Recommended)', 'B'] },
            'srq-1',
          );
        });
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, (e) => e.type === 'question.asked');
    void session.send({ text: 'ask' });
    const [, question] = await reading;
    expect(question).toMatchObject({
      type: 'question.asked',
      question: 'Which?',
      choices: ['A (Recommended)', 'B'],
      toolId: 'c1',
    });
    await session.answer((question as { id: string }).id, 'A (Recommended)');
    await new Promise((resolve) => setImmediate(resolve));
    expect(gateway.api.received.find((f) => f.id === 'srq-1')).toMatchObject({
      result: { answer: 'A' },
    });
  });

  it('asks a batch one question at a time, and gives Hermes the whole set by qid', async () => {
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() =>
          api.ask(
            's',
            'clarify',
            {
              questions: [
                { qid: 'q0', question: 'Which device?', choices: ['Mac (Recommended)', 'PC'] },
                { qid: 'q1', question: 'Anything else?', choices: [] },
                { qid: 'q2', question: 'Which OS?', choices: ['macOS', 'Linux'] },
              ],
            },
            'srq-9',
          ),
        );
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const asked: Array<Extract<AgentEvent, { type: 'question.asked' }>> = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        if (event.type !== 'question.asked') continue;
        asked.push(event);
        // Chosen, skipped, and written by hand.
        const replies = ['Mac (Recommended)', null, 'Ubuntu'];
        await session.answer(event.id, replies[asked.length - 1] ?? null);
        if (asked.length === 3) return;
      }
    })();
    void session.send({ text: 'ask me three things' });
    await reading;
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked.map((q) => [q.question, q.choices])).toEqual([
      ['Which device?', ['Mac (Recommended)', 'PC']],
      ['Anything else?', []],
      ['Which OS?', ['macOS', 'Linux']],
    ]);
    expect(gateway.api.received.find((f) => f.id === 'srq-9')).toMatchObject({
      result: { answers: { q0: 'Mac', q1: '', q2: 'Ubuntu' } },
    });
  });

  it('turns an approval into the choices Hermes offers, and sends back the one chosen', async () => {
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() =>
          api.ask(
            's',
            'approval',
            {
              request_id: 'r1',
              command: 'rm -rf build',
              description: 'delete build',
              choices: ['once', 'session', 'deny'],
            },
            'srq-2',
          ),
        );
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, (e) => e.type === 'approval.requested');
    void session.send({ text: 'clean' });
    const [approval] = await reading;
    expect(approval).toMatchObject({
      id: 'r1',
      command: 'rm -rf build',
      options: [{ id: 'once' }, { id: 'session' }, { id: 'deny' }],
    });
    await session.respond('r1', 'deny');
    await new Promise((resolve) => setImmediate(resolve));
    expect(gateway.api.received.find((f) => f.id === 'srq-2')).toMatchObject({
      result: { choice: 'deny' },
    });
  });

  it('refuses at once what the hub cannot answer, so the agent is not left waiting', async () => {
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() => api.ask('s', 'secret', { prompt: 'API key?' }, 'srq-3'));
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    void session.send({ text: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.api.received.find((f) => f.id === 'srq-3')).toMatchObject({
      error: { code: -32000 },
    });
  });

  it('switches this session to the model a turn names, and only when it changes', async () => {
    const gateway = fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() => api.event('s', 'message.complete', { text: '', status: 'complete' }));
        return { status: 'streaming' };
      }
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null, {
      model: 'm1',
      provider: 'p1',
    });
    const turn = async (prompt: Parameters<HermesTuiSession['send']>[0]) => {
      const reading = collect(session, terminal);
      await session.send(prompt);
      await reading;
    };
    await turn({ text: 'a', model: 'm1', modelProvider: 'p1' });
    await turn({ text: 'b', model: 'm2', modelProvider: 'p1', reasoningEffort: 'high' });
    await turn({ text: 'c', model: 'm2', modelProvider: 'p1', reasoningEffort: 'high' });
    const sets = gateway.api.received
      .filter((frame) => frame.method === 'config.set')
      .map((frame) => (frame as { params?: Json }).params);
    expect(sets).toEqual([
      { session_id: 's', key: 'model', value: 'm2 --provider p1 --session' },
      { session_id: 's', key: 'reasoning', value: 'high', scope: 'session' },
    ]);
  });

  it('fails the turn, and closes, when the gateway process dies under it', async () => {
    const gateway = fakeGateway((method) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') return { status: 'streaming' };
      return {};
    });
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, terminal);
    const sent = session.send({ text: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    gateway.api.die();
    expect(await sent).toEqual({ stopReason: 'failed' });
    expect((await reading).at(-1)).toMatchObject({ type: 'run.failed' });
    expect(session.closed).toBe(true);
  });

  it('says why the gateway exited: the reason it printed on stderr, not only "code 0"', async () => {
    const gateway = fakeGateway((method) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') return { status: 'streaming' };
      return {};
    });
    const channel = channelOver(gateway);
    const reasons: string[] = [];
    channel.onExit((reason) => reasons.push(reason));
    const session = await HermesTuiSession.open(channel, null);
    const reading = collect(session, terminal);
    const sent = session.send({ text: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(channel.busy).toBe(true);
    gateway.api.exit(0, [
      'Traceback (most recent call last): something the hub must not keep',
      '[gateway-exit] stdin EOF (peer closed)',
    ]);
    expect(await sent).toEqual({ stopReason: 'failed' });
    const failure = (await reading).at(-1);
    expect(failure).toEqual({
      type: 'run.failed',
      error: 'the Hermes TUI gateway exited (code 0: stdin EOF (peer closed))',
    });
    expect(reasons).toEqual(['the Hermes TUI gateway exited (code 0: stdin EOF (peer closed))']);
    expect(channel.alive).toBe(false);
    expect(channel.busy).toBe(false);
  });

  it('names a signal, joins a line split across writes, and never keeps other stderr', async () => {
    const reasonOf = async (gateway: ReturnType<typeof fakeGateway>, act: () => void) => {
      const channel = channelOver(gateway);
      const reason = new Promise<string>((resolve) => channel.onExit(resolve));
      act();
      return reason;
    };
    const signalled = fakeGateway(() => ({}));
    expect(
      await reasonOf(signalled, () => signalled.api.exit(0, ['[gateway-signal] SIGTERM'])),
    ).toBe('the Hermes TUI gateway exited (code 0: signal SIGTERM)');
    const split = fakeGateway(() => ({}));
    expect(
      await reasonOf(split, () => {
        split.api.stderr.write('[gateway-exit] stdin EOF');
        split.api.stderr.write(' (peer closed)\nan ordinary log line\n');
        split.api.die();
      }),
    ).toBe('the Hermes TUI gateway exited (code 1: stdin EOF (peer closed))');
    const plain = fakeGateway(() => ({}));
    expect(await reasonOf(plain, () => plain.api.exit(0, ['an ordinary log line']))).toBe(
      'the Hermes TUI gateway exited (code 0)',
    );
  });

  it('reports the exit after a short grace when stderr is still open', async () => {
    const stderr = new PassThrough();
    const exits = new EventEmitter();
    const channel = stdioTuiChannel({
      command: 'python',
      args: [],
      env: {},
      exitGraceMs: 5,
      spawn: () => ({
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        kill: () => exits.emit('exit', null, 'SIGTERM'),
        on: (event, listener) => exits.on(event, listener),
      }),
    });
    const reason = new Promise<string>((resolve) => channel.onExit(resolve));
    stderr.write('[gateway-exit] broken stdout pipe\n');
    await new Promise((resolve) => setImmediate(resolve));
    exits.emit('exit', 0, null);
    // Gone for callers at once, even while its last words are still being read.
    expect(channel.alive).toBe(false);
    expect(await reason).toBe('the Hermes TUI gateway exited (code 0: broken stdout pipe)');
  });
});

describe('Hermes moving down its fallback chain (contract decision §54)', () => {
  const chain = [
    { providerId: 'P2', provider: 'openai-codex', slug: 'openai-codex', model: 'gpt-5.5' },
  ];

  function answeringOn(model: string, notes: string[]) {
    return fakeGateway((method, _params, api) => {
      if (method === 'session.create') return { session_id: 's', stored_session_id: 'st' };
      if (method === 'prompt.submit') {
        setImmediate(() => {
          for (const text of notes) api.event('s', 'status.update', { kind: 'status', text });
          api.event('s', 'message.delta', { text: 'answered' });
          api.event('s', 'message.complete', {
            text: 'answered',
            status: 'complete',
            usage: { model, input: 5, output: 1 },
          });
        });
        return { status: 'streaming' };
      }
      return {};
    });
  }

  it("names the switch in the hub's words, with Hermes's reason", async () => {
    const gateway = answeringOn('gpt-5.5', [
      '⚠️ Model fallback: gemini-3.8-flash-high via corehub-proxy unavailable (HTTP 503: auth_unavailable); using gpt-5.5 via openai-codex.',
    ]);
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, terminal);
    await session.send({
      text: 'hi',
      model: 'gemini-3.8-flash-high',
      modelProvider: 'corehub-proxy',
      modelProviderSlug: 'proxy',
      fallbacks: chain,
    });
    const events = await reading;
    const fallback = events.find((e) => e.type === 'model.fallback');
    expect(fallback).toEqual({
      type: 'model.fallback',
      failed: [
        {
          model: 'gemini-3.8-flash-high',
          provider: 'proxy',
          code: null,
          error: 'HTTP 503: auth_unavailable',
        },
      ],
      answered: { model: 'gpt-5.5', provider: 'openai-codex' },
    });
    // Said before the turn ends, so the run is the answering model's when it does.
    expect(events.map((e) => e.type).indexOf('model.fallback')).toBeLessThan(
      events.map((e) => e.type).indexOf('run.completed'),
    );
  });

  it('reads a switch from the usage when Hermes said nothing about it', async () => {
    const gateway = answeringOn('gpt-5.5', []);
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, terminal);
    await session.send({
      text: 'hi',
      model: 'primary-model',
      modelProvider: 'corehub-proxy',
      modelProviderSlug: 'proxy',
      fallbacks: chain,
    });
    const fallback = (await reading).find((e) => e.type === 'model.fallback');
    expect(fallback).toMatchObject({
      failed: [{ model: 'primary-model', provider: 'proxy', code: null, error: null }],
      answered: { model: 'gpt-5.5', provider: 'openai-codex' },
    });
  });

  it('says nothing when the chosen model answered', async () => {
    const gateway = answeringOn('primary-model', []);
    const session = await HermesTuiSession.open(channelOver(gateway), null);
    const reading = collect(session, terminal);
    await session.send({ text: 'hi', model: 'primary-model', fallbacks: chain });
    expect((await reading).some((e) => e.type === 'model.fallback')).toBe(false);
  });

  it("reads Hermes's line back into its parts, and nothing else", () => {
    expect(
      parseFallbackNote(
        '⚠️ Model fallback: a/b-1.5 via openrouter unavailable (rate limit (429)); using c via nous. Primary retry eligible in ~30 s; recovery is not guaranteed.',
      ),
    ).toEqual({
      from: 'a/b-1.5',
      fromProvider: 'openrouter',
      reason: 'rate limit (429)',
      to: 'c',
      toProvider: 'nous',
    });
    expect(parseFallbackNote('✓ Context compression complete')).toBeNull();
    expect(parseFallbackNote(null)).toBeNull();
  });
});
