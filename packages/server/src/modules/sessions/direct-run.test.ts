/**
 * A whole run on the **direct** agent, over the real routes, the real `/rt/sessions`
 * socket, the real `agents` registry and the real `models` credential store — with only
 * the provider's HTTP endpoint scripted (ADOPTION-BACKLOG §2.15).
 *
 * What it proves:
 *
 * 1. A fresh install can hold this conversation: the person adds one provider, sets a
 *    default model, and the second agent in the list answers — no runtime in between.
 * 2. The run emits **exactly** the sequence `sessions.createRun` declares, the same
 *    order a Hermes run emits (`sessions-run.test.ts`), because it is the same run state
 *    machine. Nothing about the direct path forks it.
 * 3. The usage row and the cost are written like any other run's, so the Reports screen
 *    can see what this agent spent.
 * 4. The request that actually left the process is the person's message, addressed to
 *    the model they chose, with their key.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

const PROFILE = 'default';
const BASE_URL = 'https://lab.example/v1';

interface Envelope {
  event: string;
  seq: number;
  payload: Record<string, unknown>;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/**
 * The provider: a model list, and a chat surface that streams two words and its usage.
 * Nothing else answers, so a request to an endpoint this test did not mean to make is a
 * visible 503 rather than a silent pass.
 */
function scriptedProvider(): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: String(url), headers, body });

    if (String(url) === `${BASE_URL}/models`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'lab-small',
                name: 'Lab Small',
                context_length: 32_000,
                // Micro-USD per million: 1 000 000 in / 2 000 000 out at these prices.
                pricing: { prompt: '0.000001', completion: '0.000002' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    if (String(url) === `${BASE_URL}/chat/completions`) {
      const frames = [
        { choices: [{ delta: { content: 'مرحبًا ' } }] },
        { choices: [{ delta: { content: 'بك' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'not part of this test' }), { status: 503 }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface Harness {
  hub: TestHub & { token: string };
  socket: Socket;
  events: Envelope[];
  calls: Call[];
  agentId: string;
  waitFor(event: string): Promise<Envelope>;
  close(): Promise<void>;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A hub with one provider, one model, that model as the default, and a live socket. */
async function configuredHub(): Promise<Harness> {
  const { fetchImpl, calls } = scriptedProvider();
  const hub = await signedInHub({}, { models: { fetchImpl } });

  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: {
      preset: 'openai-compatible',
      label: 'Lab',
      kind: 'llm',
      base_url: BASE_URL,
      api_key: 'sk-lab-key',
    },
  });
  if (created.statusCode !== 201) throw new Error(`adding the provider: ${created.body}`);
  const providerId = (created.json() as { id: string }).id;
  // Saving the key starts the catalogue refresh; the model row must exist before it can
  // be a default.
  await drainJobs(hub.app);

  const defaults = await authed(hub, hub.token, {
    method: 'PUT',
    url: '/api/v1/models/defaults',
    payload: { default: { provider_id: providerId, model: 'lab-small' } },
  });
  if (defaults.statusCode !== 200) throw new Error(`setting the default: ${defaults.body}`);

  const agents = (
    (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
      items: {
        id: string;
        slug: string;
        status: string;
        default_model: { model: string } | null;
      }[];
    }
  ).items;
  const direct = agents.find((agent) => agent.slug === 'direct');
  if (!direct) throw new Error('the registry has no direct agent');
  expect(direct.status).toBe('available');
  // Nothing was configured *for this agent*: it inherited the workspace's model.
  expect(direct.default_model).toMatchObject({ model: 'lab-small', provider_id: providerId });

  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const socket = connect(`http://127.0.0.1:${port}/rt/sessions`, {
    path: '/rt',
    transports: ['websocket'],
    auth: { profile: PROFILE, token: hub.token },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  const events: Envelope[] = [];
  const waiters: Array<{ event: string; resolve: (envelope: Envelope) => void }> = [];
  for (const name of [
    'session.created',
    'session.updated',
    'message.created',
    'message.delta',
    'reasoning.delta',
    'run.queued',
    'run.started',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'context.updated',
  ]) {
    socket.on(name, (envelope: Envelope) => {
      events.push(envelope);
      for (const waiter of [...waiters]) {
        if (waiter.event !== name) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(envelope);
      }
    });
  }

  return {
    hub,
    socket,
    events,
    calls,
    agentId: direct.id,
    waitFor(event) {
      const seen = events.find((envelope) => envelope.event === event);
      if (seen) return Promise.resolve(seen);
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 8_000);
        waiters.push({
          event,
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

async function newSession(h: Harness): Promise<string> {
  const created = await authed(h.hub, h.hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: h.agentId },
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

describe('a run on the direct agent', () => {
  it('emits the sequence the contract declares, and records the cost', async () => {
    harness = await configuredHub();
    const sessionId = await newSession(harness);

    const accepted = await authed(harness.hub, harness.hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'قل مرحبًا' }] },
    });
    expect(accepted.statusCode).toBe(202);
    const completed = await harness.waitFor('run.completed');

    // Exactly the order `sessions-run.test.ts` asserts for a Hermes run: this path uses
    // the same run state machine, and nothing about it is forked.
    expect(harness.events.map((envelope) => envelope.event)).toEqual([
      'session.created',
      'message.created', // the person's message
      'run.queued',
      'message.created', // the assistant shell, so a delta has somewhere to land
      'run.started',
      'session.updated', // the session is `running`
      'message.delta',
      'message.delta',
      'run.completed',
      'session.updated', // back to `idle`, with the preview and the usage
    ]);

    const run = completed.payload.run as Record<string, unknown>;
    const message = completed.payload.message as Record<string, unknown>;
    expect(run).toMatchObject({
      status: 'succeeded',
      session_id: sessionId,
      interrupted: false,
      error: null,
      // Cost is visible for this agent like any other: the provider's token counts
      // against the model row's own published prices.
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        cost: { amount: '0.000018', currency: 'USD' },
      },
    });
    expect(message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      content: [{ type: 'text', text: 'مرحبًا بك' }],
    });

    // And the request that actually left: one hop, to the model the person chose, with
    // the key they stored once in the Models screen (ADR 0010).
    const turn = harness.calls.find((call) => call.url === `${BASE_URL}/chat/completions`);
    expect(turn).toBeDefined();
    expect(turn?.headers.authorization).toBe('Bearer sk-lab-key');
    expect(turn?.body).toMatchObject({
      model: 'lab-small',
      stream: true,
      messages: [{ role: 'user', content: 'قل مرحبًا' }],
    });

    // The ledger the Reports screen reads.
    const usage = await authed(harness.hub, harness.hub.token, {
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
    });
    expect((usage.json() as { usage: { input_tokens: number } }).usage.input_tokens).toBe(12);
  }, 20_000);

  it('fails the run with the provider’s own words when the key is refused', async () => {
    harness = await configuredHub();
    // The endpoint changes its mind about the key between the catalogue refresh and the
    // turn — a rotated key, exactly the case the owner hit on 2026-09-22.
    const hub = harness.hub;
    const sessionId = await newSession(harness);
    const models = await import('../models/index.js');
    const service = models.modelsServiceFor(hub.app);
    (service as unknown as { fetchImpl: typeof fetch }).fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;

    await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'hello' }] },
    });
    const failed = await harness.waitFor('run.failed');
    const run = failed.payload.run as { error: { code: string; error: string } };
    expect(run.error.code).toBe('provider_unauthorized');
    expect(run.error.error).toContain('Incorrect API key provided');
  }, 20_000);
});
