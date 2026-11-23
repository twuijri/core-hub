// `pnpm contract:test`: the model gateway's external entrance (DECISIONS §156, ADR 0033 §3)
// through the generated TypeScript client — its admin switch, and the five wire routes with a
// person's app token. Every answer's status is documented for its operation and its body valid
// against the schema the contract gives that status; the wire routes' errors are in the
// caller's own envelope (`x-error-envelope: wire`), never the hub's `{error, code}`.
// CLIProxyAPI is the stand-in of the gateway's own tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { requireSqlite } from '../../src/lib/db.js';
import { EXTERNAL_USAGE_AGENT_ID } from '../../src/modules/audit/index.js';
import { drainJobs, testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/modules/models/gateway/testing/fake-cliproxy.mjs',
);
const MODEL = 'anthropic/claude-sonnet-4-5';

/**
 * The JSON schema documented for a status, a `#/components/responses/…` reference followed (the
 * wire routes' errors are shared responses, which `responseSchema` leaves unresolved).
 */
function schemaOf(
  op: NonNullable<ReturnType<ReturnType<typeof operationsById>['get']>>,
  status: number,
): Record<string, unknown> | undefined {
  const documented = (op.operation.responses ?? {})[String(status)] as
    { $ref?: string; content?: Record<string, { schema?: Record<string, unknown> }> } | undefined;
  if (!documented) throw new Error(`status ${status} is not documented for ${op.operationId}`);
  if (documented.$ref) {
    const name = documented.$ref.split('/').pop()!;
    const shared = (doc!.components?.responses as Record<string, typeof documented>)[name];
    return shared?.content?.['application/json']?.schema;
  }
  return responseSchema(op, status);
}

/** Anthropic's model list, as the provider row's refresh reads it. */
const providers = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith('https://api.anthropic.com/v1/models')) {
    return new Response(
      JSON.stringify({
        data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
        has_more: false,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', { status: 503 });
}) as typeof fetch;

describe.skipIf(!doc)('contract: the model gateway’s external entrance', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let session: string | undefined;
  let appToken: string | undefined;
  let admin: HubClient;
  let program: HubClient;
  let anonymous: HubClient;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { body?: unknown; as?: HubClient; headers?: Record<string, string> } = {},
  ): Promise<{ data: unknown; headers: Headers | null }> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    let headers: Headers | null = null;
    try {
      const res = await (init.as ?? admin).raw(op.method as ClientMethod, op.path, {
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
      });
      status = res.status;
      data = res.data;
      headers = res.headers;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = schemaOf(op, status);
    if (schema && typeof data === 'object') {
      expect(schemas.validate(schema, data), operationId).toEqual([]);
    }
    if (status >= 400 && op.operation['x-error-envelope'] !== 'wire') {
      expect(data).toMatchObject({ error: expect.any(String), code: expect.any(String) });
    }
    return { data, headers };
  }

  beforeAll(async () => {
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD, COREHUB_MODEL_GATEWAY: 'on' },
      { models: { fetchImpl: providers, cliproxyBin: FAKE } },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const options = { baseUrl, apiBase: serverBasePath(document), profile: 'default' as const };
    admin = createHubClient({ ...options, token: () => session });
    program = createHubClient({ ...options, token: () => appToken });
    anonymous = createHubClient(options);
  });
  afterAll(async () => {
    await hub.close();
  });

  it('signs in, adds a provider and makes a personal app token', async () => {
    const { data } = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
      as: anonymous,
    });
    session = (data as { access_token: string }).access_token;
    await call('models.createProvider', 201, {
      body: { preset: 'anthropic', label: 'Anthropic', kind: 'llm', api_key: 'sk-ant-stays' },
    });
    await drainJobs(hub.app);
    const made = await call('auth.createAppToken', 201, {
      body: { name: 'DeepSeek Harness', scopes: ['read', 'write'], expires_at: null },
    });
    appToken = (made.data as { token: string }).token;
    expect(appToken).toMatch(/^hub_at_/);
  });

  it('getExternalGateway: off by default for an admin; 401 without a token', async () => {
    const { data } = await call('models.getExternalGateway', 200);
    expect(data).toMatchObject({
      enabled: false,
      available: true,
      openai_base_path: '/api/v1/gateway/openai/v1',
      anthropic_base_path: '/api/v1/gateway/anthropic',
      rate_limit_per_minute: 120,
    });
    await call('models.getExternalGateway', 401, { as: anonymous });
  });

  it('while it is off, every wire route refuses in its own envelope', async () => {
    const { data } = await call('gateway.openaiListModels', 403, { as: program });
    expect(data).toMatchObject({ error: { type: 'permission_error' } });
    const anthropic = await call('gateway.anthropicMessages', 403, {
      as: program,
      body: { model: MODEL, max_tokens: 5, messages: [] },
    });
    expect(anthropic.data).toMatchObject({ type: 'error', error: { type: 'permission_error' } });
  });

  it('updateExternalGateway: an admin switches it on; a bad body is 400', async () => {
    await call('models.updateExternalGateway', 400, { body: { enabled: 'yes' } });
    const { data } = await call('models.updateExternalGateway', 200, { body: { enabled: true } });
    expect(data).toMatchObject({ enabled: true, available: true });
    await call('models.updateExternalGateway', 401, { as: anonymous, body: { enabled: false } });
  });

  it('openaiListModels: the hub ids for an app token; 401 without one; 403 for a web session', async () => {
    const { data } = await call('gateway.openaiListModels', 200, { as: program });
    expect((data as { data: { id: string }[] }).data.map((m) => m.id)).toContain(MODEL);
    // Each entry says what the model takes in (amendment 2026-11-23): Anthropic's models take
    // images, so the harness may send one.
    expect((data as { data: { id: string }[] }).data.find((m) => m.id === MODEL)).toMatchObject({
      context_window: null,
      input_modalities: ['text', 'image'],
    });
    const none = await call('gateway.openaiListModels', 401, { as: anonymous });
    expect(none.data).toMatchObject({ error: { type: 'authentication_error' } });
    await call('gateway.openaiListModels', 403, { as: admin });
  });

  it('anthropicListModels: the key as x-api-key; 401 with a key the hub does not hold', async () => {
    const { data } = await call('gateway.anthropicListModels', 200, {
      as: anonymous,
      headers: { 'x-api-key': appToken! },
    });
    expect((data as { data: { id: string }[] }).data.map((m) => m.id)).toContain(MODEL);
    expect((data as { data: { id: string }[] }).data.find((m) => m.id === MODEL)).toMatchObject({
      input_modalities: ['text', 'image'],
    });
    const wrong = await call('gateway.anthropicListModels', 401, {
      as: anonymous,
      headers: { 'x-api-key': 'hub_at_not-a-token-of-this-hub' },
    });
    expect(wrong.data).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  it('anthropicMessages: the named hub model through CLIProxyAPI, usage in the ledger as external; 400 for an unknown model', async () => {
    const { data, headers } = await call('gateway.anthropicMessages', 200, {
      as: program,
      body: { model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(data).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'hello' }] });
    expect(headers?.get('x-fake-model')).toMatch(/\/claude-sonnet-4-5$/);
    // The provider's key stays in the hub: the translator was asked with the hub's own key.
    expect(headers?.get('x-fake-authorization')).not.toContain('sk-ant-stays');
    const rows = requireSqlite(hub.app.hub.database)
      .$client.prepare(
        "select origin_kind, input_tokens, output_tokens from usage_records where origin_kind = 'external'",
      )
      .all();
    expect(rows).toEqual([{ origin_kind: 'external', input_tokens: 10, output_tokens: 2 }]);
    // The Usage screen counts it, named as the person's own apps rather than a removed agent.
    const usage = await call('audit.getUsage', 200);
    expect((usage.data as { by_agent: unknown[] }).by_agent).toContainEqual(
      expect.objectContaining({
        agent_id: EXTERNAL_USAGE_AGENT_ID,
        name: 'Your own apps (through the gateway)',
        input_tokens: 10,
      }),
    );
    const unknown = await call('gateway.anthropicMessages', 400, {
      as: program,
      body: { model: 'anthropic/not-a-model', max_tokens: 5, messages: [] },
    });
    expect(unknown.data).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('openaiChatCompletions: answers as a stream; 400 without a model', async () => {
    const { data, headers } = await call('gateway.openaiChatCompletions', 200, {
      as: program,
      body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(String(data)).toContain('hello');
    expect(headers?.get('x-fake-path')).toBe('/v1/chat/completions');
    const missing = await call('gateway.openaiChatCompletions', 400, {
      as: program,
      body: { messages: [] },
    });
    expect(missing.data).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('openaiResponses: answers on the Responses wire; 401 without a token', async () => {
    const { data, headers } = await call('gateway.openaiResponses', 200, {
      as: program,
      body: { model: MODEL, input: 'hi', stream: true },
    });
    expect(String(data)).toContain('response.completed');
    expect(headers?.get('x-fake-path')).toBe('/v1/responses');
    await call('gateway.openaiResponses', 401, {
      as: anonymous,
      body: { model: MODEL, input: 'hi' },
    });
  });
});

describe.skipIf(!doc)('contract: the external entrance’s rate limit', () => {
  const document = doc!;
  const schemas = ajvFor(document);
  const ops = operationsById(document);
  let hub: TestHub;
  let client: HubClient;

  beforeAll(async () => {
    hub = await testHub(
      {
        HUB_ADMIN_PASSWORD: PASSWORD,
        COREHUB_MODEL_GATEWAY: 'on',
        COREHUB_EXTERNAL_GATEWAY_RATE_LIMIT: '2',
      },
      { models: { fetchImpl: providers, cliproxyBin: FAKE } },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const options = { baseUrl, apiBase: serverBasePath(document), profile: 'default' as const };
    const anonymous = createHubClient(options);
    const login = await anonymous.raw('post', '/auth/login', {
      body: { username: 'admin', password: PASSWORD },
    });
    const session = (login.data as { access_token: string }).access_token;
    const admin = createHubClient({ ...options, token: session });
    await admin.raw('patch', '/models/external-gateway', { body: { enabled: true } });
    const made = await admin.raw('post', '/auth/app-tokens', {
      body: { name: 'DeepSeek Harness', scopes: ['read', 'write'], expires_at: null },
    });
    client = createHubClient({ ...options, token: (made.data as { token: string }).token });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('answers 429 with retry-after once a token made its calls this minute', async () => {
    const op = ops.get('gateway.anthropicListModels')!;
    for (let i = 0; i < 2; i += 1) {
      expect((await client.raw('get', op.path)).status).toBe(200);
    }
    const refused = await client.raw('get', op.path).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HubApiError);
    const error = refused as HubApiError;
    expect(error.status).toBe(429);
    expect(schemas.validate(schemaOf(op, 429)!, error.body)).toEqual([]);
    expect(error.body).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
  });
});
