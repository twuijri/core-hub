// `pnpm contract:test`: the same bytes uploaded again — after a delete, and under another name —
// through the generated TypeScript client, every answer validated against the schema the
// contract documents for its status (contract decision §39). Before the fix both uploads
// answered `500`, a status `sessions.uploadAttachment` never documented.
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
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('the same picture, twice'),
]);

/** A file as the browser's `FormData` sends it. */
function form(name: string, body: Buffer) {
  const boundary = '----corehubContractAttachments';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: image/png\r\n\r\n',
      ),
      body,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nmessage\r\n--${boundary}--\r\n`,
      ),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe.skipIf(!doc)('contract: the same file uploaded again', () => {
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
    init: { params?: Record<string, string>; body?: unknown; as?: HubClient } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await (init.as ?? client).raw(op.method as ClientMethod, op.path, {
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

  /** `sessions.uploadAttachment`: multipart, which the generated client does not build. */
  async function upload(name: string): Promise<Record<string, unknown>> {
    const body = form(name, PNG);
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      payload: body.payload,
      headers: { ...body.headers, authorization: `Bearer ${token}`, 'x-hub-profile': 'default' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const schema = responseSchema(ops.get('sessions.uploadAttachment')!, res.statusCode);
    expect(schemas.validate(schema!, res.json()), 'sessions.uploadAttachment').toEqual([]);
    return res.json() as Record<string, unknown>;
  }

  /** `sessions.downloadAttachment`: a byte stream, read in-process (no socket left open). */
  async function bytesOf(id: string): Promise<Buffer> {
    const res = await hub.app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}/content`,
      headers: { authorization: `Bearer ${token}`, 'x-hub-profile': 'default' },
    });
    expect(res.statusCode).toBe(200);
    return res.rawPayload;
  }

  beforeAll(async () => {
    hub = await testHub({ HUB_ADMIN_PASSWORD: PASSWORD });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const options = { baseUrl, apiBase: serverBasePath(document), profile: 'default' as const };
    client = createHubClient({ ...options, token: () => token });
    anonymous = createHubClient(options);
  });
  afterAll(async () => {
    await hub.close();
  });

  it('signs in', async () => {
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
      as: anonymous,
    });
    token = login.access_token as string;
  });

  it('takes the file again after a delete', async () => {
    const first = await upload('shot.png');
    await call('sessions.deleteAttachment', 204, { params: { attachment_id: first.id as string } });
    await call('sessions.getAttachment', 404, { params: { attachment_id: first.id as string } });

    const again = await upload('shot.png');
    expect(again.id).not.toBe(first.id);
    expect(again.sha256).toBe(first.sha256);
    expect(await bytesOf(again.id as string)).toEqual(PNG);
  });

  it('takes the same bytes under another name; deleting one keeps the other', async () => {
    const a = await upload('holiday.png');
    const b = await upload('holiday (copy).png');
    expect(b.id).not.toBe(a.id);
    expect(b.name).toBe('holiday (copy).png');

    await call('sessions.deleteAttachment', 204, { params: { attachment_id: a.id as string } });
    const kept = await call('sessions.getAttachment', 200, {
      params: { attachment_id: b.id as string },
    });
    expect(kept.id).toBe(b.id);
    expect(await bytesOf(b.id as string)).toEqual(PNG);
  });
});
