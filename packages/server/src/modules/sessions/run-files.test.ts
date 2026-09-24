/**
 * Files, end to end through the hub: what a person attaches reaches the agent's disk,
 * and what the agent leaves behind reaches the person's reply.
 *
 * The agent is the scripted runner (`testing/fake-runner.ts`) with an `onStart` that
 * does what a real one does — read the input folder, write into the output folder —
 * so every layer below it is the real one: the multipart route, the blob store, the
 * run engine, the mappers and the contract's own schemas.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { modules as defaultModules } from '../index.js';
import { attachmentsPort, knowledgeModule } from '../knowledge/index.js';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule, type AgentRunRequest } from './index.js';
import { collectOutputs, runFolders, OutputWatcher } from './run-files.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';
import { principalScopeResolver } from '../auth/index.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function expectMatchesSchema(name: string, data: unknown): void {
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

/**
 * A signed-in hub whose `sessions` module runs the scripted agent, with the real
 * `knowledge` attachment port behind it.
 */
async function hubWithAgent(onStart?: (request: AgentRunRequest) => void | Promise<void>) {
  const runner = new FakeAgentRunner({
    script: [{ type: 'message_delta', text: 'تفضل.' }, { type: 'completed' }],
    ...(onStart ? { onStart } : {}),
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner,
    attachments: attachmentsPort,
    scopes: principalScopeResolver,
  });
  const hub = await signedInHub(
    {},
    {
      modules: defaultModules.map((m) =>
        m.name === 'sessions' ? sessions : m.name === 'knowledge' ? knowledgeModule : m,
      ),
    },
  );
  return { hub, runner };
}

const TEXT = Buffer.from('رقم الطلب: 4417\n');

function multipart(name: string, body: Buffer, type: string) {
  const boundary = '----corehubRunFiles';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(hub: TestHub & { token: string }, name: string, body: Buffer, type: string) {
  const form = multipart(name, body, type);
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/attachments',
    payload: form.payload,
    headers: form.headers,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string };
}

async function newSession(hub: TestHub & { token: string }): Promise<string> {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: AGENT_ID, title: 'ملفات' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

/**
 * Send one message and wait for the turn to be completely written.
 *
 * The run's **job** is what says "done": the engine closes it last, after the final
 * message and its attachments are in the database, so a job in a terminal state is the
 * only signal that makes reading the transcript race-free.
 */
async function send(
  hub: TestHub & { token: string },
  sessionId: string,
  content: unknown[],
): Promise<{ runId: string }> {
  const accepted = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/runs`,
    payload: { content },
  });
  expect(accepted.statusCode).toBe(202);
  const { job_id: jobId, run_id: runId } = accepted.json() as {
    job_id: string;
    run_id: string;
  };
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const res = await authed(hub, hub.token, { method: 'GET', url: `/api/v1/jobs/${jobId}` });
    const status = (res.json() as { status: string }).status;
    if (['succeeded', 'failed', 'cancelled'].includes(status)) return { runId };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run never finished');
}

describe('a run: the files the person attached', () => {
  it('lands them in the run folder and names the paths in the prompt', async () => {
    let seen: AgentRunRequest | undefined;
    const { hub, runner } = await hubWithAgent((request) => {
      seen = request;
    });
    try {
      const file = await upload(hub, 'order.txt', TEXT, 'text/plain');
      const sessionId = await newSession(hub);
      const { runId } = await send(hub, sessionId, [
        { type: 'text', text: 'اقرأ الملف' },
        { type: 'file', attachment_id: file.id },
      ]);

      expect(runner.started).toHaveLength(1);
      expect(seen).toBeDefined();
      // The session's own working directory, one folder per run.
      const detail = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}`,
      });
      const workingDir = (detail.json() as { working_dir: string }).working_dir;
      const folders = runFolders(workingDir, runId);
      expect(seen!.files).toEqual({ inputDir: folders.in, outputDir: folders.out });

      // The bytes really are on disk, under the sanitised name.
      const landed = path.join(folders.in, 'order.txt');
      expect(existsSync(landed)).toBe(true);
      expect(readFileSync(landed)).toEqual(TEXT);

      // And the prompt block carries the path, not only the id.
      expect(seen!.prompt).toEqual([
        { type: 'text', text: 'اقرأ الملف' },
        {
          type: 'attachment',
          attachmentId: file.id,
          kind: 'file',
          name: 'order.txt',
          mime: 'text/plain; charset=utf-8',
          sizeBytes: TEXT.length,
          path: landed,
        },
      ]);
    } finally {
      await hub.close();
    }
  });

  it('refuses a run whose attachment does not exist, before the message is written', async () => {
    const { hub } = await hubWithAgent();
    try {
      const sessionId = await newSession(hub);
      const res = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/sessions/${sessionId}/runs`,
        payload: {
          content: [{ type: 'file', attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0AT' }],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });

      const messages = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/messages`,
      });
      expect((messages.json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('will not delete an attachment a message points at', async () => {
    const { hub } = await hubWithAgent();
    try {
      const file = await upload(hub, 'order.txt', TEXT, 'text/plain');
      const sessionId = await newSession(hub);
      await send(hub, sessionId, [{ type: 'file', attachment_id: file.id }]);
      const res = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/attachments/${file.id}`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'conflict' });
    } finally {
      await hub.close();
    }
  });
});

describe('a run: the files the agent produced', () => {
  it('attaches them to the reply, downloadable by the URL the contract declares', async () => {
    const { hub } = await hubWithAgent((request) => {
      // What an agent does: write into the folder it was told about.
      const out = request.files!.outputDir;
      writeFileSync(path.join(out, 'summary.md'), '# الخلاصة\n');
      mkdirSync(path.join(out, 'charts'), { recursive: true });
      writeFileSync(
        path.join(out, 'charts', 'trend.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]),
      );
    });
    try {
      const sessionId = await newSession(hub);
      await send(hub, sessionId, [{ type: 'text', text: 'اكتب ملخصًا' }]);

      const messages = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/messages`,
      });
      const items = (messages.json() as { items: Array<Record<string, unknown>> }).items;
      const reply = items.at(-1)!;
      expectMatchesSchema('Message', reply);
      expect(reply.role).toBe('assistant');

      const blocks = reply.content as Array<Record<string, unknown>>;
      expect(blocks[0]).toEqual({ type: 'text', text: 'تفضل.' });
      const files = blocks.slice(1);
      expect(files.map((b) => b.name).sort()).toEqual(['summary.md', 'trend.png']);
      expect(files.find((b) => b.name === 'trend.png')).toMatchObject({ type: 'image' });
      expect(files.find((b) => b.name === 'summary.md')).toMatchObject({
        type: 'file',
        mime: 'text/markdown; charset=utf-8',
      });

      // The download URL on the block is the one that actually serves the bytes.
      const summary = files.find((b) => b.name === 'summary.md')!;
      expect(summary.url).toBe(`/api/v1/attachments/${summary.attachment_id as string}/content`);
      const bytes = await authed(hub, hub.token, {
        method: 'GET',
        url: summary.url as string,
      });
      expect(bytes.statusCode).toBe(200);
      expect(bytes.rawPayload.toString('utf8')).toBe('# الخلاصة\n');
    } finally {
      await hub.close();
    }
  });

  it('attaches nothing when the agent wrote nothing', async () => {
    const { hub } = await hubWithAgent();
    try {
      const sessionId = await newSession(hub);
      await send(hub, sessionId, [{ type: 'text', text: 'مرحبا' }]);
      const messages = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${sessionId}/messages`,
      });
      const items = (messages.json() as { items: Array<Record<string, unknown>> }).items;
      expect(items.at(-1)!.content).toEqual([{ type: 'text', text: 'تفضل.' }]);
    } finally {
      await hub.close();
    }
  });
});

describe('the output folder is read once, and capped', () => {
  it('refuses what is over the caps and says which files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-out-'));
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(path.join(dir, name), 'x'.repeat(10));
    const capped = collectOutputs(dir, { maxFiles: 2 });
    expect(capped.files.map((f) => f.relativePath)).toEqual(['a.txt', 'b.txt']);
    expect(capped.refused).toEqual([{ relativePath: 'c.txt', reason: 'too_many', sizeBytes: 10 }]);

    const bySize = collectOutputs(dir, { maxFileBytes: 5 });
    expect(bySize.files).toEqual([]);
    expect(bySize.refused.map((r) => r.reason)).toEqual(['too_large', 'too_large', 'too_large']);

    const byTotal = collectOutputs(dir, { maxTotalBytes: 15 });
    expect(byTotal.files.map((f) => f.relativePath)).toEqual(['a.txt']);
    expect(byTotal.refused.map((r) => r.reason)).toEqual(['total_too_large', 'total_too_large']);

    mkdirSync(path.join(dir, 'deep'), { recursive: true });
    writeFileSync(path.join(dir, 'deep', 'x.txt'), 'y');
    const shallow = collectOutputs(dir, { maxDepth: 1 });
    expect(shallow.refused.some((r) => r.reason === 'too_deep')).toBe(true);
  });

  it('watches one folder and never walks a tree', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-watch-'));
    const watcher = new OutputWatcher(dir, { maxFiles: 1 }).start();
    writeFileSync(path.join(dir, 'one.txt'), '1');
    const collected = watcher.collect();
    expect(collected.files.map((f) => f.relativePath)).toEqual(['one.txt']);
    // Stopping twice is fine; the collection already stopped it.
    watcher.stop();
  });
});
