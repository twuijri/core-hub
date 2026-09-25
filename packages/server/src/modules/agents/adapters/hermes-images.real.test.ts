/**
 * The image model (decision §72) in **a real Hermes turn**, from the image.
 *
 * The scripted upstream `tests/container/fake-provider.mjs --script images` runs on this machine:
 * a chat model that asks for Hermes's own `image_generate` tool, and two image models — `gpt-image-1`
 * on OpenAI's Images API and `gemini-3.1-flash-image` answering on chat completions with the
 * picture in `message.images`, as cli-proxy-api does. No real provider and no real key.
 *
 * 1. The upstream is added through the hub's API as a chat provider; both image models come back
 *    with `image_output`, and each in turn is chosen in the Images role.
 * 2. One `python -m tui_gateway.entry` from the image, with the environment the hub hands it, runs a
 *    turn: the model calls `image_generate` (through Hermes's tool-search bridge, where Hermes defers
 *    it), Hermes draws through the hub's `corehub-images` backend, and the adapter reports the saved
 *    picture as `file.produced` — which the runner hands to the reply (`handOver`).
 * 3. `image-edit remove-bg` with each model, run by the image's own Python: transparent straight from
 *    gpt-image, on a flat green from the chat model — cleared by `image-convert transparent-bg`.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/adapters/hermes-images.real.test.ts
 *
 * `tests/container/prove-images.sh` proves the same with the whole hub in the container.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';
import { handOver } from '../runner.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const KEY = 'sk-lab-images-real-test';
const FAKE = fileURLToPath(
  new URL('../../../../tests/container/fake-provider.mjs', import.meta.url),
);
const LIBRARY = '/app/packages/server/skill-library';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe.skipIf(!image)('the image model in a real Hermes turn (set COREHUB_HERMES_IMAGE)', () => {
  const { uid, gid } = userInfo();
  let home: string;
  let work: string;
  let upstream: ChildProcess;
  let port: number;
  const heard: string[] = [];
  let hub: TestHub & { token: string };
  let processEnv: Record<string, string> = {};
  let providerId: string;

  /** A container as this user, the Hermes home at the same path as here, on the host network. */
  const containerArgs = (entrypoint: string, env: Record<string, string> = {}) => [
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    `${uid}:${gid}`,
    '-v',
    `${home}:${home}`,
    '-v',
    `${work}:${work}`,
    '-w',
    work,
    '-e',
    'HOME=/tmp',
    '-e',
    `HERMES_HOME=${home}`,
    ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    '--entrypoint',
    entrypoint,
    image!,
  ];

  const python = (code: string, env: Record<string, string>) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'docker',
        [...containerArgs('/opt/hermes/.venv/bin/python', env), '-c', code],
        { timeout: 180_000 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(String(stdout)),
      );
    });

  const chooseImage = async (model: string) => {
    const res = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: {
        default: { provider_id: providerId, model: 'lab/tiny-1:free' },
        image: { provider_id: providerId, model },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ image: { provider_id: providerId, model } });
  };

  /** One turn in a gateway started with the environment the hub hands it now. */
  const drawTurn = async (): Promise<AgentEvent[]> => {
    const channel: TuiChannel = stdioTuiChannel({
      command: 'docker',
      // `-i`: the gateway speaks JSON-RPC over stdin and exits when it closes.
      args: [
        'run',
        '-i',
        ...containerArgs('/opt/hermes/.venv/bin/python', processEnv).slice(1),
        '-m',
        'tui_gateway.entry',
      ],
      env: process.env,
      readyTimeoutMs: 120_000,
    });
    try {
      const session = await HermesTuiSession.open(channel, null, {
        model: 'lab/tiny-1:free',
        provider: 'corehub-custom-lab',
        cwd: work,
      });
      const events: AgentEvent[] = [];
      const reading = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.type === 'run.completed' || event.type === 'run.failed') return;
        }
      })();
      await session.send({ text: 'ارسم لي ثعلبًا أحمر' });
      await reading;
      await session.close();
      return events;
    } finally {
      await channel.close();
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-images-real-home-'));
    work = mkdtempSync(path.join(tmpdir(), 'corehub-images-real-work-'));
    chmodSync(home, 0o777);
    chmodSync(work, 0o777);

    port = await freePort();
    upstream = spawn(
      process.execPath,
      [FAKE, '--port', String(port), '--key', KEY, '--script', 'images'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the scripted upstream did not start')),
        10_000,
      );
      upstream.stdout!.on('data', (chunk: Buffer) => {
        heard.push(...chunk.toString().split('\n').filter(Boolean));
        if (heard.some((line) => line.includes('listening'))) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: globalThis.fetch,
          restartDelayMs: 0,
          hermes: {
            home: () => home,
            profileHomes: () => [],
            restart: () => Promise.resolve(true),
            applyEnvironment: (env) => {
              processEnv = { ...env };
              return true;
            },
          },
        },
      },
    );
    const added = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: {
        label: 'Lab',
        kind: 'llm',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: KEY,
        api_mode: 'chat_completions',
      },
    });
    expect(added.statusCode, added.body).toBe(201);
    providerId = (added.json() as { id: string }).id;
    await drainJobs(hub.app);
  }, 300_000);

  afterAll(async () => {
    await hub?.close();
    upstream?.kill();
    for (const dir of [home, work]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // written by the container as this user; nothing should be left, but never fail on it
      }
    }
  });

  it('offers both of the upstream’s image models as image models', async () => {
    const res = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models' });
    const models = (res.json() as { items: Array<{ key: string; capabilities: string[] }> }).items;
    const capabilities = (id: string) => models.find((m) => m.key.endsWith(`/${id}`))?.capabilities;
    expect(capabilities('gpt-image-1')).toContain('image_output');
    expect(capabilities('gemini-3.1-flash-image')).toContain('image_output');
    expect(capabilities('lab/tiny-1:free')).not.toContain('image_output');
  });

  for (const [model, reached] of [
    ['gpt-image-1', 'images api= /v1/images/generations'],
    ['gemini-3.1-flash-image', 'drawing chat= modalities=["image","text"]'],
  ] as const) {
    it(`draws with ${model} through Hermes's own image_generate, and the picture comes back`, async () => {
      await chooseImage(model);
      const env = readFileSync(path.join(home, '.env'), 'utf8');
      expect(env).toContain(`COREHUB_IMAGE_MODEL=${model}`);
      expect(processEnv.COREHUB_IMAGE_MODEL).toBe(model);
      const before = heard.filter((line) => line.includes(reached)).length;

      const events = await drawTurn();
      const failed = events.find((e) => e.type === 'run.failed');
      expect(failed, JSON.stringify(failed)).toBeUndefined();
      const tool = events.find(
        (e): e is Extract<AgentEvent, { type: 'tool.completed' }> =>
          e.type === 'tool.completed' && e.title === 'image_generate',
      );
      expect(JSON.parse(tool?.output ?? '{}')).toMatchObject({
        success: true,
        provider: 'corehub-images',
        model,
      });
      // The picture Hermes saved in its own cache, reported for the reply …
      const produced = events.filter(
        (e): e is Extract<AgentEvent, { type: 'file.produced' }> => e.type === 'file.produced',
      );
      expect(produced).toHaveLength(1);
      const picture = produced[0]!.path;
      console.log(`${model}: Hermes saved ${picture}`);
      expect(picture.startsWith(path.join(home, 'cache', 'images'))).toBe(true);
      expect(readFileSync(picture).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      // … drawn by the upstream's image model, as its protocol says …
      expect(heard.filter((line) => line.includes(reached)).length).toBe(before + 1);
      // … and handed over the way the runner does it.
      const out = path.join(work, 'out', model);
      const handed = handOver(picture, out);
      expect(handed.ok).toBe(true);
      expect(existsSync(path.join(out, path.basename(picture)))).toBe(true);
    }, 300_000);
  }

  it('cuts a subject out with remove-bg: transparent from gpt-image, cleared from a flat colour otherwise', async () => {
    const source = path.join(work, 'fox.png');
    const cut = async (model: string) => {
      await chooseImage(model);
      const script = `
import json, subprocess, sys
from pathlib import Path
from PIL import Image
Image.new("RGB", (8, 8), (0, 255, 0)).save(${JSON.stringify(source)})
edit = subprocess.run([sys.executable, "${LIBRARY}/image-edit/scripts/image_api.py", "remove-bg",
    "--image", ${JSON.stringify(source)}, "--out", "cut-${model}"], capture_output=True, text=True)
answer = json.loads(edit.stdout)
if answer.get("next"):
    done = subprocess.run([sys.executable, "${LIBRARY}/image-convert/scripts/image_tools.py",
        "transparent-bg", answer["files"][0]], capture_output=True, text=True)
    answer["cleared"] = json.loads(done.stdout)
final = answer.get("cleared", {}).get("file") or answer["files"][0]
im = Image.open(final).convert("RGBA")
answer["corner"] = im.getpixel((0, 0))
answer["middle"] = im.getpixel((16, 16))
print(json.dumps(answer))
`;
      const env = Object.fromEntries(
        readFileSync(path.join(home, '.env'), 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('COREHUB_IMAGE_'))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      return JSON.parse(await python(script, env)) as Record<string, unknown>;
    };

    const straight = await cut('gpt-image-1');
    console.log(`remove-bg gpt-image-1: ${JSON.stringify(straight)}`);
    expect(straight).toMatchObject({ ok: true, provider: 'compatible', transparent: true });
    expect(straight.corner).toEqual([0, 0, 0, 0]);
    expect(straight.middle).toEqual([220, 30, 30, 255]);

    const flat = await cut('gemini-3.1-flash-image');
    console.log(`remove-bg gemini-3.1-flash-image: ${JSON.stringify(flat)}`);
    expect(flat).toMatchObject({ ok: true, provider: 'chat', transparent: false });
    expect(flat.cleared).toMatchObject({ ok: true, background: '#00ff00' });
    expect((flat.corner as number[])[3]).toBe(0);
    expect(flat.middle).toEqual([220, 30, 30, 255]);
  }, 300_000);
});
