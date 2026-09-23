/**
 * The TUI gateway adapter against a scripted process that speaks the same frames as
 * `python -m tui_gateway.entry` (ADR 0013). The real Hermes is exercised by
 * `hermes-tui.real.test.ts`; this is the fast one, and the one that can make a process die.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { HermesTuiSession, stdioTuiChannel, type Spawned } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

type Json = Record<string, unknown>;

/**
 * A fake gateway: answers calls with `script` (`null` answers with an error frame, as
 * Hermes does for a session it does not know), and can emit anything on command.
 */
function fakeGateway(script: (method: string, params: Json, api: Api) => Json | null | undefined) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
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
      exits.emit('exit', 1, null);
    },
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
    expect((await HermesTuiSession.open(channel, 'majlis-gone')).id).toBe('stored-8');
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
            result_text: '# Majlis',
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
    expect(events[2]).toMatchObject({ output: '# Majlis' });
    expect(events[4]).toMatchObject({ inputTokens: 12, outputTokens: 3 });
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
});
