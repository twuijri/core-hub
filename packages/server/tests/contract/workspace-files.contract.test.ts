// `pnpm contract:test`: the profile's working files (contract decision §56) through the
// generated TypeScript client, signed in as the owner — every JSON operation with a success
// and a documented refusal, each body validated against the schema the contract documents
// for its status. `contract.test.ts` already covers the unauthenticated answer of every one;
// the multipart upload and the two byte streams are read in-process at the end, the way
// `attachments.contract.test.ts` reads its own.
import { mkdirSync, writeFileSync } from 'node:fs';
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

describe.skipIf(!doc)('contract: the profile’s working files', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  let anonymous: HubClient;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: {
      body?: unknown;
      query?: Record<string, string | boolean>;
      as?: HubClient;
    } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await (init.as ?? client).raw(op.method as ClientMethod, op.path, {
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
    const root = path.join(hub.dataDir, 'workspaces', 'default', 'session-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'notes.md'), '# Notes\n');
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const options = { baseUrl, apiBase: serverBasePath(document), profile: 'default' as const };
    client = createHubClient({ ...options, token: () => token });
    anonymous = createHubClient(options);
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
      as: anonymous,
    });
    token = login.access_token as string;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('lists, and refuses a path that climbs out', async () => {
    const folder = await call('knowledge.listWorkspaceFiles', 200, {
      query: { path: 'session-1' },
    });
    expect(folder.path).toBe('session-1');
    await call('knowledge.listWorkspaceFiles', 400, { query: { path: '../..' } });
    await call('knowledge.listWorkspaceFiles', 404, { query: { path: 'nowhere' } });
  });

  it('reads and saves text, and refuses a stale save', async () => {
    const read = await call('knowledge.readWorkspaceText', 200, {
      query: { path: 'session-1/notes.md' },
    });
    await call('knowledge.writeWorkspaceText', 200, {
      body: { path: 'session-1/notes.md', content: '# Notes\n\nmore\n', etag: read.etag },
    });
    await call('knowledge.writeWorkspaceText', 409, {
      body: { path: 'session-1/notes.md', content: 'stale', etag: read.etag },
    });
    await call('knowledge.readWorkspaceText', 404, { query: { path: 'session-1/none.md' } });
  });

  it('makes a folder, moves, copies, attaches and deletes', async () => {
    await call('knowledge.createWorkspaceFolder', 201, { body: { path: 'reports' } });
    await call('knowledge.createWorkspaceFolder', 409, { body: { path: 'reports' } });
    await call('knowledge.copyWorkspaceFile', 201, {
      body: { from: 'session-1/notes.md', to: 'reports/notes.md' },
    });
    await call('knowledge.copyWorkspaceFile', 409, {
      body: { from: 'session-1/notes.md', to: 'reports/notes.md' },
    });
    await call('knowledge.moveWorkspaceFile', 200, {
      body: { from: 'reports/notes.md', to: 'reports/plan.md' },
    });
    await call('knowledge.moveWorkspaceFile', 400, {
      body: { from: 'reports', to: 'reports/inner' },
    });
    await call('knowledge.attachWorkspaceFile', 201, { body: { path: 'reports/plan.md' } });
    await call('knowledge.attachWorkspaceFile', 404, { body: { path: 'reports/none.md' } });
    await call('knowledge.deleteWorkspaceFile', 204, { query: { path: 'reports' } });
    await call('knowledge.deleteWorkspaceFile', 404, { query: { path: 'reports' } });
  });

  it('uploads, downloads and zips (multipart and bytes, in-process)', async () => {
    const headers = { authorization: `Bearer ${token}`, 'x-hub-profile': 'default' };
    const boundary = '----corehubContractWorkspaceFiles';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
          'Content-Type: text/plain\r\n\r\nhello\r\n' +
          `--${boundary}--\r\n`,
      ),
    ]);
    const upload = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/workspace-files/upload?path=session-1',
      payload,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const uploadSchema = responseSchema(ops.get('knowledge.uploadWorkspaceFile')!, 201);
    expect(schemas.validate(uploadSchema!, upload.json())).toEqual([]);

    const bytes = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/workspace-files/content?path=session-1/a.txt',
      headers,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe('hello');

    const zip = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/workspace-files/archive?path=session-1',
      headers,
    });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
  });
});
