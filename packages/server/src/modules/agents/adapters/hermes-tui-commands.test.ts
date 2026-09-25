/**
 * The composer's commands over Hermes's TUI gateway (decision §57), against a scripted
 * process speaking the gateway's frames: which JSON-RPC method each command becomes, what
 * the adapter does with Hermes's answer, and how compression inside a turn is reported.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { HubError } from '../../../lib/errors.js';
import {
  HermesTuiSession,
  agentCommandOf,
  compressOutcomeOf,
  stdioTuiChannel,
  type Spawned,
} from './hermes-tui.js';
import type { AgentEvent } from './types.js';

type Json = Record<string, unknown>;
type Frame = { id?: number | string; method?: string; params?: Json };

/**
 * A fake gateway. `script` answers a call: a `Json` result, `{error: {code, message}}` for
 * an error frame, or `undefined` for no answer yet. `emit` sends a session event.
 */
function fakeGateway(script: (method: string, params: Json, emit: Emit) => unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exits = new EventEmitter();
  const calls: Frame[] = [];
  const emit: Emit = (sid, type, payload = {}) =>
    stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sid, payload } })}\n`,
    );
  createInterface({ input: stdin }).on('line', (line) => {
    const frame = JSON.parse(line) as Frame;
    if (!frame.method) return;
    calls.push(frame);
    const answer = script(frame.method, frame.params ?? {}, emit);
    if (answer === undefined) return;
    const error = (answer as { error?: unknown }).error;
    stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(error ? { error } : { result: answer }) })}\n`,
    );
  });
  const spawned: Spawned = {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => exits.emit('exit', null, 'SIGTERM'),
    on: (event, listener) => exits.on(event, listener),
  };
  setImmediate(() => emit('', 'gateway.ready'));
  const channel = stdioTuiChannel({ command: 'python', args: [], env: {}, spawn: () => spawned });
  return { channel, calls, emit };
}
type Emit = (sid: string, type: string, payload?: Json) => void;

const methods = (calls: Frame[]) => calls.map((call) => call.method);
const terminal = (e: AgentEvent) => e.type === 'run.completed' || e.type === 'run.failed';

async function turn(session: HermesTuiSession, text: string) {
  const events: AgentEvent[] = [];
  const reading = (async () => {
    for await (const event of session.stream()) {
      events.push(event);
      if (terminal(event)) break;
    }
  })();
  const sent = session.send({ text, blocks: [{ type: 'text', text }] });
  await Promise.all([sent, reading]);
  return events;
}

/** Answers `session.create` and completes every submitted prompt with `reply`. */
function conversation(extra: (method: string, params: Json, emit: Emit) => unknown = () => ({})) {
  return fakeGateway((method, params, emit) => {
    if (method === 'session.create') return { session_id: 'live1', stored_session_id: 'stored1' };
    if (method === 'prompt.submit') {
      setImmediate(() => {
        emit('live1', 'message.delta', { text: `echo: ${String(params.text)}` });
        emit('live1', 'message.complete', { status: 'complete' });
      });
      return {};
    }
    return extra(method, params, emit);
  });
}

describe('which words are Hermes commands', () => {
  it('reads /goal, /plan, /learn and /skill <name>, and leaves everything else a message', () => {
    expect(agentCommandOf('/plan add a login page')).toEqual({
      name: 'plan',
      arg: 'add a login page',
      typed: 'plan',
    });
    expect(agentCommandOf('/goal')).toEqual({ name: 'goal', arg: '', typed: 'goal' });
    expect(agentCommandOf('  /learn this chat\nand the notes ')).toEqual({
      name: 'learn',
      arg: 'this chat\nand the notes',
      typed: 'learn',
    });
    expect(agentCommandOf('/skill code-review look at the diff')).toEqual({
      name: 'code-review',
      arg: 'look at the diff',
      typed: 'skill code-review',
    });
    expect(agentCommandOf('/skill Code_Review now')).toMatchObject({ name: 'code-review' });
    for (const text of [
      '/skill',
      '/compress',
      '/steer go left',
      '/unknown thing',
      'plan it',
      '/Plan x',
    ])
      expect(agentCommandOf(text), text).toBeNull();
  });
});

describe('commands over the TUI gateway', () => {
  it('/plan becomes command.dispatch, and the prompt Hermes built is the turn', async () => {
    const gateway = conversation((method) =>
      method === 'command.dispatch'
        ? { type: 'send', message: 'PLAN PROMPT: add a login page' }
        : {},
    );
    const session = await HermesTuiSession.open(gateway.channel, null);
    const events = await turn(session, '/plan add a login page');
    const dispatch = gateway.calls.find((call) => call.method === 'command.dispatch');
    expect(dispatch?.params).toEqual({
      session_id: 'live1',
      name: 'plan',
      arg: 'add a login page',
    });
    const submit = gateway.calls.find((call) => call.method === 'prompt.submit');
    expect(submit?.params?.text).toBe('PLAN PROMPT: add a login page');
    expect(events.at(-1)).toEqual({ type: 'run.completed', stopReason: 'completed' });
  });

  it('/skill <name> dispatches the skill by its own name and keeps what the hub added after it', async () => {
    const gateway = conversation((method) =>
      method === 'command.dispatch'
        ? { type: 'skill', name: 'code-review', message: 'SKILL BODY', display: '/code-review' }
        : {},
    );
    const session = await HermesTuiSession.open(gateway.channel, null);
    const typed = '/skill code-review the diff';
    const full = `${typed}\n\nAttached files (read them from these paths):\n- a.txt`;
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (terminal(event)) break;
      }
    })();
    await Promise.all([
      session.send({ text: full, blocks: [{ type: 'text', text: typed }] }),
      reading,
    ]);
    const dispatch = gateway.calls.find((call) => call.method === 'command.dispatch');
    expect(dispatch?.params).toMatchObject({ name: 'code-review', arg: 'the diff' });
    const submit = gateway.calls.find((call) => call.method === 'prompt.submit');
    expect(submit?.params?.text).toBe(
      'SKILL BODY\n\nAttached files (read them from these paths):\n- a.txt',
    );
  });

  it('a command that answers with output is the whole turn: no prompt reaches the model', async () => {
    const gateway = conversation((method) =>
      method === 'command.dispatch' ? { type: 'exec', output: 'Goal: ship v1 (active)' } : {},
    );
    const session = await HermesTuiSession.open(gateway.channel, null);
    const events = await turn(session, '/goal status');
    expect(methods(gateway.calls)).not.toContain('prompt.submit');
    expect(events).toEqual([
      { type: 'message.delta', text: 'Goal: ship v1 (active)' },
      { type: 'run.completed', stopReason: 'completed' },
    ]);
  });

  it('Hermes refusing the command fails the turn with its own words', async () => {
    const gateway = conversation((method) =>
      method === 'command.dispatch'
        ? { error: { code: 4018, message: 'not a quick/plugin/bundle/skill command: nope' } }
        : {},
    );
    const session = await HermesTuiSession.open(gateway.channel, null);
    await expect(session.send({ text: '/skill nope do it' })).rejects.toThrow(
      '/skill nope: not a quick/plugin/bundle/skill command: nope',
    );
    expect(methods(gateway.calls)).not.toContain('prompt.submit');
  });

  it('any other /text goes to the model exactly as typed', async () => {
    const gateway = conversation();
    const session = await HermesTuiSession.open(gateway.channel, null);
    await turn(session, '/etc/hosts is broken, look');
    expect(methods(gateway.calls)).not.toContain('command.dispatch');
    const submit = gateway.calls.find((call) => call.method === 'prompt.submit');
    expect(submit?.params?.text).toBe('/etc/hosts is broken, look');
  });
});

describe('compression', () => {
  it('session.compress between turns, with Hermes answer in the contract terms', async () => {
    const gateway = conversation((method) =>
      method === 'session.compress'
        ? {
            status: 'compressed',
            removed: 55,
            before_messages: 64,
            after_messages: 9,
            before_tokens: 118_400,
            after_tokens: 21_900,
            summary: { headline: 'Compressed: 64 → 9 messages', token_line: '~118,400 → ~21,900' },
            usage: { context_used: 21_900, context_max: 200_000, context_estimated: true },
          }
        : {},
    );
    const session = await HermesTuiSession.open(gateway.channel, null);
    const outcome = await session.compress('the API');
    const call = gateway.calls.find((c) => c.method === 'session.compress');
    expect(call?.params).toEqual({ session_id: 'live1', focus_topic: 'the API' });
    expect(outcome).toEqual({
      status: 'compressed',
      beforeTokens: 118_400,
      afterTokens: 21_900,
      beforeMessages: 64,
      afterMessages: 9,
      context: { usedTokens: 21_900, windowTokens: 200_000, estimated: true },
      message: 'Compressed: 64 → 9 messages\n~118,400 → ~21,900',
    });
  });

  it('says busy as already_running, and reads "nothing to do" and "someone else is at it"', async () => {
    const gateway = conversation((method) =>
      method === 'session.compress'
        ? { error: { code: 4009, message: 'session busy — /interrupt the current turn' } }
        : {},
    );
    const session = await HermesTuiSession.open(gateway.channel, null);
    const refused = await session.compress(null).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HubError);
    expect((refused as HubError).code).toBe('already_running');

    expect(compressOutcomeOf({ status: 'compressed', removed: 0 }).status).toBe('unchanged');
    expect(compressOutcomeOf({ status: 'aborted', removed: 0 }).status).toBe('unchanged');
    expect(
      compressOutcomeOf({ compressed: false, lock_held: true, message: 'held by cron' }),
    ).toMatchObject({ status: 'skipped', message: 'held by cron', context: null });
  });

  it('reports Hermes compressing inside a turn, and the window it ends the turn with', async () => {
    const gateway = fakeGateway((method, _params, emit) => {
      if (method === 'session.create') return { session_id: 'live1', stored_session_id: 's1' };
      if (method === 'prompt.submit') {
        setImmediate(() => {
          emit('live1', 'status.update', { kind: 'compacting', text: 'compacting context…' });
          emit('live1', 'status.update', { kind: 'compacting', text: 'still compacting…' });
          emit('live1', 'status.update', { kind: 'ready', text: 'ready' });
          emit('live1', 'message.delta', { text: 'done' });
          emit('live1', 'message.complete', {
            status: 'complete',
            usage: { input: 900, output: 40, context_used: 30_000, context_max: 128_000 },
          });
        });
        return {};
      }
      return {};
    });
    const session = await HermesTuiSession.open(gateway.channel, null);
    const events = await turn(session, 'long work');
    expect(events.filter((e) => e.type === 'compression')).toEqual([
      { type: 'compression', phase: 'started' },
      { type: 'compression', phase: 'finished' },
    ]);
    expect(events).toContainEqual({
      type: 'context',
      usedTokens: 30_000,
      windowTokens: 128_000,
      estimated: false,
    });
  });
});

describe('steering', () => {
  it('session.steer while a turn is in flight; nothing to steer is "rejected"', async () => {
    let release: () => void = () => {};
    const gateway = fakeGateway((method, params, emit) => {
      if (method === 'session.create') return { session_id: 'live1', stored_session_id: 's1' };
      if (method === 'prompt.submit') {
        release = () => emit('live1', 'message.complete', { status: 'complete' });
        return {};
      }
      if (method === 'session.steer') return { status: 'queued', text: params.text };
      return {};
    });
    const session = await HermesTuiSession.open(gateway.channel, null);
    expect(await session.steer('too early')).toBe('rejected');
    expect(methods(gateway.calls)).not.toContain('session.steer');

    const reading = (async () => {
      for await (const event of session.stream()) if (terminal(event)) break;
    })();
    const sent = session.send({ text: 'work' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await session.steer('use staging')).toBe('queued');
    const call = gateway.calls.find((c) => c.method === 'session.steer');
    expect(call?.params).toEqual({ session_id: 'live1', text: 'use staging' });
    release();
    await Promise.all([sent, reading]);
  });
});
