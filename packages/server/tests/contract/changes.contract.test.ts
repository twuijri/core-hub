// `pnpm contract:test`: the files each run changed (contract decision §49) through the generated
// TypeScript client — `sessions.listChanges`, `sessions.getRunChanges` and
// `sessions.getRunChangeDiff` answer only statuses they document, each with a body that
// validates against the schema documented for it: the list, one run, one file's diff, a file
// the run did not change (404), a run that recorded nothing (404), a missing `path` (400).
import { utimesSync, writeFileSync } from 'node:fs';
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
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

describe.skipIf(!doc)('contract: the files a run changed', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let client: HubClient;
  let sessionId = '';
  let runId = '';

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
        responseKind: 'json',
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
        onStart(request) {
          if (!request.workingDir) return;
          writeFileSync(path.join(request.workingDir, 'notes.md'), '# ملاحظات\nجديد\n');
          writeFileSync(path.join(request.workingDir, 'plan.txt'), 'one\ntwo\n');
        },
        script: [{ type: 'message_delta', text: 'تم' }, { type: 'completed' }],
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
    const past = new Date(Date.now() - 60_000);
    utimesSync(path.join(session.working_dir, 'notes.md'), past, past);
    const accepted = await client.request('post', '/sessions/{session_id}/runs', {
      params: { session_id: sessionId },
      body: { content: [{ type: 'text', text: 'اكتب' }] },
    });
    runId = (accepted.data as { run_id: string }).run_id;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await client.request('get', '/sessions/{session_id}/runs/{run_id}', {
        params: { session_id: sessionId, run_id: runId },
      });
      if ((run.data as { finished_at: string | null }).finished_at) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  afterAll(async () => {
    await hub.close();
  });

  it('lists the runs and their changed files in the documented shape', async () => {
    const list = (await call('sessions.listChanges', 200, {
      params: { session_id: sessionId },
    })) as { items: Array<{ run_id: string; files: Array<{ path: string }> }> };
    expect(list.items.map((run) => run.run_id)).toEqual([runId]);
    expect(list.items[0]!.files.map((file) => file.path)).toEqual(['notes.md', 'plan.txt']);
    await call('sessions.listChanges', 404, {
      params: { session_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' },
    });
    await call('sessions.listChanges', 400, {
      params: { session_id: sessionId },
      query: { limit: '0' },
    });
  });

  it('answers one run and one diff, and refuses what it documents refusing', async () => {
    await call('sessions.getRunChanges', 200, {
      params: { session_id: sessionId, run_id: runId },
    });
    await call('sessions.getRunChanges', 404, {
      params: { session_id: sessionId, run_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' },
    });
    const diff = (await call('sessions.getRunChangeDiff', 200, {
      params: { session_id: sessionId, run_id: runId },
      query: { path: 'notes.md' },
    })) as { text: string };
    expect(diff.text).toBe('@@ -1 +1,2 @@\n # ملاحظات\n+جديد\n');
    await call('sessions.getRunChangeDiff', 404, {
      params: { session_id: sessionId, run_id: runId },
      query: { path: 'nope.md' },
    });
    await call('sessions.getRunChangeDiff', 400, {
      params: { session_id: sessionId, run_id: runId },
    });
  });
});
