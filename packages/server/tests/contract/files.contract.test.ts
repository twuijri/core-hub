// `pnpm contract:test`: a conversation's files (contract decision §48) through the generated
// TypeScript client — `sessions.listFiles` and `sessions.readFile` answer only statuses they
// document, each with a body that validates against the schema documented for it: the list,
// the bytes, a path out of the folder (400), a missing file (404), one over its preview
// limit (413).
import { writeFileSync } from 'node:fs';
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
import { modules as defaultModules } from '../../src/modules/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import { PREVIEW_MAX_BYTES } from '../../src/modules/sessions/files.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

describe.skipIf(!doc)('contract: the files of a conversation', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let client: HubClient;
  let sessionId = '';

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { params?: Record<string, string>; query?: Record<string, string | boolean> } = {},
  ): Promise<unknown> {
    const op = ops.get(operationId)!;
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.query ? { query: init.query } : {}),
        responseKind: operationId === 'sessions.readFile' ? 'bytes' : 'json',
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
    return data;
  }

  beforeAll(async () => {
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({
        script: [
          { type: 'tool_started', ref: 't1', name: 'write_file', input: { path: 'notes.md' } },
          { type: 'tool_completed', ref: 't1', output: 'ok' },
          { type: 'completed' },
        ],
      }),
    });
    hub = await testHub(
      {},
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    client = createHubClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiBase: serverBasePath(document),
      profile: 'default',
    });
    const created = await client.request('post', '/sessions', { body: { agent_id: AGENT_ID } });
    const session = created.data as { id: string; working_dir: string };
    sessionId = session.id;
    writeFileSync(path.join(session.working_dir, 'notes.md'), '# ملاحظات\n');
    writeFileSync(
      path.join(session.working_dir, 'big.txt'),
      'x'.repeat(PREVIEW_MAX_BYTES.text + 1),
    );
  });
  afterAll(async () => {
    await hub.close();
  });

  it('lists the files in the documented shape', async () => {
    const list = (await call('sessions.listFiles', 200, { params: { session_id: sessionId } })) as {
      items: Array<{ key: string }>;
    };
    expect(list.items.map((f) => f.key).sort()).toEqual(['path:big.txt', 'path:notes.md']);
    await call('sessions.listFiles', 404, { params: { session_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' } });
  });

  it('reads a file, and refuses what it documents refusing', async () => {
    const bytes = await call('sessions.readFile', 200, {
      params: { session_id: sessionId },
      query: { path: 'notes.md' },
    });
    expect(new TextDecoder().decode(bytes as ArrayBuffer)).toBe('# ملاحظات\n');
    const outside = (await call('sessions.readFile', 400, {
      params: { session_id: sessionId },
      query: { path: '../../../etc/passwd' },
    })) as { details: { reason: string } };
    expect(outside.details.reason).toBe('outside_root');
    await call('sessions.readFile', 404, {
      params: { session_id: sessionId },
      query: { path: 'nope.md' },
    });
    await call('sessions.readFile', 413, {
      params: { session_id: sessionId },
      query: { path: 'big.txt' },
    });
    await call('sessions.readFile', 200, {
      params: { session_id: sessionId },
      query: { path: 'big.txt', download: true },
    });
  });
});
