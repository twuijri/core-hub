/**
 * The ChatGPT subscription's model list and images (decisions §83, §84) with **the real Hermes**
 * from the image — its own credential store, resolver and Codex identity headers — against a
 * scripted Codex backend on this machine (`HERMES_CODEX_BASE_URL`, Hermes's own switch). No real
 * account: the stored sign-in is a fake token that does not expire, so Hermes never calls OpenAI
 * to refresh it.
 *
 * 1. The hub's live-list program, run by the image's Python in a Hermes home that holds the
 *    sign-in, lists what the backend offers that account.
 * 2. `image_api.py generate` with `COREHUB_IMAGE_PROVIDER=codex` draws a PNG through the
 *    backend's `image_generation` tool, with the token Hermes hands it.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/models/codex-subscription.real.test.ts
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_CLIENT_VERSION, LIVE_MODELS_PROGRAM } from './live-models.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const PYTHON = '/opt/hermes/.venv/bin/python';
const SCRIPTS = fileURLToPath(
  new URL('../../../skill-library/image-generate/scripts/', import.meta.url),
);
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
// Valid for ten years: Hermes refreshes only a token about to expire.
const TOKEN = `${part({ alg: 'none' })}.${part({
  exp: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-real-test' },
})}.sig`;

describe.skipIf(!image)(
  'the ChatGPT subscription with the real Hermes (set COREHUB_HERMES_IMAGE)',
  () => {
    const { uid, gid } = userInfo();
    let server: Server;
    let port = 0;
    let home = '';
    const seen: { url: string; headers: Record<string, unknown>; body: string }[] = [];

    beforeAll(async () => {
      home = mkdtempSync(path.join(tmpdir(), 'corehub-codex-real-'));
      chmodSync(home, 0o777);
      writeFileSync(
        path.join(home, 'auth.json'),
        JSON.stringify({
          version: 1,
          providers: {
            'openai-codex': {
              tokens: { access_token: TOKEN, refresh_token: 'fake-refresh-token', id_token: '' },
              last_refresh: '2026-09-26T00:00:00Z',
              auth_mode: 'chatgpt',
            },
          },
        }),
      );
      server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
          seen.push({ url: request.url ?? '', headers: request.headers, body });
          const ok = request.headers.authorization === `Bearer ${TOKEN}`;
          if (!ok) {
            response.statusCode = 401;
            response.end('{}');
            return;
          }
          if (request.url?.startsWith('/codex/models')) {
            response.setHeader('content-type', 'application/json');
            response.end(
              JSON.stringify({
                models: [
                  { slug: 'gpt-6-sol', priority: 1 },
                  { slug: 'gpt-5.5', priority: 2 },
                  { slug: 'internal-review', priority: 0, visibility: 'hide' },
                ],
              }),
            );
            return;
          }
          if (request.url === '/codex/responses') {
            response.setHeader('content-type', 'text/event-stream');
            const done = {
              type: 'response.output_item.done',
              item: { type: 'image_generation_call', status: 'completed', result: PNG },
            };
            response.end(`event: ${done.type}\ndata: ${JSON.stringify(done)}\n\n`);
            return;
          }
          response.statusCode = 404;
          response.end('{}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    });

    const docker = (args: string[], env: Record<string, string>) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const envArgs = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
        execFile(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'host',
            '--user',
            `${uid}:${gid}`,
            '-v',
            `${home}:/h`,
            '-v',
            `${SCRIPTS}:/scripts:ro`,
            '-e',
            'HERMES_HOME=/h',
            '-e',
            'HOME=/h',
            '-e',
            `HERMES_CODEX_BASE_URL=http://127.0.0.1:${String(port)}/codex`,
            ...envArgs,
            '--entrypoint',
            PYTHON,
            image!,
            ...args,
          ],
          { timeout: 120_000 },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number((error as { code?: number }).code ?? 1) : 0,
              stdout,
              stderr,
            }),
        );
      });

    it("lists the account's models with Hermes's own resolver and identity headers", async () => {
      const run = await docker(
        ['-c', LIVE_MODELS_PROGRAM, 'openai-codex', CODEX_CLIENT_VERSION],
        {},
      );
      const line = run.stdout.trim().split('\n').pop() ?? '';
      expect(JSON.parse(line), run.stderr).toEqual({
        ok: true,
        models: [
          { id: 'gpt-6-sol', label: 'gpt-6-sol' },
          { id: 'gpt-5.5', label: 'gpt-5.5' },
        ],
      });
      const asked = seen.find((entry) => entry.url.startsWith('/codex/models'));
      expect(asked?.url).toBe(`/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
      expect(asked?.headers['chatgpt-account-id']).toBe('acct-real-test');
      // Hermes's identity for a non-official Codex address.
      expect(asked?.headers.originator).toBeTruthy();
      expect(run.stdout).not.toContain(TOKEN);
    }, 180_000);

    it('draws a PNG through the image_generation tool with the token Hermes hands the script', async () => {
      mkdirSync(path.join(home, 'out'), { recursive: true });
      chmodSync(path.join(home, 'out'), 0o777);
      const run = await docker(
        ['/scripts/image_api.py', 'generate', '--prompt', 'a red fox', '--out', '/h/out'],
        {
          COREHUB_IMAGE_PROVIDER: 'codex',
          COREHUB_IMAGE_BASE_URL: `http://127.0.0.1:${String(port)}/codex`,
          COREHUB_IMAGE_MODEL: 'gpt-image-2',
        },
      );
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        ok: true,
        provider: 'codex',
        model: 'gpt-image-2',
      });
      const files = readdirSync(path.join(home, 'out'));
      expect(files).toHaveLength(1);
      expect(
        readFileSync(path.join(home, 'out', files[0]!))
          .subarray(1, 4)
          .toString(),
      ).toBe('PNG');
      const call = seen.find((entry) => entry.url === '/codex/responses');
      expect(JSON.parse(call!.body)).toMatchObject({
        tools: [{ type: 'image_generation', model: 'gpt-image-2' }],
      });
      expect(call?.headers['chatgpt-account-id']).toBe('acct-real-test');
      expect(run.stdout + run.stderr).not.toContain(TOKEN);
    }, 180_000);
  },
);
