/**
 * The three agent tools through the hub's own routes: importing a pack someone uploaded,
 * testing an MCP server, pairing WhatsApp — each in the profile the request names, with a
 * scripted Hermes API in place of `hermes serve` (the real one is `agent-tools.real.test.ts`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { auditFor, serializeJob } from '../audit/index.js';
import type { HermesApiCall } from './hermes-tools.js';
import { makeZip } from './testing/make-zip.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(hermesApi?: HermesApiCall): Promise<{ hub: Hub; agent: string; root: string }> {
  hub = await signedInHub(
    {},
    {
      agents: {
        adapterOptions: { hermes: { fetchImpl: healthy } },
        ...(hermesApi ? { hermesApi, pairingPollMs: 5 } : {}),
      },
    },
  );
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  return { hub, agent, root: path.join(hub.dataDir, 'hermes') };
}

function multipart(name: string, type: string, body: Buffer) {
  const boundary = '----majlisSkillBoundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      body,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nskill\r\n--${boundary}--\r\n`,
      ),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(h: Hub, name: string, body: Buffer, profile = 'default'): Promise<string> {
  const form = multipart(name, name.endsWith('.zip') ? 'application/zip' : 'text/markdown', body);
  const res = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/attachments',
    payload: form.payload,
    headers: form.headers,
    profile,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

const SKILL = [
  '---',
  'name: pdf-notes',
  'description: Summarise a PDF into notes with page references.',
  'license: Apache-2.0',
  'metadata:',
  '  hermes:',
  '    tags: [pdf]',
  '---',
  '',
  '# PDF notes',
  '',
  'Read it.',
  '',
].join('\n');

describe('importing a skill pack', () => {
  it('installs an uploaded SKILL.md verbatim and lists it', async () => {
    const { hub: h, agent, root } = await boot();
    const id = await upload(h, 'SKILL.md', Buffer.from(SKILL));
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { attachment_ids: [id] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { items: Array<{ key: string }> }).items.map((s) => s.key)).toEqual([
      'pdf-notes',
    ]);
    expect(readFileSync(path.join(root, 'skills', 'pdf-notes', 'SKILL.md'), 'utf8')).toBe(SKILL);

    const listed = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/skills`,
    });
    const keys = (
      listed.json() as { categories: Array<{ skills: Array<{ key: string }> }> }
    ).categories.flatMap((category) => category.skills.map((skill) => skill.key));
    expect(keys).toContain('pdf-notes');
  });

  it('installs every skill of a zip, and refuses the same pack again with the skill named', async () => {
    const { hub: h, agent, root } = await boot();
    const pack = makeZip([
      { path: 'pdf-notes/SKILL.md', data: SKILL },
      { path: 'pdf-notes/references/style.md', data: 'Keep headings.' },
      {
        path: 'csv-clean/SKILL.md',
        data: '---\nname: csv-clean\ndescription: Clean a CSV.\n---\n\nSteps.\n',
      },
    ]);
    const id = await upload(h, 'pack.zip', pack);
    const first = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { category: 'ignored', attachment_ids: [id] },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(
      readFileSync(path.join(root, 'skills', 'pdf-notes', 'references', 'style.md'), 'utf8'),
    ).toBe('Keep headings.');

    const again = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { attachment_ids: [id] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: 'conflict',
      details: { reason: 'skill_exists', skill: 'pdf-notes' },
    });
  });

  it('lets the web delete the pack once imported, and still refuses it uploaded again', async () => {
    const { hub: h, agent, root } = await boot();
    const pack = makeZip([{ path: 'pdf-notes/SKILL.md', data: SKILL }]);
    const id = await upload(h, 'pack.zip', pack);
    const first = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { attachment_ids: [id] },
    });
    expect(first.statusCode, first.body).toBe(201);
    // The web removes the uploaded pack after the import (useImportSkills).
    const removed = await authed(h, h.token, { method: 'DELETE', url: `/api/v1/attachments/${id}` });
    expect(removed.statusCode).toBe(204);
    // The installed skill does not depend on it.
    expect(readFileSync(path.join(root, 'skills', 'pdf-notes', 'SKILL.md'), 'utf8')).toBe(SKILL);

    // The very same pack uploads again (it used to 500) and is refused as a skill that exists.
    const again = await upload(h, 'pack.zip', pack);
    expect(again).not.toBe(id);
    const refused = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { attachment_ids: [again] },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'conflict',
      details: { reason: 'skill_exists', skill: 'pdf-notes' },
    });
  });

  it('refuses a broken pack with the reason and the file, and writes nothing', async () => {
    const { hub: h, agent, root } = await boot();
    const id = await upload(
      h,
      'broken.zip',
      makeZip([
        { path: 'good/SKILL.md', data: '---\nname: good\ndescription: Fine.\n---\n\nOk.\n' },
        { path: 'bad/SKILL.md', data: '# no front matter\n' },
      ]),
    );
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { attachment_ids: [id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'bad_request',
      details: { reason: 'skill_front_matter_missing', file: 'broken.zip: bad/SKILL.md' },
    });
    expect(() => readFileSync(path.join(root, 'skills', 'good', 'SKILL.md'))).toThrow();
  });

  it('says which attachment it could not find', async () => {
    const { hub: h, agent } = await boot();
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills`,
      payload: { attachment_ids: ['01J8QK3ZR2W7M5N4P6T8V9X0AX'] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('the tool pages act on the selected profile', () => {
  it("reads a named profile's own home, and says so when Hermes has no such profile", async () => {
    const { hub: h, agent, root } = await boot();
    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    expect(made.statusCode, made.body).toBe(201);

    const absent = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/mcp-servers`,
      profile: 'work',
    });
    expect(absent.statusCode).toBe(409);
    expect(absent.json()).toMatchObject({
      details: { reason: 'hermes_profile_absent', profile: 'work' },
    });

    mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true });
    writeFileSync(
      path.join(root, 'profiles', 'work', 'config.yaml'),
      'mcp_servers:\n  workonly:\n    command: node\n',
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'config.yaml'), 'mcp_servers:\n  rootonly:\n    command: node\n');

    const names = async (profile: string) =>
      (
        (
          await authed(h, h.token, {
            method: 'GET',
            url: `/api/v1/agents/${agent}/mcp-servers`,
            profile,
          })
        ).json() as { items: Array<{ name: string }> }
      ).items.map((item) => item.name);
    expect(await names('work')).toEqual(['workonly']);
    expect(await names('default')).toEqual(['rootonly']);
  });
});

describe('testing an MCP server', () => {
  it("asks Hermes in the request's profile and answers in the contract's shape", async () => {
    const calls: string[] = [];
    const api: HermesApiCall = async <T>(method: string, route: string): Promise<T> => {
      calls.push(`${method} ${route}`);
      return { ok: true, tools: [{ name: 'echo', description: 'Repeat.' }] } as T;
    };
    const { hub: h, agent, root } = await boot(api);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'config.yaml'), 'mcp_servers:\n  fixture:\n    command: node\n');

    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/fixture/test`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      tools: [{ name: 'echo', description: 'Repeat.' }],
      error: null,
    });
    expect(calls).toEqual(['POST /api/mcp/servers/fixture/test?profile=default']);

    const missing = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/nope/test`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('names the reason when this hub does not supervise Hermes', async () => {
    const { hub: h, agent, root } = await boot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'config.yaml'), 'mcp_servers:\n  fixture:\n    command: node\n');
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/fixture/test`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'hermes_not_supervised' },
    });
  });
});

describe('pairing a channel by QR', () => {
  it('runs a channel_login job whose progress carries the code, and ends connected', async () => {
    let polls = 0;
    const api: HermesApiCall = async <T>(method: string, route: string): Promise<T> => {
      if (route.endsWith('/onboarding/start')) {
        return { pairing_id: 'p1', status: 'starting', expires_at: '2099-01-01T00:00:00Z' } as T;
      }
      if (method === 'GET') {
        polls += 1;
        return (
          polls < 3
            ? {
                pairing_id: 'p1',
                status: 'waiting',
                qr_payload: 'QR-DATA',
                expires_at: '2099-01-01T00:00:00Z',
              }
            : { pairing_id: 'p1', status: 'connected', account_name: 'Office' }
        ) as T;
      }
      return { ok: true } as T;
    };
    const { hub: h, agent } = await boot(api);
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
    });
    expect(res.statusCode, res.body).toBe(202);
    const jobId = (res.json() as { job_id: string }).job_id;
    await drainJobs(h.app);

    const row = auditFor(h.app).job(jobId)!;
    expect(serializeJob(row, 'default')).toMatchObject({
      kind: 'channel_login',
      status: 'succeeded',
      result: { status: 'connected', account_name: 'Office' },
    });
  });

  it('refuses a platform that does not pair by QR, and a hub with no Hermes to ask', async () => {
    const { hub: h, agent } = await boot();
    const telegram = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/telegram/login`,
    });
    expect(telegram.json()).toMatchObject({ details: { reason: 'login_not_supported' } });
    const whatsapp = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/channels/whatsapp/login`,
    });
    expect(whatsapp.statusCode).toBe(409);
    expect(whatsapp.json()).toMatchObject({ details: { reason: 'hermes_not_supervised' } });
  });
});

describe("Hermes's own skills, in their category folders", () => {
  it('lists them under their category with its description, built-in and read-only', async () => {
    const { hub: h, agent, root } = await boot();
    const seed = (rel: string, name: string) => {
      mkdirSync(path.join(root, 'skills', rel), { recursive: true });
      writeFileSync(
        path.join(root, 'skills', rel, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n\nDo it.\n`,
      );
    };
    seed('apple/findmy', 'findmy');
    seed('research/lit-review', 'lit-review');
    seed('my-notes', 'my-notes');
    writeFileSync(path.join(root, 'skills', 'apple', 'DESCRIPTION.md'), 'Apple / macOS skills.\n');
    writeFileSync(path.join(root, 'skills', '.bundled_manifest'), 'findmy:0f1e\n');

    const listed = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/skills`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const categories = (
      listed.json() as {
        categories: Array<{
          key: string;
          description: string | null;
          skills: Array<{ key: string; source: string }>;
        }>;
      }
    ).categories.map((category) => [
      category.key,
      category.description,
      category.skills.map((skill) => `${skill.key}:${skill.source}`),
    ]);
    expect(categories).toEqual([
      ['user', null, ['my-notes:user']],
      ['apple', 'Apple / macOS skills.', ['findmy:builtin']],
      ['research', null, ['lit-review:user']],
    ]);

    const read = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/skills/findmy`,
    });
    expect(read.json()).toMatchObject({ key: 'findmy', source: 'builtin' });
    expect((read.json() as { content: string }).content).toContain('name: findmy');

    for (const request of [
      { method: 'PATCH' as const, payload: { enabled: false } },
      { method: 'PUT' as const, payload: { content: '---\nname: findmy\n---\nmine\n' } },
      { method: 'DELETE' as const },
    ]) {
      const res = await authed(h, h.token, {
        ...request,
        url: `/api/v1/agents/${agent}/skills/findmy`,
      });
      expect(res.statusCode, `${request.method} ${res.body}`).toBe(409);
      expect(res.json()).toMatchObject({ code: 'conflict', details: { reason: 'skill_bundled' } });
    }
    // Pinning is the hub's own order, not Hermes's file: it works for every skill.
    const pinned = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/skills/findmy`,
      payload: { pinned: true },
    });
    expect(pinned.json()).toMatchObject({ key: 'findmy', pinned: true });
  });
});
