/**
 * `sessions.listFiles` and `sessions.readFile` over the real routes (decision §47): a run
 * whose tool call wrote a file lists it with the call, in the contract shape; the bytes come
 * back with the type chosen from the name, never sniffed, sandboxed; a path out of the folder,
 * through a link, or over its kind's preview limit is refused; another profile sees nothing.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { PREVIEW_MAX_BYTES } from './files.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function schemaErrors(name: string, data: unknown): string[] {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document?.components ?? {},
  });
  return validate(data)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

async function hub(): Promise<TestHub> {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      script: [
        {
          type: 'tool_started',
          ref: 't1',
          name: 'write_file',
          kind: 'file_write',
          input: { path: 'report.html', content: '<h1>تقرير</h1>' },
        },
        { type: 'tool_completed', ref: 't1', output: 'wrote report.html' },
        { type: 'message_delta', text: 'كتبت التقرير في report.html' },
        { type: 'completed' },
      ],
    }),
  });
  return testHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
}

async function get(app: FastifyInstance, url: string, profile = 'default') {
  return app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-hub-profile': profile } });
}

async function sessionWithRun(h: TestHub): Promise<{ id: string; dir: string }> {
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: { 'x-hub-profile': 'default' },
    payload: { agent_id: AGENT_ID },
  });
  const session = created.json() as { id: string; working_dir: string };
  // What the agent's tool wrote, and what else is in its folder.
  writeFileSync(path.join(session.working_dir, 'report.html'), '<h1>تقرير</h1>');
  writeFileSync(path.join(session.working_dir, 'data.csv'), 'name,count\nأ,1\n');
  writeFileSync(path.join(session.working_dir, 'notes.md'), '# ملاحظات\n');
  writeFileSync(path.join(session.working_dir, 'app.js'), 'alert(1)');
  await h.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${session.id}/runs`,
    headers: { 'x-hub-profile': 'default' },
    payload: { content: [{ type: 'text', text: 'اكتب التقرير' }] },
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = (await get(h.app, `/sessions/${session.id}`)).json() as {
      active_run?: unknown;
    };
    if (!run.active_run) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { id: session.id, dir: session.working_dir };
}

describe('sessions.listFiles', () => {
  it('lists the tool call file with its call, the folder, in the contract shape', async () => {
    const h = await hub();
    try {
      const { id } = await sessionWithRun(h);
      let body = (await get(h.app, `/sessions/${id}/files`)).json() as {
        items: Array<{ key: string; sources: string[]; tool_call_ids: string[]; preview: string }>;
      };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (body.items.find((f) => f.key === 'path:report.html')?.tool_call_ids.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
        body = (await get(h.app, `/sessions/${id}/files`)).json();
      }
      expect(schemaErrors('SessionFileList', body)).toEqual([]);
      const byKey = new Map(body.items.map((f) => [f.key, f]));
      expect(byKey.get('path:report.html')).toMatchObject({
        sources: ['tool', 'working_dir'],
        preview: 'html',
      });
      expect(byKey.get('path:report.html')?.tool_call_ids).toHaveLength(1);
      expect(byKey.get('path:data.csv')).toMatchObject({ sources: ['working_dir'], preview: 'csv' });
      expect(byKey.get('path:notes.md')?.preview).toBe('markdown');

      // Another profile does not see this conversation, nor its files.
      expect([403, 404]).toContain((await get(h.app, `/sessions/${id}/files`, 'other')).statusCode);
      expect(
        (await get(h.app, `/sessions/${id}/files/content?path=report.html`, 'other')).statusCode,
      ).toBeOneOf([403, 404]);
    } finally {
      await h.close();
    }
  });

  it('answers 404 for a conversation that does not exist', async () => {
    const h = await hub();
    try {
      const res = await get(h.app, '/sessions/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/files');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    } finally {
      await h.close();
    }
  });
});

describe('sessions.readFile', () => {
  it('sends the bytes with the type from the name, sandboxed and not sniffed', async () => {
    const h = await hub();
    try {
      const { id } = await sessionWithRun(h);
      const html = await get(h.app, `/sessions/${id}/files/content?path=report.html`);
      expect(html.statusCode).toBe(200);
      expect(html.body).toBe('<h1>تقرير</h1>');
      expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(html.headers['x-content-type-options']).toBe('nosniff');
      expect(html.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(html.headers['cache-control']).toBe('no-store');
      expect(html.headers['content-disposition']).toMatch(/^inline; filename="report.html"/);

      expect((await get(h.app, `/sessions/${id}/files/content?path=data.csv`)).headers[
        'content-type'
      ]).toBe('text/csv; charset=utf-8');
      expect((await get(h.app, `/sessions/${id}/files/content?path=notes.md`)).headers[
        'content-type'
      ]).toBe('text/markdown; charset=utf-8');
      // Code is never sent as something a browser would run.
      expect((await get(h.app, `/sessions/${id}/files/content?path=app.js`)).headers[
        'content-type'
      ]).toBe('text/plain; charset=utf-8');

      const saved = await get(h.app, `/sessions/${id}/files/content?path=report.html&download=true`);
      expect(saved.headers['content-disposition']).toMatch(/^attachment; filename="report.html"/);
    } finally {
      await h.close();
    }
  });

  it('refuses traversal, links and folders, and a file over its preview limit', async () => {
    const h = await hub();
    try {
      const { id, dir } = await sessionWithRun(h);
      const secret = path.join(h.dataDir, 'secret.txt');
      writeFileSync(secret, 'do not read');
      symlinkSync(secret, path.join(dir, 'link.txt'));
      mkdirSync(path.join(dir, 'sub'));
      writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(PREVIEW_MAX_BYTES.markdown + 1));

      const reasonOf = async (query: string) => {
        const res = await get(h.app, `/sessions/${id}/files/content?${query}`);
        return [res.statusCode, (res.json() as { details?: { reason?: string } }).details?.reason];
      };
      expect(await reasonOf('path=..%2F..%2Fsecret.txt')).toEqual([400, 'outside_root']);
      expect(await reasonOf(`path=${encodeURIComponent(secret)}`)).toEqual([400, 'outside_root']);
      expect(await reasonOf('path=link.txt')).toEqual([400, 'symlink']);
      expect(await reasonOf('path=sub')).toEqual([400, 'not_a_file']);
      expect((await get(h.app, `/sessions/${id}/files/content?path=nope.md`)).statusCode).toBe(404);
      expect((await get(h.app, `/sessions/${id}/files/content`)).statusCode).toBe(400);

      const big = await get(h.app, `/sessions/${id}/files/content?path=big.md`);
      expect(big.statusCode).toBe(413);
      expect(big.json()).toMatchObject({
        code: 'payload_too_large',
        details: { max_bytes: PREVIEW_MAX_BYTES.markdown },
      });
      // Saving it is not a preview: the download limit applies.
      expect(
        (await get(h.app, `/sessions/${id}/files/content?path=big.md&download=true`)).statusCode,
      ).toBe(200);
    } finally {
      await h.close();
    }
  });
});
