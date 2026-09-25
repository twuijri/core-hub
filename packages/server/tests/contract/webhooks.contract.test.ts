// `pnpm contract:test`: webhooks receive the hub's events (decision §53), driven through the
// generated TypeScript client. Every answer is validated against the schema the contract
// documents for its status, and every body a receiver gets against `WebhookPayload` — with
// its `data` against the realtime event schema it says it follows, and its headers against
// the ones `webhooks.hubEvent` declares.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  derived,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { overrideNotify } from '../../src/modules/notify/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const AGENT = '01KAGENTXYZ000000000000000';
const SECRET = 'whsec_contract';
const eventsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/events',
);

interface Arrival {
  headers: IncomingHttpHeaders;
  body: string;
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!doc)('contract: webhooks receive the events they subscribe to', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  const components = document.components as { schemas: Record<string, Record<string, unknown>> };
  const catalogue = components.schemas.WebhookEventName!['x-webhook-events'] as Record<
    string,
    { source: string }
  >;
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  let receiver: Server;
  let receiverUrl: string;
  /** What the receiver answers next; the test that wants a failure sets 500. */
  let answer = 200;
  const arrived: Arrival[] = [];

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.query ? { query: init.query } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      status = res.status;
      data = res.data;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, data), operationId).toEqual([]);
    return (data ?? {}) as Record<string, unknown>;
  }

  /** The event schema a delivery's `data` follows: its `payload`, with its `$defs`. */
  function dataValidator(event: string) {
    const entry = catalogue[event]!;
    const file = path.join(eventsDir, entry.source, `${event}.schema.json`);
    const schema = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
      addFormatsModule) as FormatsPlugin;
    addFormats(ajv);
    const payload = (schema.properties as Record<string, unknown>).payload;
    return ajv.compile({ ...(payload as object), $defs: schema.$defs });
  }

  beforeAll(async () => {
    overrideNotify({ retryBaseMs: 100, retryCapMs: 1_000, timeoutMs: 2_000 });
    receiver = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        arrived.push({ headers: request.headers, body });
        response.writeHead(answer).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner: new FakeAgentRunner({
        script: [{ type: 'message_delta', text: 'تم.' }, { type: 'completed' }],
      }),
      agentTimeoutMs: 5_000,
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    client = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      profile: 'default',
      token: () => token,
    });
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
    });
    token = login.access_token as string;
  });
  afterAll(async () => {
    overrideNotify({});
    await hub.close();
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  });

  it('serves the catalogue the contract lists, with its descriptions', async () => {
    const events = await call('notify.listWebhookEvents', 200);
    const items = events.items as Array<{ name: string; description: { ar: string } }>;
    expect(items.map((item) => item.name)).toEqual(
      components.schemas.WebhookEventName!.enum as string[],
    );
    expect(items.every((item) => item.description.ar !== item.name)).toBe(true);
  });

  it('delivers a chat run as a WebhookPayload whose data is the run.completed payload', async () => {
    const hook = await call('notify.createWebhook', 201, {
      body: {
        name: 'contract',
        url: receiverUrl,
        events: ['run.completed', 'run.failed'],
        secret: SECRET,
        allow_private_network: true,
        include_content: true,
      },
    });
    expect(hook.max_retries).toBe(5);
    const session = await call('sessions.create', 201, { body: { agent_id: AGENT } });
    await call('sessions.createRun', 202, {
      params: { session_id: session.id as string },
      body: { content: [{ type: 'text', text: 'مرحبا' }] },
    });
    await until(() => arrived.length >= 1);
    const arrival = arrived[0]!;
    const body = JSON.parse(arrival.body) as Record<string, unknown>;
    expect(schemas.validate({ $ref: '#/components/schemas/WebhookPayload' }, body)).toEqual([]);
    // With content included the data is the realtime payload whole, and valid against it.
    const valid = dataValidator('run.completed');
    expect(valid(body.data), JSON.stringify(valid.errors)).toBe(true);
    expect(body).toMatchObject({ event: 'run.completed', content_included: true });
    expect(arrival.headers[derived.webhookSignatureHeader]).toBe(
      `sha256=${createHmac('sha256', SECRET).update(arrival.body).digest('hex')}`,
    );
    expect(arrival.headers[derived.webhookEventHeader]).toBe('run.completed');

    await until(async () => {
      const listed = await call('notify.listWebhookDeliveries', 200, {
        params: { webhook_id: hook.id as string },
      });
      return (listed.items as Array<{ status: string }>)[0]?.status === 'delivered';
    });
    const listed = await call('notify.listWebhookDeliveries', 200, {
      params: { webhook_id: hook.id as string },
    });
    const delivery = (listed.items as Array<Record<string, unknown>>)[0]!;
    expect(arrival.headers[derived.webhookDeliveryHeader]).toBe(delivery.id);
    await call('notify.deleteWebhook', 204, { params: { webhook_id: hook.id as string } });
  });

  it('gives up with a dead delivery the contract describes, and redelivers it', async () => {
    answer = 500;
    arrived.length = 0;
    const hook = await call('notify.createWebhook', 201, {
      body: {
        name: 'failing',
        url: receiverUrl,
        events: ['task.created'],
        allow_private_network: true,
        max_retries: 1,
      },
    });
    await call('tasks.createTask', 201, {
      body: { title: 'contract task', status: 'ready', auto_start: false },
    });
    let dead: Record<string, unknown> | undefined;
    await until(async () => {
      const listed = await call('notify.listWebhookDeliveries', 200, {
        params: { webhook_id: hook.id as string },
      });
      dead = (listed.items as Array<Record<string, unknown>>)[0];
      return dead?.status === 'dead';
    });
    expect(dead).toMatchObject({ attempts: 2, response_status: 500, next_attempt_at: null });
    // Without content, the title is not in what was sent.
    expect(arrived.every((a) => !a.body.includes('contract task'))).toBe(true);

    answer = 200;
    const queued = await call('notify.redeliverWebhookDelivery', 202, {
      params: { webhook_id: hook.id as string, delivery_id: dead!.id as string },
    });
    expect(queued).toMatchObject({ status: 'queued', attempts: 0, event: 'task.created' });
    await until(() => arrived.length >= 3);
    await call('notify.redeliverWebhookDelivery', 409, {
      params: { webhook_id: hook.id as string, delivery_id: queued.id as string },
    });
    await call('notify.redeliverWebhookDelivery', 404, {
      params: { webhook_id: hook.id as string, delivery_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' },
    });
  });

  it('refuses an event outside the catalogue and a profile nobody can enter', async () => {
    await call('notify.createWebhook', 400, {
      body: { name: 'x', url: receiverUrl, allow_private_network: true, events: ['typing'] },
    });
    await call('notify.createWebhook', 400, {
      body: { name: 'x', url: receiverUrl, allow_private_network: true, profiles: ['nowhere'] },
    });
  });
});
