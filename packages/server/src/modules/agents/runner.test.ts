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
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { scriptedHermes } from './adapters/hermes.test.js';
import type { HermesRunEvent } from './adapters/hermes.js';
import { AgentRunner, approvalChoices, failureCode, toRunnerEvent, toolKindOf } from './runner.js';
import type { AdapterSet } from './adapters/index.js';
import type { AgentEvent, AgentSession } from './adapters/types.js';
import type { AgentsService } from './service.js';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import type { ModelsOverrides } from '../models/index.js';

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

async function startHarness(
  frames: HermesRunEvent[] | (() => HermesRunEvent[]),
  models?: ModelsOverrides,
): Promise<Harness> {
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
      ...(models ? { models } : {}),
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
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${event} #${count}`)),
          5_000,
        );
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
  const items = (res.json() as { items: Array<{ id: string; slug: string; status: string }> })
    .items;
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
            { event: 'message.delta', delta: 'مرحبا ' },
            { event: 'tool.started', tool: 'terminal', preview: 'ls' },
            {
              event: 'tool.completed',
              tool: 'terminal',
              duration: 0.1,
              error: false,
              preview: 'a b',
            },
            { event: 'message.delta', delta: 'بك.' },
            // Hermes's "reasoning" is the reply's own text; it must not reach the transcript.
            { event: 'reasoning.available', text: 'مرحبا بك.' },
            {
              event: 'run.completed',
              session_id: 'corehub-continued',
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
    // The first reply is followed by the session naming itself (contract decision §26):
    // one more `session.updated`, from a question asked in a conversation of its own.
    await harness.waitFor('session.updated', 3);

    expect(harness.events.map((e) => e.event)).toEqual([
      'session.created',
      'message.created',
      'run.queued',
      'message.created',
      'run.started',
      'session.updated',
      'message.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
      'run.completed',
      'session.updated',
      'session.updated',
    ]);
    // The title question went to Hermes as a conversation of its own, never appended to
    // the one it is about.
    expect(harness.hermes.calls.ask).toHaveLength(1);
    expect(harness.hermes.calls.ask[0]).toMatchObject({
      session_id: `corehub-ask-${sessionId.toLowerCase()}`,
    });
    const completed = harness.events.find((e) => e.event === 'run.completed')!;
    expect(completed.payload.run).toMatchObject({
      status: 'succeeded',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(completed.payload.message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      content: [{ type: 'text', text: 'مرحبا بك.' }],
      tool_calls: [
        expect.objectContaining({ name: 'terminal', status: 'succeeded', output: 'a b' }),
      ],
    });
    // The first turn opened the conversation under the hub's own id; Hermes echoed its own.
    expect(harness.hermes.calls.createRun[0]).toMatchObject({
      session_id: `corehub-${sessionId.toLowerCase()}`,
    });
    // The person's text comes first; the file exchange is named after it, because
    // Hermes's run surface has no attachment channel (ADR 0008, `promptText`).
    const firstInput = harness.hermes.calls.createRun[0]!.input;
    expect(firstInput.startsWith('قل مرحبا')).toBe(true);
    expect(firstInput).toContain('/.corehub/runs/');
    expect(firstInput).toContain('/out');

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
    expect(harness.hermes.calls.createRun[1]!.input.startsWith('ومرة أخرى')).toBe(true);
    expect(harness.hermes.calls.createRun[1]).toMatchObject({
      session_id: 'corehub-continued',
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
    // …and then the session names itself (contract decision §26).
    await harness.waitFor('session.updated', 4);
    expect(harness.events.map((e) => e.event).slice(-7)).toEqual([
      'approval.resolved',
      'session.updated',
      'tool.completed',
      'message.delta',
      'run.completed',
      'session.updated',
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
      {
        event: 'run.failed',
        completed: false,
        error: 'No API key configured for provider openrouter',
      },
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

/**
 * The model the person picked is the model that runs (the defect of 2026-09-22).
 *
 * The composer's value is the catalogue's `Model.key` — `"<provider slug>/<model>"`, one
 * string because a `<Select>` needs one. That string used to travel untouched all the way
 * to `POST /v1/runs`, where no provider has ever heard of it; and the provider it belongs
 * to was never named at all, so Hermes served the run with whatever its own `config.yaml`
 * happened to say. Both are asserted here against the transport itself.
 */
describe('agent runner: the model that reaches the wire', () => {
  const lmstudio = 'http://127.0.0.1:1234/v1';
  /** LM Studio with two models and no key — a local provider Hermes ships no slug for. */
  function localModels(): typeof fetch {
    return ((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(url).startsWith(lmstudio)
              ? { data: [{ id: 'llama-3.1-8b' }, { id: 'qwen3-30b' }] }
              : {},
          ),
          {
            status: String(url).startsWith(lmstudio) ? 200 : 503,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )) as unknown as typeof fetch;
  }

  async function addLmStudio(h: Harness): Promise<string> {
    const created = await authed(h.hub, h.hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'lmstudio', label: 'LM Studio', kind: 'llm', base_url: lmstudio },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    await drainJobs(h.hub.app);
    return id;
  }

  it('splits the catalogue key and names the provider, turn after turn', async () => {
    harness = await startHarness(
      () => [{ event: 'run.completed', completed: true, output: 'ok', usage: {} }],
      { fetchImpl: localModels() },
    );
    await addLmStudio(harness);
    const agentId = await hermesAgentId(harness);

    // The composer sends the catalogue key, exactly as `useComposerModels` builds it.
    const created = await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { agent_id: agentId, model: 'lmstudio/qwen3-30b' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;
    await new Promise<void>((resolve, reject) =>
      harness!.socket.emit('subscribe', { session_id: sessionId }, (ack: { ok: boolean }) =>
        ack.ok ? resolve() : reject(new Error('subscribe refused')),
      ),
    );

    await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'one' }] },
    });
    await harness.waitFor('run.completed');
    // The model id the endpoint itself serves, and the name Hermes knows it by.
    expect(harness.hermes.calls.createRun[0]).toMatchObject({
      model: 'qwen3-30b',
      provider: 'corehub-lmstudio',
    });

    // The person changes the model mid-conversation. The Hermes session is deliberately
    // never evicted, so this used to keep running the first model for the life of the
    // process.
    await authed(harness.hub, harness.hub.token, {
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { model: 'lmstudio/llama-3.1-8b' },
    });
    await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'two' }] },
    });
    await harness.waitFor('run.completed', 2);
    expect(harness.hermes.calls.createRun[1]).toMatchObject({
      model: 'llama-3.1-8b',
      provider: 'corehub-lmstudio',
    });
    // Same conversation: only the selection moved.
    expect(harness.hermes.calls.createRun).toHaveLength(2);
  });

  it('answers a run with no provider configured with a code the client can branch on', async () => {
    harness = await startHarness([
      {
        event: 'run.failed',
        error:
          "\u26a0\ufe0f Provider authentication failed: No inference provider configured. Run 'hermes model' to choose a provider and model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in ~/.hermes/.env.",
      },
    ]);
    const agentId = await hermesAgentId(harness);
    const sessionId = await newSession(harness, agentId);
    await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'hi' }] },
    });
    const failed = await harness.waitFor('run.failed');
    const run = failed.payload.run as { error: { code: string; error: string } };
    expect(run.error.code).toBe('provider_not_configured');
    // Hermes's own words survive intact underneath our label — never replaced, never cut.
    expect(run.error.error).toContain('No inference provider configured');
    expect(run.error.error).toContain("Run 'hermes model'");
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
    const cancelled = {
      type: 'run.completed' as const,
      stopReason: 'cancelled',
      interrupted: true,
    };
    expect(toRunnerEvent(cancelled, { interruptRequested: false })).toEqual({
      type: 'failed',
      code: 'cancelled',
      message: 'the agent cancelled the turn',
    });
    expect(toRunnerEvent(cancelled, { interruptRequested: true })).toEqual({ type: 'completed' });
    expect(
      toRunnerEvent({ type: 'run.failed', error: 'boom' }, { interruptRequested: false }),
    ).toEqual({
      type: 'failed',
      code: 'agent_error',
      message: 'boom',
    });
  });

  it('recognises Hermes’s "nothing is configured" in either of the two shapes it prints', () => {
    // The code token, when a surface passes the AuthError through…
    expect(failureCode('auth failed (no_provider_configured)')).toBe('provider_not_configured');
    // …and the sentence, which is all `/v1/runs` gives us.
    expect(
      failureCode('⚠️ Provider authentication failed: No inference provider configured. Run …'),
    ).toBe('provider_not_configured');
    // Anything else keeps the generic code; the hub never guesses a cause.
    expect(failureCode('rate limit exceeded')).toBe('agent_error');
    expect(failureCode(null)).toBe('agent_error');
  });
});

describe('agent runner: a live session whose process went away between turns', () => {
  it('reopens it by the stored ref instead of handing the turn to a closed session', async () => {
    const opened: Array<{ ref: string | null; session: AgentSession & { closed: boolean } }> = [];
    const adapter = {
      async start(target: { sessionRef: string | null }) {
        const session = {
          id: `stored-${opened.length + 1}`,
          closed: false,
          async send() {
            if (session.closed) throw new Error('Hermes session is closed');
            return { stopReason: 'completed' };
          },
          async *stream(): AsyncIterable<AgentEvent> {
            yield { type: 'run.completed', stopReason: 'completed' };
          },
          async respond() {},
          async interrupt() {},
          async close() {},
        };
        opened.push({ ref: target.sessionRef, session });
        return session;
      },
    };
    const service = {
      loadAgent: () => ({ id: 'agent-1', installState: 'installed', adapterKind: 'hermes' }),
      selectionFor: () => ({ model: null, provider: null, providerId: null }),
      targetFor: (_row: unknown, _workspace: unknown, input: { sessionRef: string | null }) => ({
        sessionRef: input.sessionRef,
      }),
    };
    const runner = new AgentRunner({
      service: service as unknown as AgentsService,
      adapters: { byKind: () => adapter } as unknown as AdapterSet,
      log: capturingLogger().logger,
    });
    const request = (runId: string, agentSessionRef: string | null) => ({
      runId,
      sessionId: 'S1',
      workspace: 'w',
      agentId: 'agent-1',
      agentSessionRef,
      workingDir: null,
      model: null,
      provider: null,
      reasoningEffort: null,
      prompt: [{ type: 'text' as const, text: 'hi' }],
      files: null,
      allowedTools: [],
    });
    const drain = async (runId: string) => {
      const out = [];
      for await (const event of runner.stream(runId)) out.push(event);
      return out;
    };

    const first = await runner.start(request('r1', null));
    expect(first.agentSessionRef).toBe('stored-1');
    expect((await drain('r1')).at(-1)).toMatchObject({ type: 'completed' });

    // The gateway under it was closed while nobody was talking (a key change).
    opened[0]!.session.closed = true;

    await runner.start(request('r2', 'stored-1'));
    expect((await drain('r2')).at(-1)).toMatchObject({ type: 'completed' });
    expect(opened).toHaveLength(2);
    expect(opened[1]!.ref).toBe('stored-1');
  });
});
