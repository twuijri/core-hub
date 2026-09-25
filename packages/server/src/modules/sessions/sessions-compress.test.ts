/**
 * The composer's agent commands at the sessions boundary (decision §52), over the real HTTP
 * routes and the real `/rt/sessions` socket, with the agent played by the scripted runner:
 *
 * - `sessions.compress` brackets the work with `context.compression` and then says the new
 *   window with `context.updated` — every envelope valid against its schema — and keeps that
 *   window on the session, so `Session.context` answers after a reload;
 * - it is refused while a run is alive, and by an agent that cannot compress;
 * - an agent compressing on its own inside a run says so as `trigger: auto`;
 * - `sessions.steerRun` hands a live run guidance and writes nothing to the transcript.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { contractsRoot } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type FakeRunnerOptions,
} from './testing/fake-runner.js';

const SOCKET_PATH = '/rt';
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const PROFILE = 'default';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validatorFor(event: string) {
  const cached = validators.get(event);
  if (cached) return cached;
  const file = path.join(contractsRoot(), 'events', 'sessions', `${event}.schema.json`);
  const compiled = ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object);
  validators.set(event, compiled);
  return compiled;
}

interface Envelope {
  event: string;
  payload: Record<string, unknown>;
}

const EVENTS = [
  'message.created',
  'run.started',
  'run.completed',
  'run.failed',
  'context.updated',
  'context.compression',
] as const;

interface Harness {
  hub: TestHub & { token: string };
  runner: FakeAgentRunner;
  socket: Socket;
  events: Envelope[];
  waitFor(event: string, count?: number): Promise<Envelope>;
  close(): Promise<void>;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: FakeRunnerOptions): Promise<Harness> {
  const runner = new FakeAgentRunner(options);
  const agents = new FakeAgentDirectory([fakeHermes(AGENT_ID)]);
  const sessions = createSessionsModule({ agents, runner, agentTimeoutMs: 2_000 });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  const hub = await signedInHub({}, { modules });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  const socket = connect(`${baseUrl}/rt/sessions`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { profile: PROFILE, token: hub.token },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const events: Envelope[] = [];
  const waiters: Array<{ event: string; count: number; resolve: (e: Envelope) => void }> = [];
  for (const name of EVENTS) {
    socket.on(name, (envelope: Envelope) => {
      const validate = validatorFor(name);
      expect(
        validate(envelope)
          ? []
          : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
        `${name} does not match its schema`,
      ).toEqual([]);
      events.push(envelope);
      const seen = events.filter((e) => e.event === name).length;
      for (const waiter of [...waiters]) {
        if (waiter.event === name && waiter.count <= seen) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(envelope);
        }
      }
    });
  }
  return {
    hub,
    runner,
    socket,
    events,
    waitFor(event, count = 1) {
      const seen = events.filter((e) => e.event === event);
      if (seen.length >= count) return Promise.resolve(seen[count - 1] as Envelope);
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5_000);
        waiters.push({
          event,
          count,
          resolve: (envelope) => {
            clearTimeout(timer);
            resolve(envelope);
          },
        });
      });
    },
    async close() {
      socket.disconnect();
      await hub.close();
    },
  };
}

async function api(
  hub: TestHub,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await hub.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-hub-profile': PROFILE },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? (res.json() as Record<string, unknown>) : {} };
}

async function newSession(h: Harness): Promise<string> {
  const created = await api(h.hub, 'POST', '/sessions', { agent_id: AGENT_ID });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  await new Promise<void>((resolve, reject) =>
    h.socket.emit('subscribe', { session_id: id }, (ack: { ok: boolean }) =>
      ack.ok ? resolve() : reject(new Error('subscribe refused')),
    ),
  );
  return id;
}

const COMPRESSED = {
  agentSessionRef: 'hermes-conversation-1',
  status: 'compressed' as const,
  beforeTokens: 118_400,
  afterTokens: 21_900,
  beforeMessages: 64,
  afterMessages: 9,
  context: { usedTokens: 21_900, windowTokens: 200_000, estimated: true },
  message: 'Compressed: 64 → 9 messages',
};

describe('sessions.compress', () => {
  it('brackets the work with context.compression, then reports and keeps the new window', async () => {
    harness = await start({ compress: COMPRESSED });
    const id = await newSession(harness);

    const res = await api(harness.hub, 'POST', `/sessions/${id}/compress`, { focus: 'the API' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      status: 'compressed',
      before_tokens: 118_400,
      after_tokens: 21_900,
      before_messages: 64,
      after_messages: 9,
      context: { used_tokens: 21_900, window_tokens: 200_000, estimated: true },
      message: 'Compressed: 64 → 9 messages',
    });
    expect(harness.runner.compressed).toEqual([
      expect.objectContaining({ sessionId: id, agentId: AGENT_ID, focus: 'the API' }),
    ]);

    const started = await harness.waitFor('context.compression', 1);
    const finished = await harness.waitFor('context.compression', 2);
    const updated = await harness.waitFor('context.updated');
    expect(started.payload).toMatchObject({ phase: 'started', trigger: 'manual', run_id: null });
    expect(finished.payload).toMatchObject({
      phase: 'finished',
      trigger: 'manual',
      before_tokens: 118_400,
      after_tokens: 21_900,
    });
    expect(updated.payload.context).toEqual({
      used_tokens: 21_900,
      window_tokens: 200_000,
      estimated: true,
    });
    const order = harness.events.map((e) => `${e.event}:${String(e.payload.phase ?? '')}`);
    expect(order).toEqual([
      'context.compression:started',
      'context.compression:finished',
      'context.updated:',
    ]);

    // Kept on the session: a reload reads it, and the agent's conversation id is remembered.
    const session = await api(harness.hub, 'GET', `/sessions/${id}`);
    expect(session.json.context).toEqual({
      used_tokens: 21_900,
      window_tokens: 200_000,
      estimated: true,
    });
  });

  it('is refused while a run is alive, and by an agent that cannot compress', async () => {
    harness = await start({
      compress: COMPRESSED,
      script: [{ type: 'message_delta', text: 'working' }, { type: 'await_input' }],
    });
    const id = await newSession(harness);
    const run = await api(harness.hub, 'POST', `/sessions/${id}/runs`, {
      content: [{ type: 'text', text: 'go' }],
    });
    expect(run.status).toBe(202);
    await harness.waitFor('run.started');
    const busy = await api(harness.hub, 'POST', `/sessions/${id}/compress`, {});
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe('already_running');
    expect(harness.runner.compressed).toHaveLength(0);
    await harness.close();

    harness = await start({});
    const other = await newSession(harness);
    const unsupported = await api(harness.hub, 'POST', `/sessions/${other}/compress`, {});
    expect(unsupported.status).toBe(409);
    expect(unsupported.json).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'command_unsupported', command: 'compress' },
    });
  });

  it('says it failed when the agent refuses, and the session keeps no window it did not get', async () => {
    harness = await start({
      compress: () => {
        throw new Error('summary model unreachable');
      },
    });
    const id = await newSession(harness);
    const res = await api(harness.hub, 'POST', `/sessions/${id}/compress`);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('agent_error');
    const failed = await harness.waitFor('context.compression', 2);
    expect(failed.payload).toMatchObject({ phase: 'failed', message: 'summary model unreachable' });
    const session = await api(harness.hub, 'GET', `/sessions/${id}`);
    expect(session.json.context).toBeNull();
  });
});

describe('compression inside a run', () => {
  it('reports an automatic compression as trigger auto, then the window the agent reported', async () => {
    harness = await start({
      script: [
        { type: 'compression', phase: 'started' },
        { type: 'compression', phase: 'started' },
        { type: 'compression', phase: 'finished' },
        { type: 'message_delta', text: 'done' },
        { type: 'context', usedTokens: 30_000, windowTokens: 128_000 },
        { type: 'completed' },
      ],
    });
    const id = await newSession(harness);
    const run = await api(harness.hub, 'POST', `/sessions/${id}/runs`, {
      content: [{ type: 'text', text: 'long work' }],
    });
    expect(run.status).toBe(202);
    await harness.waitFor('run.completed');
    const phases = harness.events
      .filter((e) => e.event === 'context.compression')
      .map((e) => [e.payload.phase, e.payload.trigger, e.payload.run_id]);
    // A repeated `started` is the agent restating it: announced once.
    expect(phases).toEqual([
      ['started', 'auto', run.json.run_id],
      ['finished', 'auto', run.json.run_id],
    ]);
    const session = await api(harness.hub, 'GET', `/sessions/${id}`);
    expect(session.json.context).toEqual({ used_tokens: 30_000, window_tokens: 128_000 });
  });
});

describe('sessions.steerRun', () => {
  it('hands a live run the guidance and writes nothing to the transcript', async () => {
    harness = await start({
      steer: 'queued',
      script: [{ type: 'message_delta', text: 'working' }, { type: 'await_input' }],
    });
    const id = await newSession(harness);
    const run = await api(harness.hub, 'POST', `/sessions/${id}/runs`, {
      content: [{ type: 'text', text: 'go' }],
    });
    const runId = run.json.run_id as string;
    await harness.waitFor('run.started');
    const before = harness.events.filter((e) => e.event === 'message.created').length;

    const steered = await api(harness.hub, 'POST', `/sessions/${id}/runs/${runId}/steer`, {
      text: 'use the staging database',
    });
    expect(steered.status).toBe(200);
    expect(steered.json).toEqual({ status: 'queued' });
    expect(harness.runner.steered).toEqual([{ runId, text: 'use the staging database' }]);
    expect(harness.events.filter((e) => e.event === 'message.created')).toHaveLength(before);

    const empty = await api(harness.hub, 'POST', `/sessions/${id}/runs/${runId}/steer`, {
      text: '   ',
    });
    expect(empty.status).toBe(400);
  });

  it('is refused for a run that is not in flight, and by an agent that cannot be steered', async () => {
    harness = await start({
      script: [{ type: 'message_delta', text: 'hi' }, { type: 'completed' }],
    });
    const id = await newSession(harness);
    const run = await api(harness.hub, 'POST', `/sessions/${id}/runs`, {
      content: [{ type: 'text', text: 'go' }],
    });
    await harness.waitFor('run.completed');
    const over = await api(
      harness.hub,
      'POST',
      `/sessions/${id}/runs/${String(run.json.run_id)}/steer`,
      { text: 'too late' },
    );
    expect(over.status).toBe(409);
    expect(over.json.code).toBe('state_invalid');
    await harness.close();

    harness = await start({
      script: [{ type: 'message_delta', text: 'working' }, { type: 'await_input' }],
    });
    const other = await newSession(harness);
    const live = await api(harness.hub, 'POST', `/sessions/${other}/runs`, {
      content: [{ type: 'text', text: 'go' }],
    });
    await harness.waitFor('run.started');
    const unsupported = await api(
      harness.hub,
      'POST',
      `/sessions/${other}/runs/${String(live.json.run_id)}/steer`,
      { text: 'turn left' },
    );
    expect(unsupported.status).toBe(409);
    expect(unsupported.json).toMatchObject({ details: { reason: 'command_unsupported' } });
  });
});
