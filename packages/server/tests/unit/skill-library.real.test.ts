/**
 * Core Hub's skill library against **the real Hermes** from the image (decision §60):
 *
 * 1. The hub seeds the library into `default` and into a profile Hermes itself made (`hermes
 *    profile create`, which also seeds Hermes's own built-in skills); `hermes skills list` then
 *    lists every library skill in the `core-hub` category, beside Hermes's own.
 * 2. One image skill end to end, in a real Hermes turn: a scripted model loads `image-generate`
 *    with `skill_view` and runs its script with `terminal`, exactly as the skill tells it to; the
 *    script reaches a scripted OpenAI-style image endpoint with the key from the profile's `.env`
 *    (`COREHUB_IMAGE_API_KEY`, which Hermes passes to the terminal because the skill declares
 *    it), and the PNG lands in the working folder.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run tests/unit/skill-library.real.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeHermesRoute } from '../../src/modules/models/propagation.js';
import { seedSkillLibraryOfEveryProfile } from '../../src/modules/agents/index.js';
import { LIBRARY_CATEGORY, shippedLibrary } from '../../src/modules/agents/skill-library.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const PROVIDER = 'corehub-custom-scripted';
const KEY_ENV = 'COREHUB_CUSTOM_SCRIPTED_API_KEY';
const IMAGE_KEY = 'sk-image-real-test';
// A 1×1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = '';
    request.on('data', (chunk) => (raw += String(chunk)));
    request.on('end', () => resolve(raw));
  });

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

describe.skipIf(!image)(
  'the Core Hub skill library in real Hermes (set COREHUB_HERMES_IMAGE)',
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-library-real-'));
    const root = path.join(dataDir, 'hermes');
    const work = path.join(dataDir, 'work');
    const { uid, gid } = userInfo();
    let model: Server;
    let images: Server;
    const imageCalls: Array<{ url: string; authorization: string | undefined; body: string }> = [];
    const offered: string[][] = [];
    const toolResults: string[] = [];

    const dockerArgs = (args: string[], cwd: string, name?: string) => [
      'run',
      '--rm',
      ...(name ? ['--name', name] : []),
      '--network',
      'host',
      '--user',
      `${uid}:${gid}`,
      '-v',
      `${dataDir}:${dataDir}`,
      '-w',
      cwd,
      '-e',
      'HOME=/tmp',
      '-e',
      `HERMES_HOME=${root}`,
      '-e',
      'COLUMNS=200',
      '-e',
      'NO_COLOR=1',
      '--entrypoint',
      HERMES,
      image!,
      ...args,
    ];

    /**
     * A Hermes turn, asynchronously: the scripted model and image endpoint answer from this very
     * process, so blocking it (execFileSync) would leave Hermes waiting on a server that cannot run.
     */
    const hermesTurn = (args: string[], cwd: string) =>
      new Promise<string>((resolve, reject) => {
        const name = `corehub-library-real-${process.pid}`;
        const child = spawn('docker', dockerArgs(args, cwd, name), {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
        const timer = setTimeout(() => {
          execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
          reject(new Error(`hermes timed out:\n${out}`));
        }, 240_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`hermes exited ${code}:\n${out}`));
        });
      });

    const hermes = (args: string[], cwd = root) =>
      execFileSync('docker', dockerArgs(args, cwd), {
        encoding: 'utf8',
        timeout: 240_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    beforeAll(async () => {
      mkdirSync(root, { recursive: true });
      mkdirSync(work, { recursive: true });
      chmodSync(dataDir, 0o777);
      chmodSync(root, 0o777);
      chmodSync(work, 0o777);

      // The image endpoint the skill's script will call: OpenAI's Images API, scripted.
      images = createServer((request, response) => {
        void readBody(request).then((body) => {
          imageCalls.push({
            url: request.url ?? '',
            authorization: request.headers.authorization,
            body,
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
        });
      });
      await new Promise<void>((resolve) => images.listen(0, '127.0.0.1', resolve));
      const imagesPort = (images.address() as { port: number }).port;

      // The model, scripted: load the skill, run its script as the skill says, then answer.
      model = createServer((request, response) => {
        void readBody(request).then((raw) => {
          if (request.url?.endsWith('/models')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: [{ id: 'scripted-model', object: 'model' }] }));
            return;
          }
          const body = JSON.parse(raw || '{}') as {
            stream?: boolean;
            messages?: ChatMessage[];
            tools?: Array<{ function?: { name?: string } }>;
          };
          offered.push((body.tools ?? []).map((tool) => tool.function?.name ?? ''));
          const messages = body.messages ?? [];
          const lastTool = [...messages].reverse().find((message) => message.role === 'tool');
          const text = (value: unknown) =>
            typeof value === 'string' ? value : JSON.stringify(value ?? '');
          let call: { name: string; arguments: Record<string, unknown> } | null = null;
          let answer = '';
          const calls = messages.filter((message) => message.role === 'tool').length;
          if (calls === 0) {
            call = { name: 'skill_view', arguments: { name: 'image-generate' } };
          } else if (calls === 1) {
            toolResults.push(text(lastTool?.content));
            const dir = /"skill_dir":\s*"([^"]+)"/.exec(text(lastTool?.content))?.[1] ?? '';
            call = {
              name: 'terminal',
              arguments: {
                command: `python3 ${dir}/scripts/image_api.py generate --prompt "a red fox in flat style" --out images`,
              },
            };
          } else {
            toolResults.push(text(lastTool?.content));
            answer = `Done: ${text(lastTool?.content).slice(0, 200)}`;
          }
          const id = `chatcmpl-${offered.length}`;
          const toolCalls = call
            ? [
                {
                  id: `call_${offered.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                },
              ]
            : undefined;
          if (body.stream) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            const chunk = (delta: Record<string, unknown>, finish: string | null) =>
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created: 0,
                model: 'scripted-model',
                choices: [{ index: 0, delta, finish_reason: finish }],
              })}\n\n`;
            if (toolCalls) {
              response.write(
                chunk(
                  {
                    role: 'assistant',
                    content: null,
                    tool_calls: toolCalls.map((entry, index) => ({ index, ...entry })),
                  },
                  null,
                ),
              );
              response.write(chunk({}, 'tool_calls'));
            } else {
              response.write(chunk({ role: 'assistant', content: answer }, null));
              response.write(chunk({}, 'stop'));
            }
            response.end('data: [DONE]\n\n');
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created: 0,
              model: 'scripted-model',
              choices: [
                {
                  index: 0,
                  message: toolCalls
                    ? { role: 'assistant', content: null, tool_calls: toolCalls }
                    : { role: 'assistant', content: answer },
                  finish_reason: toolCalls ? 'tool_calls' : 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const modelPort = (model.address() as { port: number }).port;

      // A profile Hermes makes itself, with its own built-in skills; then the hub's boot-time seed.
      hermes(['profile', 'create', 'work', '--no-alias']);
      seedSkillLibraryOfEveryProfile(root, { info: () => undefined, warn: () => undefined });

      // The profile's model through the provider route the hub writes, and its `.env`: the
      // provider's key, and the image skill's own settings.
      const home = path.join(root, 'profiles', 'work');
      writeHermesRoute(home, {
        credentials: [],
        hermesProviders: [
          {
            name: PROVIDER,
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            apiMode: 'chat_completions',
            keyEnv: KEY_ENV,
          },
        ],
        hermesModel: { provider: PROVIDER, model: 'scripted-model' },
        hermesModelBlocked: null,
      } as never);
      writeFileSync(
        path.join(home, '.env'),
        [
          `${KEY_ENV}=sk-model-real-test`,
          `COREHUB_IMAGE_API_KEY=${IMAGE_KEY}`,
          `COREHUB_IMAGE_BASE_URL=http://127.0.0.1:${imagesPort}/v1`,
          '',
        ].join('\n'),
      );
    }, 300_000);

    afterAll(async () => {
      await new Promise<void>((resolve) => model?.close(() => resolve()));
      await new Promise<void>((resolve) => images?.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('Hermes lists every library skill in the core-hub category, in default and in a profile it made', () => {
      const names = [...shippedLibrary().skills.keys()];
      for (const profile of ['default', 'work']) {
        const listed = hermes(['-p', profile, 'skills', 'list']);
        const rows = listed
          .split('\n')
          .map((line) => line.split('│').map((cell) => cell.trim()))
          .filter((cells) => cells.length >= 4 && cells[2] === LIBRARY_CATEGORY)
          .map((cells) => cells[1]);
        console.log(`${profile}: hermes skills list shows ${rows.length} in ${LIBRARY_CATEGORY}`);
        expect(rows.sort()).toEqual([...names].sort());
        // In the profile Hermes made, its own built-in skills are still there beside them.
        if (profile === 'work') expect(listed).toContain('grounded-citations');
      }
    });

    it('runs image-generate end to end in a Hermes turn, against a scripted image endpoint', async () => {
      const output = await hermesTurn(
        [
          '-p',
          'work',
          'chat',
          '-q',
          'ارسم لي ثعلبًا أحمر',
          '-Q',
          '--yolo',
          '--max-turns',
          '6',
          '-t',
          'terminal,skills',
        ],
        work,
      );
      console.log(`hermes answered: ${output.trim().split('\n').slice(-3).join(' | ')}`);
      console.log(`tools offered to the model: ${[...new Set(offered.flat())].sort().join(', ')}`);
      console.log(`script output: ${toolResults.at(-1)?.slice(0, 300)}`);
      expect(offered.flat()).toEqual(expect.arrayContaining(['skill_view', 'terminal']));
      // The skill was read by Hermes (its folder came back from skill_view) …
      expect(toolResults[0]).toContain(`${LIBRARY_CATEGORY}/image-generate`);
      // … the script reached the image API with the profile's key …
      expect(imageCalls).toHaveLength(1);
      expect(imageCalls[0]).toMatchObject({
        url: '/v1/images/generations',
        authorization: `Bearer ${IMAGE_KEY}`,
      });
      expect(JSON.parse(imageCalls[0]!.body)).toMatchObject({
        model: 'gpt-image-1',
        prompt: 'a red fox in flat style',
      });
      // … and the picture is in the working folder, the key nowhere in what the model saw.
      const made = readdirSync(path.join(work, 'images'));
      expect(made).toHaveLength(1);
      expect(made[0]).toMatch(/^a-red-fox-in-flat-style-\d{8}-\d{6}-1\.png$/);
      expect(existsSync(path.join(work, 'images', made[0]!))).toBe(true);
      expect(toolResults.join('\n')).not.toContain(IMAGE_KEY);
    });
  },
);
