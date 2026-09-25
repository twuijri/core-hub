// `pnpm contract:test`: the live Performance and Logs operations (DECISIONS §51) driven
// through the generated TypeScript client — a signed-in owner's answers validated against the
// schema the contract documents for 200, a member's against 403, a bad query's against 400.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';

describe.skipIf(!doc)('contract: live Performance and Logs', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { query?: Record<string, string | number>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
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

  beforeAll(async () => {
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
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
    });
    token = login.access_token as string;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('audit.getLivePerformance answers the documented shape', async () => {
    const body = await call('audit.getLivePerformance', 200);
    expect(body.interval_seconds).toBe(5);
    expect((body.history as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('audit.listLogLines answers the documented shape, with every filter', async () => {
    hub.app.hub.logs.push({ level: 'error', source: 'hermes', profile: 'work', message: 'boom' });
    const body = await call('audit.listLogLines', 200, {
      query: { source: 'hermes', profile: 'work', level: 'warn', q: 'BOOM', limit: 1000, after: 0 },
    });
    expect((body.lines as Array<{ message: string }>).map((line) => line.message)).toEqual([
      'boom',
    ]);
    await call('audit.listLogLines', 400, { query: { limit: 0 } });
  });

  it('refuses a member with the documented 403', async () => {
    await call('auth.createUser', 201, {
      body: {
        username: 'noor',
        password: 'noor-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    const owner = token;
    const login = await call('auth.login', 200, {
      body: { username: 'noor', password: 'noor-password-1' },
    });
    token = login.access_token as string;
    try {
      await call('audit.getLivePerformance', 403);
      await call('audit.listLogLines', 403);
    } finally {
      token = owner;
    }
  });
});
