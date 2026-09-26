/**
 * The image model (contract decision §72, the Models → Images tab).
 *
 * No image providers of their own: the image model is a model of one of the profile's chat
 * providers that draws. It is chosen per profile and inherited from the default profile like
 * the chat model (§37), and it reaches both places that draw — Hermes's `image_generate` tool
 * (the hub's `corehub-images` backend, named in `config.yaml`) and the hub's image skills (the
 * `COREHUB_IMAGE_*` variables in the profile's `.env`) — with no key typed anywhere but on the
 * provider itself.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  authed,
  drainJobs,
  settle,
  signedInHub,
  type TestHub,
} from '../../../tests/unit/helpers.js';
import { parseEnv } from './dotenv.js';
import { imagePluginDir, imagePluginFiles, writeHermesImagePlugin } from './hermes-image-plugin.js';
import {
  HERMES_IMAGE_PLUGIN,
  imageProtocolOf,
  isImageModel,
  isImageOnlyModel,
} from './images.js';
import { writeHermesProviders } from './propagation.js';

type Hub = TestHub & { token: string };

interface Provider {
  id: string;
  slug: string;
  models: { model: string; key: string }[];
}

interface Model {
  provider_id: string;
  model: string;
  capabilities: string[];
  image_only?: boolean;
}

/** cli-proxy-api (a chat model and a Gemini image model) and OpenAI (a chat and a gpt-image). */
function scripted(): typeof fetch {
  return ((url: string) => {
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url.startsWith('http://cli-proxy-api:8317/v1/models')) {
      return json({ data: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-3.1-flash-image' }] });
    }
    if (url.startsWith('https://api.openai.com/v1/models')) {
      return json({ data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }] });
    }
    return json({ error: 'not part of this test' }, 503);
  }) as unknown as typeof fetch;
}

async function addProxy(hub: Hub): Promise<Provider> {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: {
      label: 'cli-proxy-api',
      kind: 'llm',
      base_url: 'http://cli-proxy-api:8317/v1',
      api_mode: 'chat_completions',
      api_key: 'proxy-key',
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json() as Provider;
}

async function addOpenAi(hub: Hub, profile = 'default'): Promise<Provider> {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    profile,
    payload: { preset: 'openai', label: 'OpenAI', kind: 'llm', api_key: 'sk-openai', scope: 'all' },
  });
  expect(created.statusCode).toBe(201);
  return created.json() as Provider;
}

async function makeProfile(hub: Hub, slug: string): Promise<void> {
  const made = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/profiles',
    payload: { slug, name: slug },
  });
  expect(made.statusCode).toBe(201);
}

function defaultsIn(hub: Hub, profile = 'default') {
  return authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/defaults', profile });
}

function chooseImage(
  hub: Hub,
  image: { provider_id: string; model: string } | null,
  profile = 'default',
) {
  return authed(hub, hub.token, {
    method: 'PUT',
    url: '/api/v1/models/defaults',
    profile,
    payload: { image },
  });
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function hermesHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-images-'));
  homes.push(home);
  return home;
}

function configOf(home: string): Record<string, unknown> {
  const file = path.join(home, 'config.yaml');
  if (!existsSync(file)) return {};
  return (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
}

function envOf(home: string): Map<string, string> {
  const file = path.join(home, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : new Map();
}

describe('models: which models draw', () => {
  it('knows an image model by its id, and how the hub speaks to it', () => {
    for (const id of [
      'gpt-image-1',
      'gemini-3.1-flash-image',
      'google/gemini-3-pro-image',
      'imagen-4.0-generate-001',
      'black-forest-labs/flux-1.1-pro',
      'dall-e-3',
    ]) {
      expect(isImageModel(id), id).toBe(true);
    }
    for (const id of ['gpt-5', 'gemini-2.5-pro', 'claude-sonnet-4-5', 'text-embedding-3-small']) {
      expect(isImageModel(id), id).toBe(false);
    }
    // The provider's word counts when the id says nothing.
    expect(isImageModel('mystery-model', ['image_output'])).toBe(true);
    expect(imageProtocolOf('openai', 'gpt-image-1')).toBe('compatible');
    expect(imageProtocolOf('openai', 'gemini-3.1-flash-image')).toBe('chat');
    expect(imageProtocolOf('google', 'gemini-2.5-flash-image')).toBe('gemini');
    expect(imageProtocolOf('anthropic', 'claude-sonnet-4-5')).toBeNull();
  });

  it('tells a model that only draws from one that draws and chats (§86)', () => {
    // Image-only: the Images-API families, the subscription's gpt-image-2 among them. Chosen as
    // a chat model they fail the turn, so the clients leave them out of chat pickers.
    for (const id of [
      'gpt-image-1',
      'gpt-image-2',
      'dall-e-3',
      'imagen-4.0-generate-001',
      'black-forest-labs/flux-1.1-pro',
    ]) {
      expect(isImageOnlyModel(id), id).toBe(true);
    }
    // They draw and they chat: still offered as chat models.
    for (const id of ['gemini-3.1-flash-image', 'google/gemini-3-pro-image', 'gpt-5-image']) {
      expect(isImageModel(id), id).toBe(true);
      expect(isImageOnlyModel(id), id).toBe(false);
    }
    for (const id of ['gpt-5', 'gemini-2.5-pro', 'claude-sonnet-4-5']) {
      expect(isImageOnlyModel(id), id).toBe(false);
    }
  });

  it('marks the image models of a chat provider in the catalogue', async () => {
    const hub = await signedInHub({}, { models: { fetchImpl: scripted() } });
    try {
      await addProxy(hub);
      await addOpenAi(hub);
      await drainJobs(hub.app);
      const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models' });
      const items = (listed.json() as { items: Model[] }).items;
      const image = items.find((model) => model.model === 'gemini-3.1-flash-image');
      const chat = items.find((model) => model.model === 'gemini-2.5-pro');
      expect(image?.capabilities).toContain('image_output');
      expect(chat?.capabilities).not.toContain('image_output');
      // Gemini's image model chats too; neither is image-only (§86).
      expect(image?.image_only).toBe(false);
      expect(chat?.image_only).toBe(false);
      // OpenAI's gpt-image only draws: offered as the image model, never as a chat model.
      const drawOnly = items.find((model) => model.model === 'gpt-image-1');
      expect(drawOnly?.capabilities).toContain('image_output');
      expect(drawOnly?.image_only).toBe(true);
      expect(items.find((model) => model.model === 'gpt-5')?.image_only).toBe(false);
    } finally {
      await hub.close();
    }
  });
});

describe('models: the image model is a role, inherited like the chat model (§37, §72)', () => {
  it("uses the default profile's image model in a profile that chose none, and its own once it chooses", async () => {
    const hub = await signedInHub({}, { models: { fetchImpl: scripted() } });
    try {
      await makeProfile(hub, 'work');
      const proxy = await addProxy(hub);
      const openai = await addOpenAi(hub);
      await drainJobs(hub.app);

      // Nothing chosen anywhere yet.
      expect((await defaultsIn(hub)).json()).toMatchObject({ image: null });

      const chosen = await chooseImage(hub, {
        provider_id: proxy.id,
        model: 'gemini-3.1-flash-image',
      });
      expect(chosen.statusCode).toBe(200);
      expect(chosen.json()).toMatchObject({
        image: { provider_id: proxy.id, model: 'gemini-3.1-flash-image' },
      });
      expect((chosen.json() as { inherited: string[] }).inherited).not.toContain('image');

      // The work profile chose none: it shows the default profile's, and says so.
      const inherited = (await defaultsIn(hub, 'work')).json() as {
        image: unknown;
        inherited: string[];
      };
      expect(inherited.image).toEqual({ provider_id: proxy.id, model: 'gemini-3.1-flash-image' });
      expect(inherited.inherited).toContain('image');

      // Its own choice is its own; the default profile's does not move.
      const own = await chooseImage(hub, { provider_id: openai.id, model: 'gpt-image-1' }, 'work');
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ image: { provider_id: openai.id, model: 'gpt-image-1' } });
      expect((own.json() as { inherited: string[] }).inherited).not.toContain('image');
      expect((await defaultsIn(hub)).json()).toMatchObject({
        image: { provider_id: proxy.id, model: 'gemini-3.1-flash-image' },
      });

      // Clearing goes back to inheriting.
      await chooseImage(hub, null, 'work');
      expect((await defaultsIn(hub, 'work')).json()).toMatchObject({
        image: { provider_id: proxy.id, model: 'gemini-3.1-flash-image' },
        inherited: expect.arrayContaining(['image']) as unknown,
      });
    } finally {
      await hub.close();
    }
  });

  it('refuses a model that does not draw, and leaves the chat model alone', async () => {
    const hub = await signedInHub({}, { models: { fetchImpl: scripted() } });
    try {
      const proxy = await addProxy(hub);
      await drainJobs(hub.app);
      const before = (await defaultsIn(hub)).json() as { default: unknown };
      const refused = await chooseImage(hub, { provider_id: proxy.id, model: 'gemini-2.5-pro' });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toContain('not an image model');
      const unknown = await chooseImage(hub, { provider_id: proxy.id, model: 'no-such-image' });
      expect(unknown.statusCode).toBe(400);
      const after = (await defaultsIn(hub)).json() as { default: unknown; image: unknown };
      expect(after.image).toBeNull();
      expect(after.default).toEqual(before.default);
    } finally {
      await hub.close();
    }
  });
});

describe('models: the image model reaches Hermes and the skills (§72)', () => {
  it('points Hermes at the hub backend and hands the skills the model, per profile', async () => {
    const home = hermesHome();
    const design = path.join(home, 'profiles', 'design');
    mkdirSync(design, { recursive: true });
    // Somebody's own settings in the design profile, which the hub must keep.
    writeFileSync(
      path.join(design, 'config.yaml'),
      'plugins:\n  enabled:\n    - my-own-plugin\nimage_gen:\n  fal:\n    model: fal-ai/flux\n',
    );
    let processEnv: Record<string, string> = {};
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: scripted(),
          restartDelayMs: 0,
          hermes: {
            home: () => home,
            profileHomes: () => [design],
            restart: () => Promise.resolve(true),
            applyEnvironment: (env) => {
              processEnv = { ...env };
              return true;
            },
          },
        },
      },
    );
    try {
      await makeProfile(hub, 'design');
      const proxy = await addProxy(hub);
      const openai = await addOpenAi(hub);
      await drainJobs(hub.app);

      // Before a choice there is nothing to draw with, and nothing was written for it.
      expect(configOf(home).image_gen).toBeUndefined();
      expect(envOf(home).has('COREHUB_IMAGE_MODEL')).toBe(false);
      expect(existsSync(imagePluginDir(home))).toBe(false);

      await chooseImage(hub, { provider_id: proxy.id, model: 'gemini-3.1-flash-image' });
      await settle();

      // Hermes's tool: the hub's backend, listed and named, its files in place.
      const root = configOf(home) as {
        image_gen?: { provider?: string };
        plugins?: { enabled?: string[] };
      };
      expect(root.image_gen?.provider).toBe(HERMES_IMAGE_PLUGIN.name);
      expect(root.plugins?.enabled).toContain(HERMES_IMAGE_PLUGIN.key);
      for (const file of imagePluginFiles()) {
        expect(readFileSync(path.join(imagePluginDir(home), file.name))).toEqual(file.data);
      }
      // The skills: the provider's address, the model, how to speak to it, and its key —
      // in the file and in the process Hermes runs in.
      const env = envOf(home);
      expect(env.get('COREHUB_IMAGE_PROVIDER')).toBe('chat');
      expect(env.get('COREHUB_IMAGE_BASE_URL')).toBe('http://cli-proxy-api:8317/v1');
      expect(env.get('COREHUB_IMAGE_MODEL')).toBe('gemini-3.1-flash-image');
      expect(env.get('COREHUB_IMAGE_API_KEY')).toBe('proxy-key');
      expect(processEnv).toMatchObject({
        COREHUB_IMAGE_MODEL: 'gemini-3.1-flash-image',
        COREHUB_IMAGE_API_KEY: 'proxy-key',
      });

      // The design profile inherits: same backend, its own entries kept, and no copy of the
      // root's values in its `.env` (Hermes falls back on the process for those).
      const designConfig = configOf(design) as {
        image_gen?: { provider?: string; fal?: unknown };
        plugins?: { enabled?: string[] };
      };
      expect(designConfig.image_gen?.provider).toBe(HERMES_IMAGE_PLUGIN.name);
      expect(designConfig.image_gen?.fal).toEqual({ model: 'fal-ai/flux' });
      expect(designConfig.plugins?.enabled).toEqual(['my-own-plugin', HERMES_IMAGE_PLUGIN.key]);
      expect(existsSync(path.join(imagePluginDir(design), '__init__.py'))).toBe(true);
      expect(envOf(design).has('COREHUB_IMAGE_MODEL')).toBe(false);

      // Its own choice: what differs from the root lands in its own `.env`.
      await chooseImage(hub, { provider_id: openai.id, model: 'gpt-image-1' }, 'design');
      await settle();
      const own = envOf(design);
      expect(own.get('COREHUB_IMAGE_PROVIDER')).toBe('compatible');
      expect(own.get('COREHUB_IMAGE_BASE_URL')).toBe('https://api.openai.com/v1');
      expect(own.get('COREHUB_IMAGE_MODEL')).toBe('gpt-image-1');
      expect(own.get('COREHUB_IMAGE_API_KEY')).toBe('sk-openai');

      // Taken away in both: the variables go, and the hub takes back only what it wrote.
      await chooseImage(hub, null, 'design');
      await chooseImage(hub, null);
      await settle();
      const cleared = envOf(home);
      for (const name of [
        'COREHUB_IMAGE_PROVIDER',
        'COREHUB_IMAGE_BASE_URL',
        'COREHUB_IMAGE_MODEL',
        'COREHUB_IMAGE_API_KEY',
      ]) {
        expect(cleared.has(name), name).toBe(false);
        expect(envOf(design).has(name), name).toBe(false);
      }
      expect(processEnv.COREHUB_IMAGE_MODEL).toBeUndefined();
      expect(configOf(home).image_gen).toBeUndefined();
      expect(configOf(home).plugins).toBeUndefined();
      expect(configOf(design)).toMatchObject({
        plugins: { enabled: ['my-own-plugin'] },
        image_gen: { fal: { model: 'fal-ai/flux' } },
      });
      expect((configOf(design).image_gen as { provider?: string }).provider).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it('never takes over an image backend somebody chose in Hermes, when the hub has none to give', () => {
    const home = hermesHome();
    writeFileSync(path.join(home, 'config.yaml'), 'image_gen:\n  provider: fal\n');
    const result = writeHermesProviders(home, [], null, false);
    expect(result.dirty).toBe(false);
    expect(configOf(home)).toEqual({ image_gen: { provider: 'fal' } });
  });
});

// ------------------------------------------------------- the backend, run by a Python

function python(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' });
      const minor = /Python 3\.(\d+)/.exec(version);
      if (minor && Number(minor[1]) >= 9) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}
const PY = python();

/**
 * The few names of Hermes the backend imports (`agent/image_gen_provider.py`,
 * `agent/secret_scope.py`), written in our own words with the same shapes, so the plugin can be
 * loaded and called the way Hermes's registry does without a Hermes install.
 */
const STUB_PROVIDER = `
import abc, base64, os, uuid
from pathlib import Path
DEFAULT_ASPECT_RATIO = "landscape"
class ImageGenProvider(abc.ABC):
    @property
    @abc.abstractmethod
    def name(self): ...
    @abc.abstractmethod
    def generate(self, prompt, aspect_ratio=DEFAULT_ASPECT_RATIO, **kwargs): ...
def resolve_aspect_ratio(value):
    value = (value or "").strip().lower() if isinstance(value, str) else ""
    return value if value in ("landscape", "square", "portrait") else "landscape"
def normalize_reference_images(value):
    if isinstance(value, str):
        value = [value]
    return [v for v in (value or []) if isinstance(v, str) and v.strip()] or None
def save_b64_image(data, *, prefix="image", extension="png"):
    path = Path(os.environ["STUB_CACHE"]) / f"{prefix}_{uuid.uuid4().hex}.{extension}"
    path.write_bytes(base64.b64decode(data))
    return path
def success_response(*, image, model, prompt, aspect_ratio, provider, modality="text", extra=None):
    out = dict(success=True, image=image, model=model, prompt=prompt, aspect_ratio=aspect_ratio,
               modality=modality, provider=provider)
    out.update(extra or {})
    return out
def error_response(*, error, error_type="provider_error", provider="", model="", prompt="",
                   aspect_ratio=DEFAULT_ASPECT_RATIO):
    return dict(success=False, image=None, error=error, error_type=error_type, provider=provider)
`;
const STUB_SECRETS = `
import os
def get_secret(name, default=None):
    return os.environ.get(name, default)
`;
const DRIVER = `
import importlib.util, json, sys
plugin_dir, stubs = sys.argv[1], sys.argv[2]
sys.path.insert(0, stubs)
spec = importlib.util.spec_from_file_location(
    "hermes_plugins.image_gen.corehub_images", plugin_dir + "/__init__.py",
    submodule_search_locations=[plugin_dir])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Ctx:
    def register_image_gen_provider(self, provider):
        self.provider = provider
ctx = Ctx()
module.register(ctx)
provider = ctx.provider
out = {"name": provider.name, "available": provider.is_available(),
       "capabilities": provider.capabilities()}
if provider.is_available():
    out["drawn"] = provider.generate("a red fox", "square")
    out["edited"] = provider.generate("make it blue", "portrait", image_url=sys.argv[3])
else:
    out["drawn"] = provider.generate("a red fox", "square")
print(json.dumps(out))
`;

describe.skipIf(!PY)("models: the hub's Hermes image backend draws with the chosen model", () => {
  it('registers under its name, draws and edits through the chosen chat image model', async () => {
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const seen: { url: string; auth: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        seen.push({ url: request.url ?? '', auth: request.headers.authorization, body });
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }],
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const home = hermesHome();
    const stubs = path.join(home, 'stubs');
    mkdirSync(path.join(stubs, 'agent'), { recursive: true });
    writeFileSync(path.join(stubs, 'agent', '__init__.py'), '');
    writeFileSync(path.join(stubs, 'agent', 'image_gen_provider.py'), STUB_PROVIDER);
    writeFileSync(path.join(stubs, 'agent', 'secret_scope.py'), STUB_SECRETS);
    const cache = path.join(home, 'cache');
    mkdirSync(cache);
    const source = path.join(home, 'photo.png');
    writeFileSync(source, Buffer.from(PNG, 'base64'));
    writeHermesImagePlugin(home, true);

    const drive = (env: Record<string, string>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn(PY!, ['-c', DRIVER, imagePluginDir(home), stubs, source], {
          env: { PATH: process.env.PATH ?? '', STUB_CACHE: cache, ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', reject);
        child.on('close', () => {
          try {
            resolve(JSON.parse(stdout) as Record<string, unknown>);
          } catch {
            reject(new Error(`the backend printed no JSON: ${stderr}`));
          }
        });
      });

    try {
      const drawn = await drive({
        COREHUB_IMAGE_PROVIDER: 'chat',
        COREHUB_IMAGE_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        COREHUB_IMAGE_MODEL: 'gemini-3.1-flash-image',
        COREHUB_IMAGE_API_KEY: 'proxy-key',
      });
      expect(drawn).toMatchObject({
        name: HERMES_IMAGE_PLUGIN.name,
        available: true,
        capabilities: { modalities: ['text', 'image'] },
        drawn: { success: true, model: 'gemini-3.1-flash-image', modality: 'text' },
        edited: { success: true, modality: 'image' },
      });
      const image = String((drawn.drawn as { image: string }).image);
      expect(image.startsWith(cache)).toBe(true);
      expect(readFileSync(image).subarray(1, 4).toString()).toBe('PNG');
      expect(seen[0]).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer proxy-key' });
      expect(JSON.parse(seen[0]!.body)).toMatchObject({
        model: 'gemini-3.1-flash-image',
        image_config: { aspect_ratio: '1:1' },
      });
      // The edit carries the source image to the model.
      expect(seen[1]!.body).toContain('data:image/png;base64,');
      expect(JSON.stringify(drawn)).not.toContain('proxy-key');

      // No model chosen: unavailable, and the tool's error says where to choose one.
      const none = await drive({});
      expect(none).toMatchObject({
        available: false,
        drawn: { success: false, error_type: 'image_model_not_chosen' },
      });
      expect(String((none.drawn as { error: string }).error)).toContain('Models → Images');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
