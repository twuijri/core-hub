// `pnpm contract:test`: the success path of every `devices` operation that answers (and the
// test notice), driven through the generated TypeScript client against a hub booted with
// HUB_ADMIN_PASSWORD, each answer validated against the schema the contract documents for that
// status. Push goes to a fake Web Push service on 127.0.0.1. The generic runner
// (contract.test.ts) covers the unauthenticated answers of the same operations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { overrideDevices } from '../../src/modules/devices/index.js';
import {
  startFakePushService,
  type FakePushService,
} from '../../src/modules/devices/testing/fake-push.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';

describe.skipIf(!doc)('contract: devices operations answer their success path', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let client: HubClient;
  let token: string | undefined;
  let push: FakePushService;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
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

  beforeAll(async () => {
    push = await startFakePushService();
    overrideDevices({ allowPrivateEndpoints: true });
    hub = await testHub({ HUB_ADMIN_PASSWORD: PASSWORD });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    client = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      profile: 'default',
      token: () => token,
    });
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    });
    token = (login.json() as { access_token: string }).access_token;
  });
  afterAll(async () => {
    overrideDevices({});
    await hub.close();
    await push.close();
  });

  it('runs the registry and push surface in order', async () => {
    const registration = {
      device_key: 'contract-browser',
      name: 'Chrome',
      platform: 'web',
      kind: 'browser',
      capabilities: ['notifications'],
    };
    const device = await call('devices.register', 201, { body: registration });
    await call('devices.register', 200, { body: registration });
    const id = device.id as string;
    const page = await call('devices.list', 200);
    expect((page.items as unknown[]).length).toBe(1);
    await call('devices.get', 200, { params: { device_id: id } });
    await call('devices.update', 200, { params: { device_id: id }, body: { name: 'Chrome 2' } });

    const config = await call('devices.getPushConfig', 200);
    expect(config.providers).toEqual(['webpush']);
    const { subscription } = push.subscribe('contract');
    await call('devices.registerPush', 200, {
      params: { device_id: id },
      body: { provider: 'webpush', token: JSON.stringify(subscription) },
    });
    const test = await call('devices.testPush', 200, { params: { device_id: id } });
    expect(test.status).toBe('sent');
    await call('notify.sendTestNotice', 201);

    await call('devices.listPushSenders', 200);
    await call('devices.setPushSender', 200, {
      params: { provider: 'webpush' },
      body: { subject: 'mailto:owner@example.com' },
    });
    await call('devices.setPushSender', 400, {
      params: { provider: 'fcm' },
      body: { service_account: 'not json' },
    });
    await call('devices.deletePushSender', 404, { params: { provider: 'apns' } });

    await call('devices.unregisterPush', 204, { params: { device_id: id } });
    await call('devices.testPush', 409, { params: { device_id: id } });
    await call('devices.unlink', 204, { params: { device_id: id } });
    await call('devices.get', 404, { params: { device_id: id } });
  });
});
