// `pnpm contract:test`: session categories (contract decision §53) driven through the generated
// TypeScript client — create, list (one profile and every profile), rename, reorder, move a
// session in and out, delete — each answer validated against the schema the contract documents
// for its status, the failures included, and the `session.updated` a delete announces
// validated against its event schema.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
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
const eventsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/events',
);

function sessionUpdatedValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as FormatsPlugin;
  addFormats(ajv);
  const schema = JSON.parse(
    readFileSync(path.join(eventsDir, 'sessions', 'session.updated.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  delete schema.$id;
  const validate = ajv.compile(schema);
  return (envelope: unknown): string[] =>
    validate(envelope)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

describe.skipIf(!doc)('contract: session categories', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  const validUpdated = sessionUpdatedValidator();
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  const updated: Array<{ event: string; payload: { session: { id: string } } }> = [];

  async function call(
    operationId: string,
    expectedStatus: number,
    init: {
      params?: Record<string, string>;
      body?: unknown;
      query?: Record<string, string>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.query ? { query: init.query } : {}),
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
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    const nsp = hub.app.hub.io.of('/rt/sessions');
    const to = nsp.to.bind(nsp);
    nsp.to = ((room: string) => {
      const target = to(room);
      return {
        emit: (event: string, envelope: never) => {
          if (event === 'session.updated') updated.push(envelope);
          return target.emit(event, envelope);
        },
      };
    }) as never;
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

  it('creates, lists, renames, reorders and deletes, with its failures', async () => {
    const launch = await call('sessions.createCategory', 201, {
      body: { name: 'الإطلاق', color: '#4a90d9' },
    });
    const research = await call('sessions.createCategory', 201, { body: { name: 'Research' } });
    await call('sessions.createCategory', 409, { body: { name: ' الإطلاق ' } });
    await call('sessions.createCategory', 400, { body: { name: '' } });

    const listed = await call('sessions.listCategories', 200);
    expect((listed.items as Array<{ name: string }>).map((c) => c.name)).toEqual([
      'الإطلاق',
      'Research',
    ]);
    const across = await call('sessions.listCategories', 200, { query: { profiles: 'all' } });
    expect((across.items as unknown[]).length).toBe(2);

    const moved = await call('sessions.updateCategory', 200, {
      params: { category_id: research.id as string },
      body: { position: 0, name: 'Research notes' },
    });
    expect(moved).toMatchObject({ position: 0, name: 'Research notes' });
    await call('sessions.updateCategory', 409, {
      params: { category_id: research.id as string },
      body: { name: 'الإطلاق' },
    });
    await call('sessions.updateCategory', 404, {
      params: { category_id: '01J8QK3ZR2W7M5N4P6T8V9X0CT' },
      body: { name: 'x' },
    });

    await call('sessions.deleteCategory', 204, { params: { category_id: launch.id as string } });
    await call('sessions.deleteCategory', 404, { params: { category_id: launch.id as string } });
    const after = await call('sessions.listCategories', 200);
    expect(after.items).toEqual([expect.objectContaining({ id: research.id, position: 0 })]);
  });

  it('moves a session in and out, and a delete announces the sessions it frees', async () => {
    const box = await call('sessions.createCategory', 201, { body: { name: 'Box' } });
    const session = await call('sessions.create', 201, { body: { agent_id: AGENT } });
    const sid = session.id as string;

    await call('sessions.update', 404, {
      params: { session_id: sid },
      body: { category_id: '01J8QK3ZR2W7M5N4P6T8V9X0CT' },
    });
    const inBox = await call('sessions.update', 200, {
      params: { session_id: sid },
      body: { category_id: box.id },
    });
    expect(inBox.category_id).toBe(box.id);
    const filtered = await call('sessions.list', 200, {
      query: { category_id: box.id as string },
    });
    expect((filtered.items as Array<{ id: string }>).map((s) => s.id)).toEqual([sid]);

    updated.length = 0;
    await call('sessions.deleteCategory', 204, { params: { category_id: box.id as string } });
    const freed = updated.filter((e) => e.payload.session.id === sid);
    expect(freed).toHaveLength(1);
    expect(validUpdated(freed[0])).toEqual([]);
    expect(freed[0]?.payload.session).toMatchObject({ category_id: null });
    const read = await call('sessions.get', 200, { params: { session_id: sid } });
    expect(read.category_id).toBeNull();
  });
});
