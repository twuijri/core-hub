/**
 * A profile's providers in an export and an import (contract decision §37), with Hermes
 * scripted (`auth/testing/fake-profile-runtime.ts`) and everything else real.
 *
 * The owner's choice: an export asks «مع المزوّدين / بدون المزوّدين». Without (the default)
 * the archive holds no key, as before. With, it carries the profile's own providers and the
 * shared ones it uses — keys in the clear, in one file — and an import makes every one of
 * them the imported profile's own. Hermes never sees that file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { profileTransferPorts } from '../../src/modules/index.js';
import { registerProfileTransfer } from '../../src/modules/auth/index.js';
import { fakeProfileRuntime } from '../../src/modules/auth/testing/fake-profile-runtime.js';
import { modelsServiceFor } from '../../src/modules/models/index.js';
import { authed, drainJobs, signedInHub, type TestHub } from './helpers.js';

const SHARED_KEY = 'sk-ant-shared-key-0123456789';
const OWN_KEY = 'gsk-design-own-key-0123456789';
const scratch = mkdtempSync(path.join(tmpdir(), 'corehub-transfer-providers-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Hub = TestHub & { token: string; userId: string };
type Json = Record<string, unknown>;

let restore: ReturnType<typeof registerProfileTransfer> | undefined;
afterEach(() => {
  if (restore !== undefined) registerProfileTransfer(restore);
  restore = undefined;
});

function withFakeHermes() {
  const fake = fakeProfileRuntime(() => [
    { path: 'SOUL.md', content: `I design. Somebody pasted ${SHARED_KEY} here once.\n` },
  ]);
  restore = registerProfileTransfer((app) => profileTransferPorts(app, fake.runtime));
  return fake;
}

/** Anthropic and Groq list their models; nothing else answers. */
const providersFetch = ((url: string) => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  if (url.startsWith('https://api.anthropic.com/v1/models')) {
    return json({ data: [{ id: 'claude-sonnet-4-5' }], has_more: false });
  }
  if (url.startsWith('https://api.groq.com/openai/v1/models')) {
    return json({ data: [{ id: 'llama-3.3-70b-versatile' }] });
  }
  return json({ error: 'not part of this test' }, 503);
}) as unknown as typeof fetch;

async function call(
  hub: Hub,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  profile = 'default',
) {
  const res = await authed(hub, hub.token, {
    method,
    url,
    profile,
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

async function job(hub: Hub, id: string): Promise<Json> {
  await drainJobs(hub.app);
  return (await call(hub, 'GET', `/api/v1/jobs/${id}`)).body;
}

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
  return {
    entries,
    read: (entry) =>
      existsSync(path.join(dir, entry)) ? readFileSync(path.join(dir, entry), 'utf8') : '',
  };
}

/** The Design profile with its own Groq, on a hub with a shared Anthropic. */
async function designWithProviders(hub: Hub): Promise<string> {
  const made = await call(hub, 'POST', '/api/v1/profiles', { slug: 'design', name: 'Design' });
  expect(made.status).toBe(201);
  const shared = await call(hub, 'POST', '/api/v1/models/providers', {
    preset: 'anthropic',
    label: 'Anthropic',
    kind: 'llm',
    api_key: SHARED_KEY,
  });
  expect(shared.status).toBe(201);
  const own = await call(
    hub,
    'POST',
    '/api/v1/models/providers',
    { preset: 'groq', label: 'Groq', kind: 'llm', api_key: OWN_KEY, scope: 'profile' },
    'design',
  );
  expect(own.status).toBe(201);
  await drainJobs(hub.app);
  return made.body.id as string;
}

async function exportOf(hub: Hub, id: string, payload?: Json) {
  const started = await call(hub, 'POST', `/api/v1/profiles/${id}/export`, payload);
  expect(started.status).toBe(202);
  const done = await job(hub, started.body.job_id as string);
  expect(done.status).toBe('succeeded');
  const result = done.result as Json;
  const download = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/attachments/${String(result.attachment_id)}/content`,
  });
  expect(download.statusCode).toBe(200);
  return { result, bytes: download.rawPayload };
}

describe('profile export and providers (decision §37)', () => {
  it('carries no key and no providers file without being asked', async () => {
    withFakeHermes();
    const hub = await signedInHub({}, { models: { fetchImpl: providersFetch } });
    try {
      const id = await designWithProviders(hub);
      const { result, bytes } = await exportOf(hub, id);
      expect(result.providers).toBe(0);
      expect(bytes.includes(Buffer.from(SHARED_KEY))).toBe(false);
      expect(bytes.includes(Buffer.from(OWN_KEY))).toBe(false);
      expect(unpack(bytes).entries).toEqual(['design', 'design/SOUL.md']);
    } finally {
      await hub.close();
    }
  });

  it("with providers carries the profile's own and the shared ones it uses, keys and all", async () => {
    withFakeHermes();
    const hub = await signedInHub({}, { models: { fetchImpl: providersFetch } });
    try {
      const id = await designWithProviders(hub);
      const { result, bytes } = await exportOf(hub, id, { providers: true });
      expect(result.providers).toBe(2);
      const archive = unpack(bytes);
      expect(archive.entries).toEqual(['design', 'design/SOUL.md', 'design/corehub-providers.json']);
      // Every other file is still checked: the key pasted into SOUL.md is overwritten.
      expect(archive.read('design/SOUL.md')).not.toContain(SHARED_KEY);
      const bundle = JSON.parse(archive.read('design/corehub-providers.json')) as {
        format: string;
        providers: { slug: string; api_key: string; models: { model_key: string }[] }[];
      };
      expect(bundle.format).toBe('corehub-providers');
      expect(bundle.providers.map((p) => [p.slug, p.api_key])).toEqual([
        ['anthropic', SHARED_KEY],
        ['groq', OWN_KEY],
      ]);
      expect(bundle.providers[1]!.models.map((m) => m.model_key)).toEqual([
        'llama-3.3-70b-versatile',
      ]);
    } finally {
      await hub.close();
    }
  });

  it("an import makes the providers the archive carried the new profile's own", async () => {
    const fake = withFakeHermes();
    const hub = await signedInHub({}, { models: { fetchImpl: providersFetch } });
    try {
      const id = await designWithProviders(hub);
      const { bytes } = await exportOf(hub, id, { providers: true });

      const boundary = '----corehubProvidersBoundary';
      const form = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="design.tar.gz"\r\n` +
            'Content-Type: application/gzip\r\n\r\n',
        ),
        bytes,
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nimport\r\n--${boundary}--\r\n`,
        ),
      ]);
      const uploaded = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/attachments',
        payload: form,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const started = await call(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: (uploaded.json() as { id: string }).id,
        slug: 'restored',
      });
      expect(started.status).toBe(202);
      const done = await job(hub, started.body.job_id as string);
      expect(done).toMatchObject({
        status: 'succeeded',
        result: { slug: 'restored', providers: 2 },
      });

      // Hermes got the profile without the file, and without a key.
      const handed = fake.imported[0]!.bytes;
      expect(unpack(handed).entries).toEqual(['design', 'design/SOUL.md']);
      expect(handed.includes(Buffer.from(OWN_KEY))).toBe(false);

      // Both are the restored profile's own now, keys stored and never shown.
      const listed = await call(hub, 'GET', '/api/v1/models/providers', undefined, 'restored');
      const items = listed.body.items as { slug: string; scope: string; api_key: string }[];
      expect(items.map((p) => [p.slug, p.scope, p.api_key])).toEqual([
        ['anthropic', 'profile', '[stored]'],
        ['anthropic', 'all', '[stored]'],
        ['groq', 'profile', '[stored]'],
      ]);
      const restoredId = String((done.result as Json).profile_id);
      expect(
        modelsServiceFor(hub.app).environmentFor(restoredId, { groq: 'GROQ_API_KEY' }),
      ).toEqual({ GROQ_API_KEY: OWN_KEY });
    } finally {
      await hub.close();
    }
  });

  it('imports an archive exported before the rename, with majlis-providers.json (ADR 0017)', async () => {
    const fake = withFakeHermes();
    const hub = await signedInHub({}, { models: { fetchImpl: providersFetch } });
    try {
      const id = await designWithProviders(hub);
      const { bytes } = await exportOf(hub, id, { providers: true });
      // The same archive, as a Majlis hub wrote it: the old file name and the old format.
      const dir = mkdtempSync(path.join(scratch, 'old-'));
      writeFileSync(path.join(dir, 'new.tar.gz'), bytes);
      const tree = path.join(dir, 'tree');
      mkdirSync(tree);
      execFileSync('tar', ['-xzf', path.join(dir, 'new.tar.gz'), '-C', tree]);
      const bundle = JSON.parse(
        readFileSync(path.join(tree, 'design', 'corehub-providers.json'), 'utf8'),
      ) as Json;
      rmSync(path.join(tree, 'design', 'corehub-providers.json'));
      writeFileSync(
        path.join(tree, 'design', 'majlis-providers.json'),
        JSON.stringify({ ...bundle, format: 'majlis-providers' }),
      );
      execFileSync('tar', ['-czf', path.join(dir, 'old.tar.gz'), '-C', tree, 'design']);
      const old = readFileSync(path.join(dir, 'old.tar.gz'));

      const boundary = '----corehubLegacyProvidersBoundary';
      const form = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="design.tar.gz"\r\n` +
            'Content-Type: application/gzip\r\n\r\n',
        ),
        old,
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nimport\r\n--${boundary}--\r\n`,
        ),
      ]);
      const uploaded = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/attachments',
        payload: form,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const started = await call(hub, 'POST', '/api/v1/profile-imports', {
        attachment_id: (uploaded.json() as { id: string }).id,
        slug: 'older',
      });
      expect(started.status).toBe(202);
      const done = await job(hub, started.body.job_id as string);
      expect(done).toMatchObject({ status: 'succeeded', result: { slug: 'older', providers: 2 } });
      // Hermes still never sees the file, whichever name it has.
      expect(unpack(fake.imported[0]!.bytes).entries).toEqual(['design', 'design/SOUL.md']);
    } finally {
      await hub.close();
    }
  });
});
