/**
 * Webhooks receive the hub's events (contract decision §53), end to end: the real modules
 * emit, the notify queue matches, and a real HTTP receiver on this machine records what
 * arrives — so the signature, the headers, the retries and the give-up are checked on the
 * wire, not on a stub.
 *
 * The receiver listens on 127.0.0.1, which a webhook may call only with
 * `allow_private_network`; every webhook here says so, except the one that tests the
 * rebinding refusal.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireSqlite } from '../../src/lib/db.js';
import { createRealtime } from '../../src/lib/realtime.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { emitToUser, principalScopeResolver } from '../../src/modules/auth/index.js';
import { workspaces } from '../../src/modules/auth/schema.js';
import { newUlid } from '../../src/db/ids.js';
import { overrideNotify, retryDelayMs } from '../../src/modules/notify/index.js';
import { webhookDeliveries, webhooks } from '../../src/modules/notify/schema.js';
import { webhookCatalogue } from '../../src/modules/notify/webhook-catalogue.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import { sessionsRealtimeFor } from '../../src/modules/sessions/realtime.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub, testHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';
const SECRET = 'whsec_test-secret';
const ANSWER = 'تمت إضافة الصفحة المطلوبة.';

interface Arrival {
  headers: IncomingHttpHeaders;
  body: string;
  json: Json;
  at: number;
}

interface Receiver {
  url: string;
  port: number;
  arrived: Arrival[];
  /** What the next requests are answered with, in order; the last one repeats. */
  answers: number[];
  /** Never answer (for the deadline). */
  silent: boolean;
  close(): Promise<void>;
}

async function receiver(answers: number[] = [200]): Promise<Receiver> {
  const state = { answers, silent: false };
  const arrived: Arrival[] = [];
  let served = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      arrived.push({
        headers: request.headers,
        body,
        json: JSON.parse(body) as Json,
        at: Date.now(),
      });
      if (state.silent) return;
      const status = state.answers[Math.min(served, state.answers.length - 1)] ?? 200;
      served += 1;
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    arrived,
    get answers() {
      return state.answers;
    },
    set answers(value) {
      state.answers = value;
      served = 0;
    },
    get silent() {
      return state.silent;
    },
    set silent(value) {
      state.silent = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function hubWithAgent(): Promise<Hub> {
  const runner = new FakeAgentRunner({
    script: [{ type: 'message_delta', text: ANSWER }, { type: 'completed' }],
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  return signedInHub({}, { modules });
}

async function addWebhook(hub: Hub, body: Json): Promise<Json & { id: string }> {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/notify/webhooks',
    payload: {
      name: 'receiver',
      secret: SECRET,
      allow_private_network: true,
      ...body,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json() as Json & { id: string };
}

async function deliveries(hub: Hub, id: string): Promise<Json[]> {
  const listed = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/notify/webhooks/${id}/deliveries`,
  });
  expect(listed.statusCode).toBe(200);
  return (listed.json() as { items: Json[] }).items;
}

async function chat(hub: Hub, text: string): Promise<string> {
  const session = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: AGENT },
  });
  expect(session.statusCode, session.body).toBe(201);
  const id = (session.json() as { id: string }).id;
  const run = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/sessions/${id}/runs`,
    payload: { content: [{ type: 'text', text }] },
  });
  expect(run.statusCode, run.body).toBe(202);
  return id;
}

const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

let hub: Hub;
let endpoint: Receiver;

beforeEach(async () => {
  overrideNotify({ retryBaseMs: 150, retryCapMs: 5_000, timeoutMs: 2_000 });
  endpoint = await receiver();
});

afterEach(async () => {
  overrideNotify({});
  await hub?.close();
  await endpoint.close();
});

describe('webhooks: a real chat reaches the receiver', () => {
  it('sends run.completed signed, with ids and no message text by default', async () => {
    hub = await hubWithAgent();
    const hook = await addWebhook(hub, { url: endpoint.url, events: ['run.completed'] });
    // Unsubscribed events do not arrive, and the default is five retries.
    expect(hook.max_retries).toBe(5);
    expect(hook.include_content).toBe(false);

    const sessionId = await chat(hub, 'أضف صفحة الإعدادات');
    await until(() => endpoint.arrived.length >= 1);
    const [arrival] = endpoint.arrived;
    expect(arrival!.headers['x-corehub-signature']).toBe(sign(arrival!.body));
    expect(arrival!.headers['x-corehub-event']).toBe('run.completed');
    expect(arrival!.headers['content-type']).toBe('application/json');
    expect(arrival!.json).toMatchObject({
      event: 'run.completed',
      profile: 'default',
      content_included: false,
      data: { run: { session_id: sessionId, status: 'succeeded' } },
    });
    expect(arrival!.json.id).toMatch(/^[0-9A-Z]{26}$/);
    // What people and agents wrote stays in the hub unless the webhook asks for it.
    expect(arrival!.json.data).not.toHaveProperty('message');
    expect(arrival!.body).not.toContain(ANSWER);

    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'delivered');
    const [delivery] = await deliveries(hub, hook.id);
    expect(delivery).toMatchObject({
      event: 'run.completed',
      status: 'delivered',
      attempts: 1,
      response_status: 200,
      error: null,
      next_attempt_at: null,
    });
    expect(arrival!.headers['x-corehub-delivery']).toBe(delivery!.id);
    // Only the one event it subscribed to arrived (no run.started, no deltas).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(endpoint.arrived.map((a) => a.json.event)).toEqual(['run.completed']);
  });

  it('includes the message text when the webhook says include_content', async () => {
    hub = await hubWithAgent();
    await addWebhook(hub, {
      url: endpoint.url,
      events: ['run.completed'],
      include_content: true,
    });
    await chat(hub, 'أضف صفحة الإعدادات');
    await until(() => endpoint.arrived.length >= 1);
    const json = endpoint.arrived[0]!.json;
    expect(json.content_included).toBe(true);
    expect(JSON.stringify((json.data as Json).message)).toContain(ANSWER);
  });

  it('sends task.created and task.moved from the Tasks board, without the title by default', async () => {
    hub = await hubWithAgent();
    await addWebhook(hub, { url: endpoint.url, events: ['task.created', 'task.moved'] });
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { title: 'مهمة سرية', status: 'ready', auto_start: false },
    });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { id: string }).id;
    const moved = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/move`,
      payload: { status: 'done' },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    await until(() => endpoint.arrived.length >= 2);
    const byEvent = new Map(endpoint.arrived.map((a) => [a.json.event, a.json]));
    expect(byEvent.get('task.created')).toMatchObject({ data: { task: { id: taskId } } });
    expect(byEvent.get('task.moved')).toMatchObject({
      data: { task: { id: taskId, status: 'done' } },
    });
    for (const arrival of endpoint.arrived) expect(arrival.body).not.toContain('مهمة سرية');
  });
});

describe('webhooks: every event in the catalogue', () => {
  it('fires for each one as the hub emits it, with its content fields left out', async () => {
    hub = await signedInHub();
    const catalogue = [...webhookCatalogue().values()];
    await addWebhook(hub, { url: endpoint.url, events: catalogue.map((entry) => entry.name) });
    const io = hub.app.hub.io;
    const realtime = createRealtime(io);
    const sessions = sessionsRealtimeFor(io)!;
    const secret = 'نص لا يخرج';
    // A payload that carries content at every path the contract lists for the event.
    for (const entry of catalogue) {
      const payload: Json = { marker: entry.name };
      for (const dotted of entry.content) {
        const keys = dotted.split('.');
        let node = payload;
        for (const key of keys.slice(0, -1)) node = (node[key] ??= { id: newUlid() }) as Json;
        node[keys.at(-1)!] = secret;
      }
      if (entry.namespace === '/rt/sessions') {
        sessions.emitToProfile('default', entry.name as never, payload);
      } else if (entry.namespace === '/rt/devices') {
        emitToUser(
          io,
          hub.userId,
          entry.namespace,
          entry.name,
          { ...payload, notice: { ...(payload.notice as Json), profile: 'default' } },
          Date.now(),
        );
      } else {
        realtime.emit(entry.namespace as never, entry.name, { profile: 'default' }, payload);
      }
    }
    await until(() => endpoint.arrived.length >= catalogue.length);
    expect(endpoint.arrived.map((a) => a.json.event).sort()).toEqual(
      catalogue.map((entry) => entry.name).sort(),
    );
    for (const arrival of endpoint.arrived) {
      expect(arrival.headers['x-corehub-signature']).toBe(sign(arrival.body));
      expect(arrival.json).toMatchObject({
        profile: 'default',
        content_included: false,
        data: { marker: arrival.json.event },
      });
      expect(arrival.body, String(arrival.json.event)).not.toContain(secret);
    }
  });

  it('does not forward an event outside the catalogue, or one on another namespace', async () => {
    hub = await signedInHub();
    await addWebhook(hub, { url: endpoint.url, events: ['run.completed'] });
    const realtime = createRealtime(hub.app.hub.io);
    realtime.emit('/rt/rooms' as never, 'run.completed', { profile: 'default' }, { run: {} });
    realtime.emit('/rt/tasks' as never, 'task.updated', { profile: 'default' }, { task: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(endpoint.arrived).toEqual([]);
  });

  it('refuses a subscription to a name the catalogue does not have', async () => {
    hub = await signedInHub();
    const refused = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/notify/webhooks',
      payload: {
        name: 'x',
        url: endpoint.url,
        allow_private_network: true,
        events: ['message.delta'],
      },
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe('webhooks: retries and giving up', () => {
  it('backs off exponentially, gives up as dead, and a redelivery sends the same body', async () => {
    hub = await signedInHub();
    endpoint.answers = [500];
    const hook = await addWebhook(hub, {
      url: endpoint.url,
      events: ['task.moved'],
      max_retries: 2,
    });
    createRealtime(hub.app.hub.io).emit(
      '/rt/tasks' as never,
      'task.moved',
      { profile: 'default' },
      { task: { id: newUlid() }, from: 'ready', to: 'done' },
    );
    // One attempt and two retries, then nothing more.
    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'dead', 8_000);
    expect(endpoint.arrived).toHaveLength(3);
    const gaps = [
      endpoint.arrived[1]!.at - endpoint.arrived[0]!.at,
      endpoint.arrived[2]!.at - endpoint.arrived[1]!.at,
    ];
    // 150 ms, then 300 ms: each wait doubles the one before.
    expect(gaps[0]).toBeGreaterThanOrEqual(140);
    expect(gaps[1]).toBeGreaterThanOrEqual(290);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.5);
    // A retry is the same body, so the same signature and the same event id.
    expect(new Set(endpoint.arrived.map((a) => a.body)).size).toBe(1);

    const [dead] = await deliveries(hub, hook.id);
    expect(dead).toMatchObject({
      status: 'dead',
      attempts: 3,
      response_status: 500,
      error: 'the endpoint answered 500',
      delivered_at: null,
      next_attempt_at: null,
    });
    const listed = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/webhooks' })
    ).json() as { items: Json[] };
    // One delivery failed, not three attempts.
    expect(listed.items[0]!.stats).toMatchObject({ failed: 1, delivered: 0 });

    // Redeliver once the receiver is back.
    endpoint.answers = [200];
    const again = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/notify/webhooks/${hook.id}/deliveries/${dead!.id as string}/redeliver`,
    });
    expect(again.statusCode, again.body).toBe(202);
    const queued = again.json() as Json;
    expect(queued).toMatchObject({ event: 'task.moved', status: 'queued', attempts: 0 });
    expect(queued.id).not.toBe(dead!.id);
    await until(() => endpoint.arrived.length >= 4);
    const redelivered = endpoint.arrived[3]!;
    expect(redelivered.body).toBe(endpoint.arrived[0]!.body);
    expect(redelivered.headers['x-corehub-delivery']).toBe(queued.id);
    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'delivered');

    // A delivery that arrived is not redelivered.
    const refused = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/notify/webhooks/${hook.id}/deliveries/${queued.id as string}/redeliver`,
    });
    expect(refused.statusCode).toBe(409);
  });

  it('keeps a failed delivery waiting with its next time, and delivers on the retry', async () => {
    hub = await signedInHub();
    endpoint.answers = [503, 200];
    overrideNotify({ retryBaseMs: 400, retryCapMs: 5_000, timeoutMs: 2_000 });
    const hook = await addWebhook(hub, { url: endpoint.url, events: ['task.moved'] });
    createRealtime(hub.app.hub.io).emit(
      '/rt/tasks' as never,
      'task.moved',
      { profile: 'default' },
      { task: { id: newUlid() }, from: 'ready', to: 'done' },
    );
    await until(() => endpoint.arrived.length >= 1);
    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'failed');
    const [waiting] = await deliveries(hub, hook.id);
    expect(waiting).toMatchObject({ attempts: 1, response_status: 503 });
    expect(Date.parse(waiting!.next_attempt_at as string)).toBeGreaterThan(Date.now());
    // Still retrying: not something to redeliver.
    const early = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/notify/webhooks/${hook.id}/deliveries/${waiting!.id as string}/redeliver`,
    });
    expect(early.statusCode).toBe(409);
    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'delivered');
    expect((await deliveries(hub, hook.id))[0]).toMatchObject({
      attempts: 2,
      response_status: 200,
    });
  });

  it('gives an attempt a deadline', async () => {
    hub = await signedInHub();
    endpoint.silent = true;
    overrideNotify({ retryBaseMs: 100, retryCapMs: 1_000, timeoutMs: 250 });
    const hook = await addWebhook(hub, {
      url: endpoint.url,
      events: ['task.moved'],
      max_retries: 0,
    });
    createRealtime(hub.app.hub.io).emit(
      '/rt/tasks' as never,
      'task.moved',
      { profile: 'default' },
      { task: { id: newUlid() } },
    );
    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'dead');
    expect((await deliveries(hub, hook.id))[0]).toMatchObject({
      attempts: 1,
      response_status: null,
      error: 'no answer within 0.25 s',
    });
  });

  it('doubles the production delay from 30 s and never waits more than an hour', () => {
    const production = { retryBaseMs: 30_000, retryCapMs: 3_600_000 };
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, production))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    expect(retryDelayMs(10, production)).toBe(3_600_000);
  });
});

describe('webhooks: who receives what', () => {
  async function addProfile(slug: string): Promise<string> {
    const id = newUlid();
    requireSqlite(hub.app.hub.database)
      .insert(workspaces)
      .values({ id, ownerId: hub.userId, slug, name: slug })
      .run();
    return id;
  }

  const moveIn = (profile: string) =>
    createRealtime(hub.app.hub.io).emit(
      '/rt/tasks' as never,
      'task.moved',
      { profile },
      { task: { id: newUlid() }, marker: profile },
    );

  it('sends only the profiles a webhook lists; an empty list is every profile', async () => {
    hub = await signedInHub();
    await addProfile('work');
    const onlyWork = await addWebhook(hub, {
      url: endpoint.url,
      events: ['task.moved'],
      profiles: ['work'],
    });
    const every = await addWebhook(hub, { url: endpoint.url, events: ['task.moved'] });
    moveIn('default');
    moveIn('work');
    await until(() => endpoint.arrived.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seen = endpoint.arrived.map((a) => `${a.headers['x-corehub-delivery']}`);
    expect(seen).toHaveLength(3);
    expect((await deliveries(hub, onlyWork.id)).map((d) => d.event)).toEqual(['task.moved']);
    expect(await deliveries(hub, every.id)).toHaveLength(2);
    const workOnly = endpoint.arrived.filter((a) => a.json.profile === 'work');
    expect(workOnly).toHaveLength(2);
  });

  it('refuses a profile the caller cannot enter, and stops when its creator loses the profile', async () => {
    hub = await signedInHub();
    const workId = await addProfile('work');
    const refused = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/notify/webhooks',
      payload: {
        name: 'x',
        url: endpoint.url,
        allow_private_network: true,
        events: ['task.moved'],
        profiles: ['no-such-profile'],
      },
    });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { details: Json }).details).toMatchObject({
      reason: 'profile_not_allowed',
    });

    // A member who may enter `default` only: the webhook they own never hears `work`.
    const member = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'sara',
        password: 'member-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    expect(member.statusCode, member.body).toBe(201);
    const hook = await addWebhook(hub, { url: endpoint.url, events: ['task.moved'] });
    requireSqlite(hub.app.hub.database)
      .update(webhooks)
      .set({ ownerId: (member.json() as { id: string }).id })
      .where(eq(webhooks.id, hook.id))
      .run();
    expect(workId).toBeTruthy();
    moveIn('work');
    moveIn('default');
    await until(() => endpoint.arrived.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(endpoint.arrived.map((a) => a.json.profile)).toEqual(['default']);
  });

  it('sends nothing to a webhook that is switched off', async () => {
    hub = await signedInHub();
    await addWebhook(hub, { url: endpoint.url, events: ['task.moved'], enabled: false });
    moveIn('default');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(endpoint.arrived).toEqual([]);
  });
});

describe('webhooks: the address is checked again when it is sent', () => {
  it('refuses a name that now resolves somewhere private (DNS rebinding)', async () => {
    let answer = ['93.184.216.34'];
    overrideNotify({
      retryBaseMs: 100,
      retryCapMs: 1_000,
      timeoutMs: 1_000,
      resolveHost: async (host) => (host === 'hooks.example' ? answer : []),
    });
    hub = await signedInHub();
    const hook = await addWebhook(hub, {
      url: `http://hooks.example:${endpoint.port}/hook`,
      events: ['task.moved'],
      allow_private_network: false,
      max_retries: 0,
    });
    // Public when it was saved; the same name now points at this machine.
    answer = ['127.0.0.1'];
    createRealtime(hub.app.hub.io).emit(
      '/rt/tasks' as never,
      'task.moved',
      { profile: 'default' },
      { task: { id: newUlid() } },
    );
    await until(async () => (await deliveries(hub, hook.id))[0]?.status === 'dead');
    const [refused] = await deliveries(hub, hook.id);
    expect(refused!.error).toBe('the address now resolves to a private address (127.0.0.1)');
    expect(endpoint.arrived).toEqual([]);
  });
});

describe('webhooks: the queue is the table', () => {
  it('sends what was already due when the hub starts', async () => {
    // Built but not started: rows written now are what a stopped hub left behind.
    const built = await testHub({ HUB_ADMIN_PASSWORD: 'owner-password-1' });
    const db = requireSqlite(built.app.hub.database);
    const workspace = db.select().from(workspaces).get();
    const ownerId = newUlid();
    const webhookId = newUlid();
    const deliveryId = newUlid();
    db.insert(webhooks)
      .values({
        id: webhookId,
        ownerId,
        workspace: workspace?.id ?? newUlid(),
        name: 'left behind',
        url: endpoint.url,
        events: ['task.moved'],
        allowPrivateNetwork: true,
      })
      .run();
    db.insert(webhookDeliveries)
      .values({
        id: deliveryId,
        ownerId,
        workspace: workspace?.id ?? newUlid(),
        webhookId,
        eventName: 'task.moved',
        payload: { id: deliveryId, event: 'task.moved', data: {} },
        status: 'queued',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 60_000),
      })
      .run();
    hub = { ...built, token: '', refreshToken: '', userId: ownerId };
    await built.app.ready();
    await until(() => endpoint.arrived.length >= 1);
    expect(endpoint.arrived[0]!.headers['x-corehub-delivery']).toBe(deliveryId);
    await until(
      () =>
        db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get()
          ?.status === 'delivered',
    );
  });
});
