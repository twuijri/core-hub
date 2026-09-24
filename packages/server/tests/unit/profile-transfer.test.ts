/**
 * Profile export and import through the hub's own routes (ADR 0014 stage 2, contract
 * decision §34), with Hermes scripted (`auth/testing/fake-profile-runtime.ts`) and
 * everything else real: the jobs runner, the file registry, the secret store.
 *
 * What must hold: an export is a real job whose archive downloads, carries no credential
 * file and no stored provider key, and is its requester's alone for 24 hours; an import
 * turns an uploaded archive into a workspace, refuses a taken name before any job, says
 * in the requester's words what is wrong with a file that is not a profile archive, and
 * passes Hermes's own refusal on; and a hub that does not supervise Hermes says so by name.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../src/lib/db.js';
import { profileTransferPorts } from '../../src/modules/index.js';
import { registerProfileTransfer } from '../../src/modules/auth/index.js';
import { fakeProfileRuntime } from '../../src/modules/auth/testing/fake-profile-runtime.js';
import { tarGz } from '../../src/modules/auth/testing/tar.js';
import { attachments } from '../../src/modules/knowledge/schema.js';
import { DataKeyRing, SecretStore } from '../../src/modules/models/index.js';
import { authed, drainJobs, signedInHub, type TestHub } from './helpers.js';

const KEY = 'sk-proj-corehub-test-0123456789abcdef';
const scratch = mkdtempSync(path.join(tmpdir(), 'corehub-transfer-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Hub = TestHub & { token: string; userId: string };
type Json = Record<string, unknown>;

let restore: ReturnType<typeof registerProfileTransfer> | undefined;
afterEach(() => {
  if (restore !== undefined) registerProfileTransfer(restore);
  restore = undefined;
});

/** Hermes scripted, the rest of the ports the real composition's. */
function withFakeHermes(files?: Parameters<typeof fakeProfileRuntime>[0]) {
  const fake = fakeProfileRuntime(files);
  restore = registerProfileTransfer((app) => profileTransferPorts(app, fake.runtime));
  return fake;
}

/** A provider key in the hub's own store, the way the Models screen keeps one. */
function storeProviderKey(hub: Hub, workspace: string): void {
  const db = requireSqlite(hub.app.hub.database);
  new SecretStore({ db, keys: DataKeyRing.open(hub.app.hub.config.dataDir) }).put(
    { workspace, ownerId: hub.userId },
    'openai',
    KEY,
  );
}

async function json(hub: Hub, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await authed(hub, hub.token, { method, url, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

/** The language the person reads the hub in; job messages follow it. */
async function speak(hub: Hub, locale: 'ar' | 'en'): Promise<void> {
  const res = await authed(hub, hub.token, {
    method: 'PATCH',
    url: '/api/v1/auth/me',
    payload: { locale },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function profiles(hub: Hub): Promise<Json[]> {
  return (await json(hub, 'GET', '/api/v1/profiles')).body.items as Json[];
}

async function job(hub: Hub, id: string): Promise<Json> {
  await drainJobs(hub.app);
  const res = await json(hub, 'GET', `/api/v1/jobs/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

function multipart(name: string, body: Buffer, purpose = 'import') {
  const boundary = '----corehubTransferBoundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        'Content-Type: application/gzip\r\n\r\n',
    ),
    body,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n--${boundary}--\r\n`,
    ),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(hub: Hub, name: string, body: Buffer): Promise<string> {
  const form = multipart(name, body);
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/attachments',
    payload: form.payload,
    headers: form.headers,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** Lists and reads an archive with the system's tar, so the check is not our own parser. */
function unpack(bytes: Buffer): { entries: string[]; read(entry: string): string } {
  const dir = mkdtempSync(path.join(scratch, 'x-'));
  const file = path.join(dir, 'a.tar.gz');
  writeFileSync(file, bytes);
  const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/\/$/, ''))
    .sort();
  execFileSync('tar', ['-xzf', file, '-C', dir]);
  return { entries, read: (entry) => readFileSync(path.join(dir, entry), 'utf8') };
}

describe('profile export', () => {
  it('is a job whose archive downloads without credential files or stored keys', async () => {
    const fake = withFakeHermes(() => [
      { path: 'SOUL.md', content: `I design things. My key was ${KEY}.\n` },
      { path: '.env', content: `OPENAI_API_KEY=${KEY}\n` },
      { path: 'memories/MEMORY.md', content: 'Likes teal. يحب اللون الأزرق المخضر.\n' },
    ]);
    const hub = await signedInHub();
    try {
      const created = await json(hub, 'POST', '/api/v1/profiles', { slug: 'design', name: 'D' });
      expect(created.status).toBe(201);
      const workspace = (await profiles(hub)).find((p) => p.slug === 'default')!.id as string;
      storeProviderKey(hub, workspace);

      const started = await json(hub, 'POST', `/api/v1/profiles/${String(created.body.id)}/export`);
      expect(started.status).toBe(202);
      const done = await job(hub, started.body.job_id as string);
      expect(done).toMatchObject({
        kind: 'export',
        status: 'succeeded',
        profile: 'default',
        resource: { kind: 'profile', id: created.body.id },
        error: null,
      });
      const result = done.result as Json;
      expect(result).toMatchObject({
        profile: 'design',
        removed: ['design/.env'],
        masked: ['design/SOUL.md'],
      });
      expect(String(result.name)).toMatch(/^design-\d{8}-\d{6}\.tar\.gz$/);
      const expires = Date.parse(String(result.expires_at)) - Date.now();
      expect(expires).toBeGreaterThan(23 * 60 * 60_000);
      expect(expires).toBeLessThanOrEqual(24 * 60 * 60_000);
      expect(fake.imported).toEqual([]);

      const download = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/attachments/${String(result.attachment_id)}/content`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload.length).toBe(result.size_bytes);
      expect(download.rawPayload.includes(Buffer.from(KEY))).toBe(false);
      const archive = unpack(download.rawPayload);
      expect(archive.entries).toEqual(['design', 'design/SOUL.md', 'design/memories/MEMORY.md']);
      expect(archive.read('design/SOUL.md')).toBe(
        `I design things. My key was ${'*'.repeat(KEY.length)}.\n`,
      );
      expect(archive.read('design/memories/MEMORY.md')).toContain('يحب اللون الأزرق المخضر');
    } finally {
      await hub.close();
    }
  });

  it("is the requester's alone, is not listed among the profile's files, and expires", async () => {
    withFakeHermes();
    const hub = await signedInHub();
    try {
      const other = await json(hub, 'POST', '/api/v1/auth/users', {
        username: 'second',
        password: 'second-admin-password',
        role: 'admin',
      });
      expect(other.status).toBe(201);
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'second', password: 'second-admin-password' },
      });
      const otherToken = (login.json() as { access_token: string }).access_token;

      const def = (await profiles(hub)).find((p) => p.slug === 'default')!;
      const started = await json(hub, 'POST', `/api/v1/profiles/${String(def.id)}/export`);
      const done = await job(hub, started.body.job_id as string);
      expect((done.result as Json).profile).toBe('default');
      const id = String((done.result as Json).attachment_id);

      const mine = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/attachments/${id}`,
      });
      expect(mine.statusCode).toBe(200);
      const theirs = await authed(hub, otherToken, {
        method: 'GET',
        url: `/api/v1/attachments/${id}/content`,
      });
      expect(theirs.statusCode).toBe(404);
      const items = await json(hub, 'GET', '/api/v1/knowledge/items?kind=file');
      expect((items.body.items as Json[]).map((item) => item.id)).not.toContain(id);

      // Past its day it is gone for its requester too, before the sweep removes the bytes.
      const db = requireSqlite(hub.app.hub.database);
      db.update(attachments)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(attachments.id, id))
        .run();
      const expired = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/attachments/${id}/content`,
      });
      expect(expired.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  });
});

describe('profile import', () => {
  it('makes a workspace from an uploaded archive, removes the upload, and takes the same file again', async () => {
    const fake = withFakeHermes();
    const hub = await signedInHub();
    try {
      const bytes = tarGz([
        { path: 'design' },
        { path: 'design/SOUL.md', content: 'I remember teal.\n' },
      ]);
      const upload1 = await upload(hub, 'design.tar.gz', bytes);
      const started = await json(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: upload1,
        slug: 'restored',
        name: 'المستعاد',
      });
      expect(started.status).toBe(202);
      const done = await job(hub, started.body.job_id as string);
      expect(done).toMatchObject({
        kind: 'import',
        status: 'succeeded',
        resource: { kind: 'attachment', id: upload1 },
        result: { slug: 'restored', name: 'المستعاد' },
      });
      expect(fake.imported.map((entry) => entry.name)).toEqual(['restored']);
      expect(fake.imported[0]!.bytes.equals(bytes)).toBe(true);
      const restored = (await profiles(hub)).find((p) => p.slug === 'restored');
      expect(restored).toMatchObject({ name: 'المستعاد', id: (done.result as Json).profile_id });

      // The upload served its purpose and is gone …
      const gone = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/attachments/${upload1}`,
      });
      expect(gone.statusCode).toBe(404);
      // … and the very same file can be uploaded again, under another name.
      const taken = await json(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: await upload(hub, 'design.tar.gz', bytes),
        slug: 'restored',
      });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('conflict');
      const again = await json(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: await upload(hub, 'design.tar.gz', bytes),
        slug: 'restored-two',
      });
      expect((await job(hub, again.body.job_id as string)).status).toBe('succeeded');
      expect((await profiles(hub)).find((p) => p.slug === 'restored-two')?.name).toBe(
        'restored-two',
      );
    } finally {
      await hub.close();
    }
  });

  it('says what is wrong with a file that is not a profile archive, and passes Hermes refusal on', async () => {
    const fake = withFakeHermes();
    fake.names.add('clash');
    const hub = await signedInHub();
    try {
      await speak(hub, 'en');
      const unknown = await json(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0AW',
        slug: 'nowhere',
      });
      expect(unknown.status).toBe(404);

      const failed = async (bytes: Buffer, slug: string) => {
        const started = await json(hub, 'POST', '/api/v1/profile-imports', {
          attachment_id: await upload(hub, 'x.tar.gz', bytes),
          slug,
        });
        expect(started.status).toBe(202);
        const done = await job(hub, started.body.job_id as string);
        expect(done.status).toBe('failed');
        return done.error as { code: string; error: string };
      };

      expect(await failed(Buffer.from('not an archive at all'), 'plain')).toEqual({
        code: 'bad_request',
        error: 'The file is not a .tar.gz archive.',
      });
      expect(
        await failed(
          tarGz([
            { path: 'one/a.md', content: 'a' },
            { path: 'two/b.md', content: 'b' },
          ]),
          'two-roots',
        ),
      ).toMatchObject({
        code: 'bad_request',
        error: expect.stringMatching(/one top-level folder/),
      });
      expect(
        await failed(
          tarGz([
            { path: 'p/a.md', content: 'a' },
            { path: 'p/link', type: '2', linkTarget: '/etc/passwd' },
          ]),
          'linked',
        ),
      ).toMatchObject({ code: 'bad_request', error: expect.stringContaining('p/link') });
      expect(await failed(tarGz([{ path: 'p/a.md', content: 'a' }]), 'clash')).toEqual({
        code: 'conflict',
        error: "Hermes refused to import the archive: Profile 'clash' already exists",
      });

      const slugs = (await profiles(hub)).map((p) => p.slug);
      for (const slug of ['plain', 'two-roots', 'linked', 'clash'])
        expect(slugs).not.toContain(slug);
      expect(fake.imported).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("answers in the requester's language", async () => {
    withFakeHermes();
    const hub = await signedInHub();
    try {
      const failure = async (slug: string) => {
        const started = await json(hub, 'POST', '/api/v1/profile-imports', {
          attachment_id: await upload(hub, 'x.tar.gz', Buffer.from(`nope ${slug}`)),
          slug,
        });
        const done = await job(hub, started.body.job_id as string);
        return (done.error as { error: string }).error;
      };
      await speak(hub, 'ar');
      expect(await failure('arabic')).toBe('الملف ليس أرشيف \u2066.tar.gz\u2069.');
      await speak(hub, 'en');
      expect(await failure('english')).toBe('The file is not a .tar.gz archive.');
    } finally {
      await hub.close();
    }
  });
});

describe('a hub that does not supervise Hermes', () => {
  it('refuses both by name, before any job exists', async () => {
    // The composition as it is: no Hermes supervised in a test hub, so no dashboard API.
    const hub = await signedInHub();
    try {
      const def = (await profiles(hub)).find((p) => p.slug === 'default')!;
      const exported = await json(hub, 'POST', `/api/v1/profiles/${String(def.id)}/export`);
      expect(exported.status).toBe(409);
      expect(exported.body).toMatchObject({
        code: 'state_invalid',
        details: { reason: 'hermes_not_supervised' },
      });
      const imported = await json(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: await upload(hub, 'x.tar.gz', tarGz([{ path: 'p/a', content: 'a' }])),
        slug: 'fresh',
      });
      expect(imported.status).toBe(409);
      expect(imported.body).toMatchObject({ details: { reason: 'hermes_not_supervised' } });
      const jobs = await json(hub, 'GET', '/api/v1/jobs');
      expect(
        (jobs.body.items as Json[]).filter((j) => ['export', 'import'].includes(String(j.kind))),
      ).toEqual([]);
    } finally {
      await hub.close();
    }
  });
});
