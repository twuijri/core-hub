/**
 * One whole run, end to end, over the real HTTP routes and the real
 * `/rt/sessions` socket, with the agent played by the scripted fake runner.
 *
 * What it proves:
 *
 * 1. The event **sequence** is exactly what `sessions.createRun` declares in
 *    `x-rt-events` — a client can rely on the order, not just the set.
 * 2. Every emitted envelope **validates against its JSON Schema** in
 *    `packages/contracts/events/sessions/`, `additionalProperties: false`
 *    included. The contract is checked, not paraphrased.
 * 3. Approvals block the run and release it; interruption ends it as
 *    `cancelled`; usage is written to the audit ledger.
 * 4. A client that reconnects mid-run is handed the deltas it missed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractsRoot } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from './testing/fake-runner.js';

// The Socket.IO engine path, declared in ARCHITECTURE §Realtime (app/sockets.ts
// owns the constant; a module test must not import app/).
const SOCKET_PATH = '/rt';
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const PROFILE = 'default';

// ---------------------------------------------------------------- schemas

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
  namespace: string;
  profile: string;
  ts: string;
  seq: number;
  payload: Record<string, unknown>;
}

function expectValid(envelope: Envelope): void {
  const validate = validatorFor(envelope.event);
  const ok = validate(envelope);
  expect(
    ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
    `${envelope.event} does not match its schema`,
  ).toEqual([]);
}

// ------------------------------------------------------------------ setup

const SESSION_EVENTS = [
  'session.created',
  'session.updated',
  'session.deleted',
  'message.created',
  'message.delta',
  'reasoning.delta',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'run.queued',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'approval.requested',
  'approval.resolved',
  'context.updated',
] as const;

interface Harness {
  hub: TestHub;
  baseUrl: string;
  runner: FakeAgentRunner;
  socket: Socket;
  events: Envelope[];
  /** Events seen on the socket, in arrival order, validated as they arrive. */
  waitFor(event: string, count?: number): Promise<Envelope>;
  close(): Promise<void>;
}

let harness: Harness;

async function startHarness(script: ScriptStep[]): Promise<Harness> {
  const runner = new FakeAgentRunner({ script });
  const agents = new FakeAgentDirectory([fakeHermes(AGENT_ID)]);
  const sessions = createSessionsModule({ agents, runner, agentTimeoutMs: 2_000 });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));

  const hub = await testHub({}, { modules });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  const socket = connect(`${baseUrl}/rt/sessions`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { profile: PROFILE },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  const events: Envelope[] = [];
  const waiters: Array<{ event: string; count: number; resolve: (e: Envelope) => void }> = [];
  for (const name of SESSION_EVENTS) {
    socket.on(name, (envelope: Envelope) => {
      expectValid(envelope);
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
    baseUrl,
    runner,
    socket,
    events,
    waitFor(event, count = 1) {
      const seen = events.filter((e) => e.event === event);
      if (seen.length >= count) return Promise.resolve(seen[count - 1] as Envelope);
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${event} #${count}`)),
          5_000,
        );
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await hub.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-hub-profile': PROFILE },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: res.statusCode,
    json: res.body ? (res.json() as Record<string, unknown>) : {},
  };
}

/** Create a session and subscribe the harness socket to it. */
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

afterEach(async () => {
  await harness?.close();
});

// ------------------------------------------------------------------ tests

describe('a whole run, streamed', () => {
  beforeEach(() => {
    /* each test builds its own harness with its own script */
  });

  it('emits exactly the sequence `sessions.createRun` declares, and every envelope matches its schema', async () => {
    harness = await startHarness([
      { type: 'reasoning_delta', text: 'The user wants the tests run.' },
      { type: 'message_delta', text: 'سأشغّل ' },
      { type: 'message_delta', text: 'الاختبارات الآن.' },
      {
        type: 'tool_started',
        ref: 't1',
        name: 'shell',
        kind: 'shell',
        input: { command: 'pnpm test' },
      },
      { type: 'tool_completed', ref: 't1', output: '30 passed', exitCode: 0 },
      {
        type: 'usage',
        modelLabel: 'hermes-4',
        inputTokens: 2300,
        outputTokens: 410,
        costMicroUsd: 13_100,
        costSource: 'provider',
      },
      { type: 'context', usedTokens: 45_000, windowTokens: 256_000 },
      { type: 'completed' },
    ]);
    const { hub } = harness;
    const sessionId = await newSession(harness);

    const accepted = await api(hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'شغّل اختبارات الخادم' }],
    });
    expect(accepted.status).toBe(202);
    expect(accepted.json).toMatchObject({
      job_id: expect.any(String),
      run_id: expect.any(String),
      message_id: expect.any(String),
    });

    await harness.waitFor('run.completed');

    expect(harness.events.map((e) => e.event)).toEqual([
      'session.created', // profile-wide: the sidebar gains a row
      'message.created', // the user's message
      'run.queued',
      'message.created', // the assistant shell
      'run.started',
      'session.updated', // the session is now `running`
      'reasoning.delta',
      'message.delta',
      'message.delta',
      'tool.started',
      'tool.completed',
      'context.updated',
      'run.completed',
      'session.updated', // back to `idle`, with the new preview and usage
    ]);

    // seq is monotonic per (namespace, profile).
    const seqs = harness.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const completed = harness.events.find((e) => e.event === 'run.completed') as Envelope;
    const run = completed.payload.run as Record<string, unknown>;
    const message = completed.payload.message as Record<string, unknown>;
    expect(run).toMatchObject({
      status: 'succeeded',
      session_id: sessionId,
      job_id: accepted.json.job_id,
      interrupted: false,
      error: null,
      usage: {
        input_tokens: 2300,
        output_tokens: 410,
        cost: { amount: '0.013100', currency: 'USD' },
      },
    });
    expect(message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      content: [{ type: 'text', text: 'سأشغّل الاختبارات الآن.' }],
      tool_calls: [
        expect.objectContaining({ name: 'shell', status: 'succeeded', output: '30 passed' }),
      ],
    });

    // The transcript survives: deltas are not stored, the final message is.
    const history = await api(hub, 'GET', `/sessions/${sessionId}/messages`);
    expect(history.status).toBe(200);
    const items = history.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ role: 'assistant', status: 'complete' });
    expect((items[1] as { reasoning: { text: string } }).reasoning.text).toBe(
      'The user wants the tests run.',
    );
  });

  it('records the run cost in the audit ledger', async () => {
    harness = await startHarness([
      {
        type: 'usage',
        modelLabel: 'hermes-4',
        inputTokens: 100,
        outputTokens: 20,
        costMicroUsd: 4_200,
        costSource: 'provider',
      },
      { type: 'message_delta', text: 'done' },
      { type: 'completed' },
    ]);
    const sessionId = await newSession(harness);
    await api(harness.hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    const completed = await harness.waitFor('run.completed');
    const runId = (completed.payload.run as { id: string }).id;

    // The ledger is read back through the session document's `usage` roll-up.
    const session = await api(harness.hub, 'GET', `/sessions/${sessionId}`);
    expect(session.json.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cost: { amount: '0.004200', currency: 'USD' },
    });

    const run = await api(harness.hub, 'GET', `/sessions/${sessionId}/runs/${runId}`);
    expect(run.json).toMatchObject({
      status: 'succeeded',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });
});

describe('approvals inside a run', () => {
  it('blocks the run, exposes the approval workspace-wide, and releases it on approval', async () => {
    harness = await startHarness([
      {
        type: 'tool_started',
        ref: 't1',
        name: 'shell',
        kind: 'shell',
        input: { command: 'rm -rf build' },
      },
      {
        type: 'approval_requested',
        ref: 'a1',
        kind: 'tool_call',
        title: 'تنفيذ أمر',
        description: 'يريد الوكيل حذف مجلد البناء',
        command: 'rm -rf build',
        toolRef: 't1',
        allowAlways: true,
        choices: [
          { value: 'approve_once', label: 'مرة واحدة' },
          { value: 'deny', label: 'رفض' },
        ],
      },
      { type: 'await_input' },
      { type: 'tool_completed', ref: 't1', output: '', exitCode: 0 },
      { type: 'message_delta', text: 'حذفت المجلد.' },
      { type: 'completed' },
    ]);
    const { hub } = harness;
    const sessionId = await newSession(harness);
    await api(hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'نظّف المشروع' }],
    });

    const requested = await harness.waitFor('approval.requested');
    const approval = requested.payload.approval as Record<string, unknown>;
    expect(approval).toMatchObject({
      kind: 'tool_call',
      status: 'pending',
      session_id: sessionId,
      command: 'rm -rf build',
      allow_always: true,
    });

    // The pending-actions bar reads it across the workspace, and the session
    // document reports the run as `waiting`.
    const inbox = await api(hub, 'GET', '/approvals');
    expect((inbox.json.items as unknown[]).length).toBe(1);
    const detail = await api(hub, 'GET', `/sessions/${sessionId}`);
    expect(detail.json.status).toBe('waiting');
    expect((detail.json.pending_approvals as unknown[]).length).toBe(1);

    const responded = await api(hub, 'POST', `/approvals/${approval.id as string}/respond`, {
      decision: 'approve_session',
    });
    expect(responded.status).toBe(200);
    expect(responded.json).toMatchObject({
      status: 'approved',
      response: { decision: 'approve_session', responded_by: expect.any(String) },
    });

    await harness.waitFor('run.completed');
    expect(harness.runner.inputs).toEqual([
      {
        runId: expect.any(String),
        input: { approvalRef: 'a1', decision: 'approve_session', answer: null },
      },
    ]);
    expect(harness.events.map((e) => e.event)).toEqual([
      'session.created',
      'message.created',
      'run.queued',
      'message.created',
      'run.started',
      'session.updated', // idle -> running
      'tool.started',
      'approval.requested',
      'session.updated', // running -> waiting
      'approval.resolved',
      'session.updated', // waiting -> running
      'tool.completed',
      'message.delta',
      'run.completed',
      'session.updated', // -> idle
    ]);
  });

  it('refuses a second answer on the same approval with 409 state_invalid', async () => {
    harness = await startHarness([
      { type: 'approval_requested', ref: 'a1', kind: 'question', title: 'أي فرع؟' },
      { type: 'await_input' },
      { type: 'completed' },
    ]);
    const sessionId = await newSession(harness);
    await api(harness.hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'ابدأ' }],
    });
    const requested = await harness.waitFor('approval.requested');
    const id = (requested.payload.approval as { id: string }).id;
    await api(harness.hub, 'POST', `/approvals/${id}/respond`, { answer: 'main' });
    const again = await api(harness.hub, 'POST', `/approvals/${id}/respond`, { answer: 'test' });
    expect(again.status).toBe(409);
    expect(again.json).toEqual({
      error: expect.any(String),
      code: 'state_invalid',
      details: { from: 'answered', allowed: [] },
    });
  });
});

describe('interruption', () => {
  it('stops an active run and reports it as cancelled', async () => {
    harness = await startHarness([
      { type: 'message_delta', text: 'أبدأ بـ' },
      { type: 'await_input' },
      { type: 'message_delta', text: 'never sent' },
      { type: 'completed' },
    ]);
    const { hub } = harness;
    const sessionId = await newSession(harness);
    const accepted = await api(hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'اكتب مقالًا طويلًا' }],
    });
    const runId = accepted.json.run_id as string;
    await harness.waitFor('message.delta');

    const cancelled = await api(hub, 'POST', `/sessions/${sessionId}/runs/${runId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.interrupted).toBe(true);

    const terminal = await harness.waitFor('run.cancelled');
    expect(terminal.payload.run).toMatchObject({ status: 'cancelled', interrupted: true });
    expect(harness.runner.interrupted).toEqual([runId]);

    // The half-written answer is kept, marked interrupted.
    const history = await api(hub, 'GET', `/sessions/${sessionId}/messages`);
    const items = history.json.items as Array<Record<string, unknown>>;
    expect(items.at(-1)).toMatchObject({
      status: 'interrupted',
      content: [{ type: 'text', text: 'أبدأ بـ' }],
    });
  });

  it('refuses to cancel a run that already finished', async () => {
    harness = await startHarness([{ type: 'message_delta', text: 'ok' }, { type: 'completed' }]);
    const sessionId = await newSession(harness);
    const accepted = await api(harness.hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'hi' }],
    });
    await harness.waitFor('run.completed');
    const res = await api(
      harness.hub,
      'POST',
      `/sessions/${sessionId}/runs/${accepted.json.run_id as string}/cancel`,
    );
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('state_invalid');
  });
});

describe('resume after a dropped socket', () => {
  it('replays exactly the envelopes the client missed', async () => {
    harness = await startHarness([
      { type: 'message_delta', text: 'one ' },
      { type: 'await_input' },
      { type: 'message_delta', text: 'two ' },
      { type: 'message_delta', text: 'three' },
      { type: 'completed' },
    ]);
    const { hub, baseUrl } = harness;
    const sessionId = await newSession(harness);
    await api(hub, 'POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'عُدّ إلى ثلاثة' }],
    });
    const firstDelta = await harness.waitFor('message.delta');

    // The phone loses signal right after the first delta.
    harness.socket.disconnect();
    const approval = harness.runner.started[0];
    expect(approval).toBeDefined();
    // The agent keeps talking while nobody is listening.
    await harness.runner.send(approval?.runId as string, {
      approvalRef: 'none',
      decision: null,
      answer: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // It comes back and asks for everything after the last seq it saw.
    const reconnected = connect(`${baseUrl}/rt/sessions`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { profile: PROFILE },
    });
    const replayed: Envelope[] = [];
    for (const name of SESSION_EVENTS) {
      reconnected.on(name, (envelope: Envelope) => {
        expectValid(envelope);
        replayed.push(envelope);
      });
    }
    await new Promise<void>((resolve, reject) => {
      reconnected.once('connect', () => resolve());
      reconnected.once('connect_error', reject);
    });
    const ack = await new Promise<{ ok: boolean; replayed: number; truncated: boolean }>(
      (resolve) =>
        reconnected.emit(
          'subscribe',
          { session_id: sessionId, after_seq: firstDelta.seq },
          resolve,
        ),
    );

    expect(ack).toMatchObject({ ok: true, truncated: false });
    expect(ack.replayed).toBeGreaterThanOrEqual(3);
    expect(replayed.map((e) => e.event)).toEqual([
      'message.delta',
      'message.delta',
      'run.completed',
    ]);
    expect(replayed.map((e) => (e.payload as { delta?: string }).delta)).toEqual([
      'two ',
      'three',
      undefined,
    ]);
    expect(replayed.every((e) => e.seq > firstDelta.seq)).toBe(true);
    reconnected.disconnect();
  });

  it('tells a client to refetch when it cannot prove the replay is complete', async () => {
    harness = await startHarness([{ type: 'completed' }]);
    const sessionId = await newSession(harness);
    const ack = await new Promise<{ ok: boolean; replayed: number; truncated: boolean }>(
      (resolve) =>
        harness.socket.emit('subscribe', { session_id: sessionId, after_seq: 999 }, resolve),
    );
    expect(ack).toEqual({ ok: true, replayed: 0, truncated: true });
  });
});

describe('the agent registry decides what a session can do', () => {
  it('404s a session for an agent the registry does not know', async () => {
    harness = await startHarness([]);
    const res = await api(harness.hub, 'POST', '/sessions', {
      agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
    });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: 'not_found', details: { resource: 'agent' } });
  });
});
