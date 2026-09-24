/**
 * A real conversation with a real Hermes gateway, through the composed app.
 *
 * Gated: it runs only with `HERMES_E2E=1`, against `HERMES_URL` (default
 * http://127.0.0.1:8642) with `HERMES_API_KEY` (the gateway's `API_SERVER_KEY`). Without
 * them it is **skipped**, and says so — a skipped test is not a passed one. It spends real
 * model tokens on the owner's provider, which is why it never runs by accident.
 *
 * Run it:  HERMES_E2E=1 HERMES_API_KEY=… pnpm --filter @corehub/server exec vitest run --project unit src/modules/agents/hermes.e2e.test.ts
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

const enabled = process.env.HERMES_E2E === '1';
const endpoint = (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/$/, '');
const apiKey = process.env.HERMES_API_KEY ?? null;

interface Envelope {
  event: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!enabled)('Hermes for real (HERMES_E2E=1)', () => {
  let hub: TestHub & { token: string };
  let socket: Socket;
  const events: Envelope[] = [];

  beforeAll(async () => {
    if (!apiKey) throw new Error('HERMES_E2E=1 needs HERMES_API_KEY (the gateway API_SERVER_KEY)');
    const health = await fetch(`${endpoint}/health`).catch(() => null);
    if (!health?.ok) throw new Error(`no Hermes gateway answers ${endpoint}/health`);
    hub = await signedInHub(
      {},
      {
        agents: {
          // The real adapter set, the real fetch, the real gateway; no supervised child.
          adapterOptions: { hermes: { fetchImpl: fetch, defaultEndpoint: endpoint, apiKey } },
          runtime: { healthIntervalMs: 0 },
        },
      },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    socket = connect(`http://127.0.0.1:${port}/rt/sessions`, {
      path: '/rt',
      transports: ['websocket'],
      auth: { profile: 'default', token: hub.token },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    for (const name of [
      'message.delta',
      'tool.started',
      'tool.completed',
      'run.completed',
      'run.failed',
    ]) {
      socket.on(name, (envelope: Envelope) => events.push(envelope));
    }
  }, 30_000);

  afterAll(async () => {
    socket?.disconnect();
    await hub?.close();
  });

  it('answers a greeting and the hub records the transcript and the usage', async () => {
    const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
    const hermes = (
      agents.json() as { items: Array<{ id: string; slug: string; status: string }> }
    ).items.find((a) => a.slug === 'hermes');
    expect(hermes?.status).toBe('available');

    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { agent_id: hermes!.id, title: 'e2e' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;
    await new Promise<void>((resolve) =>
      socket.emit('subscribe', { session_id: sessionId }, () => resolve()),
    );

    const accepted = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'Reply with exactly one word: مرحبا' }] },
    });
    expect(accepted.statusCode).toBe(202);

    const terminal = await new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no terminal event within 120 s')), 120_000);
      const poll = setInterval(() => {
        const hit = events.find((e) => e.event === 'run.completed' || e.event === 'run.failed');
        if (hit) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(hit);
        }
      }, 100);
    });
    if (terminal.event === 'run.failed') {
      throw new Error(`Hermes failed the run: ${JSON.stringify(terminal.payload.run)}`);
    }
    const message = terminal.payload.message as { content: Array<{ type: string; text?: string }> };
    const text = message.content.map((c) => c.text ?? '').join('');
    console.info(`hermes e2e reply: ${text}`);
    expect(text.trim().length).toBeGreaterThan(0);

    const history = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/messages`,
    });
    const items = (history.json() as { items: Array<{ role: string; status: string }> }).items;
    expect(items.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(items[1]?.status).toBe('complete');
    const run = (terminal.payload.run as { usage: { input_tokens: number } }).usage;
    console.info(`hermes e2e usage: ${JSON.stringify(run)}`);
  }, 150_000);
});
