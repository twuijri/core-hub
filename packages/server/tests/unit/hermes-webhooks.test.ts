/**
 * Hermes's incoming webhooks on the agent's Channels page (decision §96), over the real routes,
 * with a fake listener standing where the profile's gateway listens:
 *
 * - a route is written where Hermes reads it (`webhook_subscriptions.json`, 0600, Hermes's shape)
 *   with a new secret, and the profile's listener is switched on, bound to this machine;
 * - the list says the routes with their address on the hub, a static route from `config.yaml`
 *   included and not deletable; a taken name is `409`; a `deliver` that is no channel is `400`;
 * - the hub's public door passes the body byte for byte, with the signature headers, and answers
 *   what the listener answered — its refusals in the hub's envelope; no listener is `503`;
 * - the test sends a POST signed with the route's secret;
 * - deleting the last route switches the listener off again.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { authed, signedInHub, type TestHub } from './helpers.js';
import {
  WEBHOOK_PORTS,
  ensureWebhookListener,
  listWebhooks,
} from '../../src/modules/agents/hermes-webhooks.js';

type Hub = TestHub & { token: string; userId: string };

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Stands where Hermes's listener would: records every POST and answers what it is told to. */
class FakeListener {
  readonly received: Received[] = [];
  answer: { status: number; body: unknown } = {
    status: 202,
    body: { status: 'accepted', route: 'github-issues', event: 'issues', delivery_id: 'd-1' },
  };
  readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      this.received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(this.answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.answer.body));
    });
  });

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup(): Promise<{ h: Hub; agent: string; home: string; fake: FakeListener }> {
  const h = await signedInHub(
    {},
    {
      agents: {
        adapterOptions: {
          hermes: {
            // A gateway that answers its probe: the runtime is `external` and has a home.
            fetchImpl: async () =>
              new Response('{"status":"ok"}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            ensureProfile: async () => undefined,
          },
        },
      },
    },
  );
  cleanups.push(() => h.close());
  const home = path.join(h.dataDir, 'hermes');
  mkdirSync(home, { recursive: true });
  const fake = new FakeListener();
  const port = await fake.listen();
  cleanups.push(() => fake.close().catch(() => undefined));
  // A port somebody set by hand is kept while no other profile has it: the fake's.
  writeFileSync(
    path.join(home, 'config.yaml'),
    [
      '# the owner keeps notes here',
      'platforms:',
      '  webhook:',
      '    enabled: false',
      '    extra:',
      `      port: ${port}`,
      '      routes:',
      '        from-config:',
      '          secret: config-secret',
      '          prompt: Static {x}',
      '',
    ].join('\n'),
  );
  const agents = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (agents.json().items as Array<{ id: string; kind: string }>).find(
    (entry) => entry.kind === 'hermes',
  )!.id;
  return { h, agent, home, fake };
}

async function create(h: Hub, agent: string, payload: Record<string, unknown>) {
  return authed(h, h.token, { method: 'POST', url: `/api/v1/agents/${agent}/webhooks`, payload });
}

describe('Hermes incoming webhooks (§96)', () => {
  it('writes a route where Hermes reads it and switches the listener on, on this machine', async () => {
    const { h, agent, home } = await setup();
    const made = await create(h, agent, {
      name: 'github-issues',
      prompt: 'A new issue: {issue.title}',
      description: 'Issues of the repository',
      events: ['issues', 'issues'],
    });
    expect(made.statusCode, made.body).toBe(201);
    const route = made.json() as Record<string, unknown>;
    expect(route).toMatchObject({
      name: 'github-issues',
      prompt: 'A new issue: {issue.title}',
      events: ['issues'],
      deliver: 'log',
      static: false,
      path: '/api/v1/hermes-webhooks/default/github-issues',
    });
    expect(String(route.secret)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const file = path.join(home, 'webhook_subscriptions.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))['github-issues']).toMatchObject({
      secret: route.secret,
      prompt: 'A new issue: {issue.title}',
      events: ['issues'],
      deliver: 'log',
      profile: 'default',
      skills: [],
    });
    const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('# the owner keeps notes here');
    const webhook = (
      parse(config) as {
        platforms: { webhook: { enabled: boolean; extra: { host: string; port: number } } };
      }
    ).platforms.webhook;
    expect(webhook.enabled).toBe(true);
    expect(webhook.extra.host).toBe('127.0.0.1');

    const list = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/webhooks`,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      listener: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    };
    expect(body.listener).toMatchObject({ enabled: true, port: webhook.extra.port });
    expect(body.items.map((item) => [item.name, item.static])).toEqual([
      ['from-config', true],
      ['github-issues', false],
    ]);

    // A name that is taken, by a subscription or by config.yaml.
    for (const name of ['github-issues', 'from-config']) {
      const again = await create(h, agent, { name, prompt: 'x' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ details: { reason: 'webhook_exists' } });
    }
    // Not Hermes's name rule; a channel the profile does not have.
    expect((await create(h, agent, { name: 'Bad Name', prompt: 'x' })).statusCode).toBe(400);
    const deliver = await create(h, agent, {
      name: 'to-telegram',
      prompt: 'x',
      deliver: 'telegram',
    });
    expect(deliver.statusCode).toBe(400);
    expect(deliver.json()).toMatchObject({ details: { field: 'deliver' } });
  });

  it('passes a POST on the hub to the listener byte for byte, and answers what it answered', async () => {
    const { h, agent, fake } = await setup();
    const made = (await create(h, agent, { name: 'github-issues', prompt: 'x' })).json() as {
      path: string;
    };
    // Exactly the bytes the sender signed, spaces and all.
    const raw = '{ "issue": {"title": "Printer on fire"},  "n": 1 }';
    const received = await h.app.inject({
      method: 'POST',
      url: made.path,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=abc',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-7',
        cookie: 'not-for-hermes=1',
      },
      payload: raw,
    });
    expect(received.statusCode, received.body).toBe(202);
    expect(received.json()).toMatchObject({ status: 'accepted', route: 'github-issues' });
    const last = fake.received.at(-1)!;
    expect(last.url).toBe('/webhooks/github-issues');
    expect(last.body.toString('utf8')).toBe(raw);
    expect(last.headers['x-hub-signature-256']).toBe('sha256=abc');
    expect(last.headers['x-github-event']).toBe('issues');
    expect(last.headers['x-github-delivery']).toBe('delivery-7');
    expect(last.headers.cookie).toBeUndefined();

    // A form body passes as it came too.
    await h.app.inject({
      method: 'POST',
      url: made.path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&b=%D8%B3',
    });
    expect(fake.received.at(-1)!.body.toString('utf8')).toBe('a=1&b=%D8%B3');

    // Hermes's refusal, in the hub's envelope with Hermes's words.
    fake.answer = { status: 401, body: { error: 'Invalid signature' } };
    const refused = await h.app.inject({ method: 'POST', url: made.path, payload: '{}' });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({
      code: 'unauthorized',
      details: { reason: 'hermes_refused', hermes_status: 401, hermes_error: 'Invalid signature' },
    });

    // No such profile; and no listener at all.
    const nowhere = await h.app.inject({
      method: 'POST',
      url: '/api/v1/hermes-webhooks/nope/github-issues',
      payload: '{}',
    });
    expect(nowhere.statusCode).toBe(404);
    await fake.close();
    const down = await h.app.inject({ method: 'POST', url: made.path, payload: '{}' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: 'service_unavailable' });
  });

  it('tests a route with a POST signed by its secret, as `hermes webhook test` does', async () => {
    const { h, agent, fake } = await setup();
    const made = (await create(h, agent, { name: 'form', prompt: 'x' })).json() as {
      secret: string;
    };
    const test = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/webhooks/form/test`,
    });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json()).toMatchObject({ status: 202, body: { status: 'accepted' } });
    const last = fake.received.at(-1)!;
    expect(last.url).toBe('/webhooks/form');
    expect(JSON.parse(last.body.toString('utf8'))).toMatchObject({
      test: true,
      event_type: 'test',
    });
    const expected = `sha256=${createHmac('sha256', made.secret).update(last.body).digest('hex')}`;
    expect(last.headers['x-hub-signature-256']).toBe(expected);
    expect(last.headers['x-github-event']).toBe('test');
    expect(String(last.headers['x-request-id'])).toMatch(/^corehub-test-/);

    const unknown = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/webhooks/nope/test`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('deletes a route, keeps a static one, and switches the listener off with the last', async () => {
    const { h, agent, home } = await setup();
    await create(h, agent, { name: 'one', prompt: 'x' });
    const url = `/api/v1/agents/${agent}/webhooks`;
    const statik = await authed(h, h.token, { method: 'DELETE', url: `${url}/from-config` });
    expect(statik.statusCode).toBe(409);
    expect(statik.json()).toMatchObject({ details: { reason: 'webhook_static' } });

    const gone = await authed(h, h.token, { method: 'DELETE', url: `${url}/one` });
    expect(gone.statusCode).toBe(204);
    expect(listWebhooks(home).map((route) => route.name)).toEqual(['from-config']);
    expect((await authed(h, h.token, { method: 'DELETE', url: `${url}/one` })).statusCode).toBe(
      404,
    );

    // With only the hand-written route left the listener stays on; drop it and it goes off.
    const config = path.join(home, 'config.yaml');
    writeFileSync(config, readFileSync(config, 'utf8').replace(/\n {6}routes:[\s\S]*$/, '\n'));
    await create(h, agent, { name: 'two', prompt: 'x' });
    await authed(h, h.token, { method: 'DELETE', url: `${url}/two` });
    const webhook = (
      parse(readFileSync(config, 'utf8')) as { platforms: { webhook: { enabled: boolean } } }
    ).platforms.webhook;
    expect(webhook.enabled).toBe(false);
  });

  it('gives each profile’s listener a port of its own', async () => {
    const { h } = await setup();
    const root = path.join(h.dataDir, 'ports');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const free = async () => true;
    const first = await ensureWebhookListener(a, [b], free);
    const second = await ensureWebhookListener(b, [a], free);
    expect(first).toBe(WEBHOOK_PORTS.first);
    expect(second).toBe(WEBHOOK_PORTS.first + 1);
    // Asked again, each keeps its own.
    expect(await ensureWebhookListener(a, [b], free)).toBe(first);
    // A port something else holds on this machine is passed over.
    const c = path.join(root, 'c');
    mkdirSync(c, { recursive: true });
    const busy = async (port: number) => port !== WEBHOOK_PORTS.first + 2;
    expect(await ensureWebhookListener(c, [a, b], busy)).toBe(WEBHOOK_PORTS.first + 3);
  });
});
