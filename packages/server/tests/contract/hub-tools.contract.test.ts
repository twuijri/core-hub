// `pnpm contract:test`: the hub's own tools (contract decision §47) through the generated
// client over real HTTP — the card's two operations and the MCP endpoint, every answer
// validated against the schema the contract documents for its status.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

describe.skipIf(!doc)("contract: the hub's own tools and its MCP endpoint", () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let bearer: string | undefined;
  let client: HubClient;

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
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } },
    );
    mkdirSync(path.join(hub.dataDir, 'hermes'), { recursive: true });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    client = createHubClient({
      baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
      apiBase: serverBasePath(document),
      profile: 'default',
      token: () => bearer,
    });
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
    });
    bearer = login.access_token as string;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('reads and switches the card, then speaks MCP with the key it wrote', async () => {
    const agents = await call('agents.list', 200);
    const hermes = (agents.items as Array<{ id: string; kind: string }>).find(
      (a) => a.kind === 'hermes',
    )!;
    const before = await call('agents.getHubTools', 200, { params: { agent_id: hermes.id } });
    expect(before.enabled).toBe(false);
    const after = await call('agents.updateHubTools', 200, {
      params: { agent_id: hermes.id },
      body: { enabled: true, groups: [{ id: 'tasks', allow_writes: true }] },
    });
    expect(after.enabled).toBe(true);
    // The URL names the port this hub actually listens on.
    const address = hub.app.server.address();
    expect(after.url).toBe(
      `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/v1/hub-mcp`,
    );
    const person = bearer;
    const env = readFileSync(path.join(hub.dataDir, 'hermes', '.env'), 'utf8');
    bearer = /COREHUB_MCP_TOKEN=(\S+)/.exec(env)![1];

    const init = await call('agents.hubMcp', 200, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
    });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18' });
    await call('agents.hubMcp', 202, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    const tools = await call('agents.hubMcp', 200, {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    expect((tools.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
    const refused = await call('agents.hubMcp', 200, {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tasks.list', arguments: {} },
      },
    });
    expect(refused.result).toMatchObject({ isError: true });

    bearer = 'hub_mcp_not-a-key';
    await call('agents.hubMcp', 401, { body: { jsonrpc: '2.0', id: 4, method: 'ping' } });
    bearer = person;
    await call('agents.getHubTools', 200, { params: { agent_id: hermes.id } });
  });
});
