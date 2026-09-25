/**
 * `sessions.listChanges`, `sessions.getRunChanges` and `sessions.getRunChangeDiff` over the
 * real routes and the real run engine (decision §49): a run edits two files and creates one,
 * and the hub answers which, with their counts and diffs, in the contract shape — in a plain
 * folder and in a git repository. A run that changed nothing is not listed; another profile
 * sees nothing.
 */
import { execFileSync } from 'node:child_process';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
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

/** The agent's work, done when the turn is accepted: edit two files, create one. */
let work: ((dir: string) => void) | null = null;

async function hub(): Promise<TestHub> {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      onStart(request) {
        if (request.workingDir && work) work(request.workingDir);
      },
      script: [
        {
          type: 'tool_started',
          ref: 't1',
          name: 'write_file',
          kind: 'file_write',
          input: { path: 'notes.md' },
        },
        { type: 'tool_completed', ref: 't1', output: 'ok' },
        { type: 'message_delta', text: 'عدّلت الملفات' },
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

async function session(h: TestHub): Promise<{ id: string; dir: string }> {
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: { 'x-hub-profile': 'default' },
    payload: { agent_id: AGENT_ID },
  });
  const body = created.json() as { id: string; working_dir: string };
  return { id: body.id, dir: body.working_dir };
}

async function run(h: TestHub, id: string): Promise<string> {
  const accepted = await h.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${id}/runs`,
    headers: { 'x-hub-profile': 'default' },
    payload: { content: [{ type: 'text', text: 'عدّل الملفات' }] },
  });
  const runId = (accepted.json() as { run_id: string }).run_id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // `finished_at` is written with the run's end, after its changes are recorded.
    const state = (await get(h.app, `/sessions/${id}/runs/${runId}`)).json() as {
      finished_at: string | null;
    };
    if (state.finished_at) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return runId;
}

function seed(dir: string): void {
  writeFileSync(path.join(dir, 'notes.md'), '# ملاحظات\nأولى\n');
  writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 2;\n');
  const past = new Date(Date.now() - 60_000);
  for (const file of ['notes.md', 'app.js']) utimesSync(path.join(dir, file), past, past);
}

const edit = (dir: string) => {
  writeFileSync(path.join(dir, 'notes.md'), '# ملاحظات\nأولى\nثانية\n');
  writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 3;\n');
  writeFileSync(path.join(dir, 'report.html'), '<h1>تقرير</h1>\n<p>جديد</p>\n');
};

describe('the files a run changed', () => {
  it('lists them with their counts, one run and one diff at a time, in the contract shape', async () => {
    const h = await hub();
    try {
      const { id, dir } = await session(h);
      seed(dir);
      work = edit;
      const runId = await run(h, id);

      const list = await get(h.app, `/sessions/${id}/changes`);
      expect(list.statusCode).toBe(200);
      const body = list.json() as {
        items: Array<{ run_id: string; files: Array<{ path: string }> }>;
        next_cursor: string | null;
      };
      expect(schemaErrors('RunChangesList', body)).toEqual([]);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        run_id: runId,
        source: 'snapshot',
        complete: true,
        files_changed: 3,
        additions: 4,
        deletions: 1,
        truncated: false,
      });
      expect(body.items[0]!.files).toEqual([
        {
          path: 'app.js',
          old_path: null,
          change: 'modified',
          additions: 1,
          deletions: 1,
          binary: false,
          diff: 'available',
        },
        {
          path: 'notes.md',
          old_path: null,
          change: 'modified',
          additions: 1,
          deletions: 0,
          binary: false,
          diff: 'available',
        },
        {
          path: 'report.html',
          old_path: null,
          change: 'added',
          additions: 2,
          deletions: 0,
          binary: false,
          diff: 'available',
        },
      ]);

      const one = await get(h.app, `/sessions/${id}/runs/${runId}/changes`);
      expect(one.statusCode).toBe(200);
      expect(schemaErrors('RunChanges', one.json())).toEqual([]);
      expect(one.json()).toEqual(body.items[0]);

      const diff = await get(
        h.app,
        `/sessions/${id}/runs/${runId}/changes/diff?path=${encodeURIComponent('app.js')}`,
      );
      expect(diff.statusCode).toBe(200);
      expect(schemaErrors('RunFileDiff', diff.json())).toEqual([]);
      expect(diff.json()).toMatchObject({
        run_id: runId,
        path: 'app.js',
        change: 'modified',
        truncated: false,
        text: '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n',
      });

      // The diff is what the run did, whatever the file became afterwards.
      writeFileSync(path.join(dir, 'app.js'), 'changed by hand\n');
      expect(
        (await get(h.app, `/sessions/${id}/runs/${runId}/changes/diff?path=app.js`)).json(),
      ).toMatchObject({ text: expect.stringContaining('+const b = 3;') });

      expect(
        (await get(h.app, `/sessions/${id}/runs/${runId}/changes/diff?path=nope.txt`)).statusCode,
      ).toBe(404);
      expect((await get(h.app, `/sessions/${id}/runs/${runId}/changes/diff`)).statusCode).toBe(400);
      // Another profile sees neither the list nor the diff.
      expect((await get(h.app, `/sessions/${id}/changes`, 'other')).statusCode).toBeOneOf([
        403, 404,
      ]);
      expect(
        (await get(h.app, `/sessions/${id}/runs/${runId}/changes/diff?path=app.js`, 'other'))
          .statusCode,
      ).toBeOneOf([403, 404]);
    } finally {
      work = null;
      await h.close();
    }
  });

  it('records from git when the folder is a repository, and skips a run that changed nothing', async () => {
    const h = await hub();
    try {
      const { id, dir } = await session(h);
      seed(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'start'],
        { cwd: dir },
      );
      work = edit;
      const first = await run(h, id);
      work = null;
      const second = await run(h, id);

      const body = (await get(h.app, `/sessions/${id}/changes`)).json() as {
        items: Array<{ run_id: string; source: string; files_changed: number }>;
      };
      expect(body.items.map((item) => item.run_id)).toEqual([first]);
      expect(body.items[0]).toMatchObject({ source: 'git', files_changed: 3, additions: 4 });
      const diff = await get(h.app, `/sessions/${id}/runs/${first}/changes/diff?path=notes.md`);
      expect(diff.json()).toMatchObject({
        text: '@@ -1,2 +1,3 @@\n # ملاحظات\n أولى\n+ثانية\n',
      });
      // Recorded, with nothing changed: an empty answer, not a missing one.
      const quiet = await get(h.app, `/sessions/${id}/runs/${second}/changes`);
      expect(quiet.statusCode).toBe(200);
      expect(quiet.json()).toMatchObject({ files_changed: 0, files: [] });
    } finally {
      work = null;
      await h.close();
    }
  });

  it('answers 404 for a run that recorded nothing and a conversation that does not exist', async () => {
    const h = await hub();
    try {
      const { id } = await session(h);
      expect((await get(h.app, `/sessions/${id}/changes`)).json()).toEqual({
        items: [],
        next_cursor: null,
      });
      expect(
        (await get(h.app, `/sessions/${id}/runs/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/changes`)).statusCode,
      ).toBe(404);
      expect((await get(h.app, '/sessions/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/changes')).statusCode).toBe(
        404,
      );
    } finally {
      await h.close();
    }
  });
});
