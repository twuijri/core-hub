/**
 * The profile's working files over HTTP (contract decision §56): signed in as the owner,
 * each of the eleven operations answers the schema the contract documents, refuses what the
 * contract says it refuses, and leaves an audit line for every write. A member is refused
 * every one of them. The path rules themselves are `workspace-files.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { requireSqlite } from '../../lib/db.js';

const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function expectSchema(name: string, data: unknown): void {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document?.components ?? {},
  });
  expect(
    validate(data)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
    `response does not match ${name}`,
  ).toEqual([]);
}

function multipart(name: string, body: Buffer) {
  const boundary = '----corehubWorkspaceFiles';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('workspace files over HTTP', () => {
  let hub: TestHub & { token: string };
  let memberToken: string;
  let root: string;
  const as = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) =>
    authed(hub, hub.token, {
      method,
      url: `/api/v1${url}`,
      ...(payload !== undefined ? { payload } : {}),
      ...(headers ? { headers } : {}),
    });

  beforeAll(async () => {
    hub = await signedInHub();
    root = path.join(hub.dataDir, 'workspaces', 'default');
    mkdirSync(path.join(root, 'session-1'), { recursive: true });
    writeFileSync(path.join(root, 'session-1', 'notes.md'), '# Notes\n');
    writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>');
    mkdirSync(path.join(hub.dataDir, 'keys'), { recursive: true });
    writeFileSync(path.join(hub.dataDir, 'keys', 'master.key'), 'secret');
    symlinkSync(path.join(hub.dataDir, 'keys'), path.join(root, 'keys-link'));

    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'member1',
        password: 'member-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'member1', password: 'member-password-1' },
    });
    memberToken = (login.json() as { access_token: string }).access_token;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('lists a folder as a `WorkspaceFolder`, with the caps', async () => {
    const res = await as('GET', '/workspace-files?path=session-1');
    expect(res.statusCode, res.body).toBe(200);
    expectSchema('WorkspaceFolder', res.json());
    expect(res.json()).toMatchObject({
      profile: 'default',
      path: 'session-1',
      entries: [{ name: 'notes.md', kind: 'file', editable: true }],
      limits: { max_edit_bytes: 1048576 },
    });
    const top = await as('GET', '/workspace-files');
    expectSchema('WorkspaceFolder', top.json());
    const link = (top.json() as { entries: Array<{ name: string; kind: string }> }).entries.find(
      (entry) => entry.name === 'keys-link',
    );
    expect(link).toMatchObject({ kind: 'link' });
  });

  it('refuses a member every operation (owner and admin only)', async () => {
    const calls: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['GET', '/workspace-files'],
      ['GET', '/workspace-files/content?path=session-1/notes.md'],
      ['GET', '/workspace-files/archive'],
      ['GET', '/workspace-files/text?path=session-1/notes.md'],
      ['PUT', '/workspace-files/text', { path: 'x.txt', content: 'x', etag: null }],
      ['POST', '/workspace-files/folders', { path: 'x' }],
      ['POST', '/workspace-files/move', { from: 'page.html', to: 'x.html' }],
      ['POST', '/workspace-files/copy', { from: 'page.html', to: 'x.html' }],
      ['POST', '/workspace-files/attach', { path: 'page.html' }],
      ['DELETE', '/workspace-files?path=page.html'],
    ];
    for (const [method, url, payload] of calls) {
      const res = await authed(hub, memberToken, {
        method,
        url: `/api/v1${url}`,
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const upload = multipart('m.txt', Buffer.from('x'));
    const refused = await authed(hub, memberToken, {
      method: 'POST',
      url: '/api/v1/workspace-files/upload',
      payload: upload.payload,
      headers: upload.headers,
    });
    expect(refused.statusCode).toBe(403);
    expect(existsSync(path.join(root, 'x.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'page.html'))).toBe(true);
  });

  it('refuses traversal, absolute paths and an escaping link with `400`', async () => {
    for (const bad of ['..', '../../keys', '/etc', 'keys-link', 'keys-link/master.key']) {
      const res = await as('GET', `/workspace-files/content?path=${encodeURIComponent(bad)}`);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({ code: 'validation_failed' });
    }
    const write = await as('PUT', '/workspace-files/text', {
      path: 'keys-link/new.key',
      content: 'x',
      etag: null,
    });
    expect(write.statusCode).toBe(400);
    expect(write.json()).toMatchObject({ details: { reason: 'symlink_outside' } });
    expect(existsSync(path.join(hub.dataDir, 'keys', 'new.key'))).toBe(false);
  });

  it('downloads bytes with an etag, and never serves an agent’s HTML as a page', async () => {
    const notes = await as('GET', '/workspace-files/content?path=session-1/notes.md');
    expect(notes.statusCode).toBe(200);
    expect(notes.body).toBe('# Notes\n');
    expect(notes.headers.etag).toBeTruthy();
    expect(String(notes.headers['content-disposition'])).toMatch(/^attachment/);
    const html = await as('GET', '/workspace-files/content?path=page.html&disposition=inline');
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    const folder = await as('GET', '/workspace-files/content?path=session-1');
    expect(folder.statusCode).toBe(400);
  });

  it('edits text with the save-conflict check, and audits every write', async () => {
    const read = await as('GET', '/workspace-files/text?path=session-1/notes.md');
    expect(read.statusCode).toBe(200);
    expectSchema('WorkspaceText', read.json());
    const { etag } = read.json() as { etag: string };

    const saved = await as('PUT', '/workspace-files/text', {
      path: 'session-1/notes.md',
      content: '# Notes\n\nedited\n',
      etag,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expectSchema('WorkspaceText', saved.json());

    // The same stale etag again: the file changed since, so nothing is written.
    const stale = await as('PUT', '/workspace-files/text', {
      path: 'session-1/notes.md',
      content: 'lost',
      etag,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'conflict',
      details: { reason: 'changed', etag: (saved.json() as { etag: string }).etag },
    });
    expect(readFileSync(path.join(root, 'session-1', 'notes.md'), 'utf8')).toBe(
      '# Notes\n\nedited\n',
    );
  });

  it('uploads, makes a folder, moves, copies, zips and deletes', async () => {
    const form = multipart('data.csv', Buffer.from('a,b\n1,2\n'));
    const up = await as(
      'POST',
      '/workspace-files/upload?path=session-1',
      form.payload,
      form.headers,
    );
    expect(up.statusCode, up.body).toBe(201);
    expectSchema('WorkspaceFileEntry', up.json());
    const again = await as(
      'POST',
      '/workspace-files/upload?path=session-1',
      form.payload,
      form.headers,
    );
    expect(again.statusCode).toBe(409);
    const overwrite = await as(
      'POST',
      '/workspace-files/upload?path=session-1&overwrite=true',
      form.payload,
      form.headers,
    );
    expect(overwrite.statusCode).toBe(201);

    const folder = await as('POST', '/workspace-files/folders', { path: 'reports/2026' });
    expect(folder.statusCode).toBe(201);
    expectSchema('WorkspaceFileEntry', folder.json());

    const moved = await as('POST', '/workspace-files/move', {
      from: 'session-1/data.csv',
      to: 'reports/2026/data.csv',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ path: 'reports/2026/data.csv' });

    const copied = await as('POST', '/workspace-files/copy', {
      from: 'reports',
      to: 'reports-copy',
    });
    expect(copied.statusCode).toBe(201);
    expect(readFileSync(path.join(root, 'reports-copy', '2026', 'data.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );

    const zip = await as('GET', '/workspace-files/archive?path=reports');
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const gone = await as('DELETE', '/workspace-files?path=reports-copy');
    expect(gone.statusCode).toBe(204);
    expect(existsSync(path.join(root, 'reports-copy'))).toBe(false);
    const root404 = await as('DELETE', '/workspace-files?path=');
    expect(root404.statusCode).toBe(400);

    // The audit trail is `audit`'s table; read it the way a report would, by its action.
    const actions = requireSqlite(hub.app.hub.database)
      .all<{ action: string }>(
        sql`SELECT action FROM audit_events WHERE action LIKE 'workspace_file.%'`,
      )
      .map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'workspace_file.written',
        'workspace_file.uploaded',
        'workspace_file.folder_created',
        'workspace_file.moved',
        'workspace_file.copied',
        'workspace_file.zipped',
        'workspace_file.deleted',
      ]),
    );
  });

  it('makes an attachment of a file, with the same bytes', async () => {
    const res = await as('POST', '/workspace-files/attach', { path: 'session-1/notes.md' });
    expect(res.statusCode, res.body).toBe(201);
    expectSchema('Attachment', res.json());
    const attachment = res.json() as { id: string; name: string; purpose: string };
    expect(attachment).toMatchObject({ name: 'notes.md', purpose: 'message' });
    const bytes = await as('GET', `/attachments/${attachment.id}/content`);
    expect(bytes.body).toBe(readFileSync(path.join(root, 'session-1', 'notes.md'), 'utf8'));
    const missing = await as('POST', '/workspace-files/attach', { path: 'nope.txt' });
    expect(missing.statusCode).toBe(404);
  });
});
