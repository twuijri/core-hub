/**
 * The real `AgentRunner` end to end: the app as `src/modules/index.ts` composes it
 * (`auth` scope resolver, `agents` directory and runner, `sessions` engine), a signed-in
 * owner, and Hermes played by a scripted transport behind the real adapter. What it
 * proves:
 *
 * 1. The event sequence on `/rt/sessions` is exactly what `sessions.createRun` declares,
 *    now produced from Hermes frames instead of a scripted runner.
 * 2. Approvals travel both ways: a Hermes `approval.request` becomes the contract's
 *    `approval.requested`, and `POST /approvals/{id}/respond` reaches Hermes as `choice`.
 * 3. A second turn continues the same Hermes conversation (`session_id`).
 * 4. Scoping is `auth`'s: without a bearer the sessions routes answer 401; the rows carry
 *    the real workspace and user ids.
 *
 * The pure translation is asserted separately (`toRunnerEvent`).
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { scriptedHermes } from './adapters/hermes.test.js';
import type { HermesRunEvent } from './adapters/hermes.js';
import { approvalChoices, toRunnerEvent, toolKindOf } from './runner.js';

const SOCKET_PATH = '/rt';
const PROFILE = 'default';
const SESSION_EVENTS = [
  'session.created',
  'session.updated',
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

interface Envelope {
  event: string;
  seq: number;
  payload: Record<string, unknown>;
}

interface Harness {
  hub: TestHub & { token: string; userId: string };
  socket: Socket;
  events: Envelope[];
  hermes: ReturnType<typeof scriptedHermes>;
  waitFor(event: string, count?: number): Promise<Envelope>;
  close(): Promise<void>;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const healthyFetch: typeof fetch = async () => new Response('{"status":"ok"}', { status: 200 });

async function startHarness(frames: HermesRunEvent[] | (() => HermesRunEvent[])): Promise<Harness> {
  const hermes = scriptedHermes(frames);
  // A gateway that answers /health makes the Hermes row `installed` on boot; the scripted
  // transport replaces HTTP for the turn itself; the runtime supervisor sees "external".
  const hub = await signedInHub(
    {},
    {
      agents: {
        adapterOptions: { hermes: { fetchImpl: healthyFetch, transport: () => hermes.transport } },
        runtime: { healthIntervalMs: 0 },
      },
    },
  );
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
  for (const name of SESSION_EVENTS) {
    socket.on(name, (envelope: Envelope) => {
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
    socket,
    events,
    hermes,
    waitFor(event, count = 1) {
      const seen = events.filter((e) => e.event === event);
      if (seen.length >= count) return Promise.resolve(seen[count - 1] as Envelope);
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event} #${count}`)), 5_000);
        waiters.push({ event, count, resolve: (e) => (clearTimeout(timer), resolve(e)) });
      });
    },
    async close() {
      socket.disconnect();
      await hub.close();
    },
  };
}

async function hermesAgentId(h: Harness): Promise<string> {
  const res = await authed(h.hub, h.hub.token, { method: 'GET', url: '/api/v1/agents' });
  expect(res.statusCode).toBe(200);
  const items = (res.json() as { items: Array<{ id: string; slug: string; status: string }> }).items;
  const hermes = items.find((a) => a.slug === 'hermes');
  expect(hermes, 'the registry lists Hermes').toBeDefined();
  expect(hermes!.status).toBe('available');
  return hermes!.id;
}

async function newSession(h: Harness, agentId: string): Promise<string> {
  const created = await authed(h.hub, h.hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: agentId },
  });
  expect(created.statusCode).toBe(201);
  const id = (created.json() as { id: string }).id;
  await new Promise<void>((resolve, reject) =>
    h.socket.emit('subscribe', { session_id: id }, (ack: { ok: boolean }) =>
      ack.ok ? resolve() : reject(new Error('subscribe refused')),
    ),
  );
  return id;
}

describe('agent runner: a Hermes turn through the composed app', () => {
  it('streams the declared event sequence from Hermes frames and continues the conversation', async () => {
    let turn = 0;
    harness = await startHarness(() =>
      ++turn === 1
        ? [
            { event: 'run.started' },
            { event: 'reasoning.available', text: 'thinking' },
            { event: 'message.delta', delta: 'مرحبا ' },
            { event: 'tool.started', tool: 'terminal', preview: 'ls' },
            { event: 'tool.completed', tool: 'terminal', duration: 0.1, error: false, preview: 'a b' },
            { event: 'message.delta', delta: 'بك.' },
            {
              event: 'run.completed',
              session_id: 'majlis-continued',
              completed: true,
              output: 'مرحبا بك.',
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
              runtime: { provider: 'nous', model: 'hermes-4' },
            },
          ]
        : [{ event: 'run.completed', completed: true, output: 'ثانيًا', usage: {} }],
    );
    const agentId = await hermesAgentId(harness);
    const sessionId = await newSession(harness, agentId);

    const accepted = await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'قل مرحبا' }] },
    });
    expect(accepted.statusCode).toBe(202);
    await harness.waitFor('run.completed');

    expect(harness.events.map((e) => e.event)).toEqual([
      'session.created',
      'message.created',
      'run.queued',
      'message.created',
      'run.started',
      'session.updated',
      'reasoning.delta',
      'message.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
      'run.completed',
      'session.updated',
    ]);
    const completed = harness.events.find((e) => e.event === 'run.completed')!;
    expect(completed.payload.run).toMatchObject({
      status: 'succeeded',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(completed.payload.message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      content: [{ type: 'text', text: 'مرحبا بك.' }],
      tool_calls: [expect.objectContaining({ name: 'terminal', status: 'succeeded', output: 'a b' })],
    });
    // The first turn opened the conversation under the hub's own id; Hermes echoed its own.
    expect(harness.hermes.calls.createRun[0]).toMatchObject({
      input: 'قل مرحبا',
      session_id: `majlis-${sessionId.toLowerCase()}`,
    });

    // The rows are scoped by the real workspace and owned by the signed-in user.
    const detail = await authed(harness.hub, harness.hub.token, {
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
    });
    expect(detail.json()).toMatchObject({ profile: 'default', owner_id: harness.hub.userId });

    // Second turn: same Hermes conversation.
    await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'ومرة أخرى' }] },
    });
    await harness.waitFor('run.completed', 2);
    expect(harness.hermes.calls.createRun[1]).toMatchObject({
      input: 'ومرة أخرى',
      session_id: 'majlis-continued',
    });
  });

  it('blocks on a Hermes approval, exposes it, and hands the decision back as `choice`', async () => {
    harness = await startHarness([
      { event: 'tool.started', tool: 'terminal', preview: 'rm -rf build' },
      {
        event: 'approval.request',
        command: 'rm -rf build',
        description: 'Delete the build directory',
        allow_permanent: true,
        allow_session: true,
        choices: ['once', 'session', 'always', 'deny'],
      },
      { event: '__wait__' },
      { event: 'tool.completed', tool: 'terminal', duration: 0.1, error: false, preview: '' },
      { event: 'message.delta', delta: 'حذفت المجلد.' },
      { event: 'run.completed', completed: true, output: 'حذفت المجلد.' },
    ]);
    const agentId = await hermesAgentId(harness);
    const sessionId = await newSession(harness, agentId);
    await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'نظّف' }] },
    });
    const requested = await harness.waitFor('approval.requested');
    const approval = requested.payload.approval as Record<string, unknown>;
    expect(approval).toMatchObject({
      kind: 'tool_call',
      status: 'pending',
      command: 'rm -rf build',
      allow_always: true,
      choices: [
        { value: 'approve_once', label: 'Allow once' },
        { value: 'approve_session', label: 'Allow for this session' },
        { value: 'approve_always', label: 'Always allow' },
        { value: 'deny', label: 'Deny' },
      ],
    });
    const responded = await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/approvals/${approval.id as string}/respond`,
      payload: { decision: 'approve_session' },
    });
    expect(responded.statusCode).toBe(200);
    expect(harness.hermes.calls.approve).toEqual(['run_1:session']);
    await harness.waitFor('run.completed');
    expect(harness.events.map((e) => e.event).slice(-6)).toEqual([
      'approval.resolved',
      'session.updated',
      'tool.completed',
      'message.delta',
      'run.completed',
      'session.updated',
    ]);
  });

  it('cancels a run through Hermes `stop` and ends it as `cancelled`', async () => {
    harness = await startHarness([
      { event: 'message.delta', delta: 'جزء' },
      { event: '__wait__' },
      { event: 'run.cancelled', completed: false, interrupted: true },
    ]);
    const agentId = await hermesAgentId(harness);
    const sessionId = await newSession(harness, agentId);
    const accepted = await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'اعمل شيئًا طويلًا' }] },
    });
    const runId = (accepted.json() as { run_id: string }).run_id;
    await harness.waitFor('message.delta');
    const cancel = await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs/${runId}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(harness.hermes.calls.stop).toEqual(['run_1']);
    const cancelled = await harness.waitFor('run.cancelled');
    expect(cancelled.payload.run).toMatchObject({ status: 'cancelled', interrupted: true });
  });

  it('reports a Hermes failure as a failed run with the agent’s reason', async () => {
    harness = await startHarness([
      { event: 'run.failed', completed: false, error: 'No API key configured for provider openrouter' },
    ]);
    const agentId = await hermesAgentId(harness);
    const sessionId = await newSession(harness, agentId);
    await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'hi' }] },
    });
    const failed = await harness.waitFor('run.failed');
    expect(failed.payload.run).toMatchObject({
      status: 'failed',
      error: { code: 'agent_error', error: 'No API key configured for provider openrouter' },
    });
  });

  it('is scoped by auth: no bearer, no session', async () => {
    harness = await startHarness([]);
    const anonymous = await harness.hub.app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { 'x-hub-profile': PROFILE },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'unauthorized' });
    const unknownProfile = await authed(harness.hub, harness.hub.token, {
      method: 'GET',
      url: '/api/v1/sessions',
      profile: 'no-such-workspace',
    });
    expect(unknownProfile.statusCode).toBe(404);
    expect(unknownProfile.json()).toMatchObject({ code: 'profile_not_found' });
  });
});

describe('agent runner: the translation table', () => {
  it('folds an agent’s tool words into the contract’s kinds', () => {
    expect(toolKindOf('terminal')).toBe('shell');
    expect(toolKindOf('execute', 'bash')).toBe('shell');
    expect(toolKindOf('read', 'read_file')).toBe('file_read');
    expect(toolKindOf('edit', 'write_file')).toBe('file_write');
    expect(toolKindOf('search_files')).toBe('file_read');
    expect(toolKindOf('web_search')).toBe('web');
    expect(toolKindOf('fetch')).toBe('web');
    expect(toolKindOf('mcp_github_list_prs')).toBe('mcp');
    expect(toolKindOf('delegate_task')).toBe('custom');
  });

  it('maps ACP permission options and Hermes choices onto the four decisions', () => {
    const acp = approvalChoices([
      { id: 'allow', label: 'Allow', kind: 'allow_once' },
      { id: 'allow-always', label: 'Always allow', kind: 'allow_always' },
      { id: 'reject', label: 'Reject', kind: 'reject_once' },
    ]);
    expect([...acp.decisions]).toEqual([
      ['approve_once', 'allow'],
      ['approve_always', 'allow-always'],
      ['deny', 'reject'],
    ]);
    const hermes = approvalChoices([
      { id: 'once', label: 'Allow once', kind: 'once' },
      { id: 'session', label: 'Allow for this session', kind: 'session' },
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ]);
    expect(hermes.choices.map((c) => c.value)).toEqual(['approve_once', 'approve_session', 'deny']);
  });

  it('turns a self-cancelled turn into a failure and a requested one into completion', () => {
    const cancelled = { type: 'run.completed' as const, stopReason: 'cancelled', interrupted: true };
    expect(toRunnerEvent(cancelled, { interruptRequested: false })).toEqual({
      type: 'failed',
      code: 'cancelled',
      message: 'the agent cancelled the turn',
    });
    expect(toRunnerEvent(cancelled, { interruptRequested: true })).toEqual({ type: 'completed' });
    expect(toRunnerEvent({ type: 'run.failed', error: 'boom' }, { interruptRequested: false })).toEqual({
      type: 'failed',
      code: 'agent_error',
      message: 'boom',
    });
  });
});
