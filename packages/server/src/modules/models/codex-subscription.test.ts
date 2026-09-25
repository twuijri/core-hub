/**
 * The ChatGPT subscription's models and images (contract decisions §83 and §84), against a
 * scripted Codex backend and a stand-in for Hermes's credential store.
 *
 * - §83: a signed-in provider's models are what the provider's own models endpoint lists for
 *   the account (per plan), asked from Hermes's Python with Hermes's token — refreshed once
 *   after a 401 — and Hermes's remembered list only when the provider cannot be asked, marked
 *   `fallback` with the reason.
 * - §84: the subscription draws through the backend's `image_generation` tool; the hub offers it
 *   as `gpt-image-2` on the provider, the Images role takes it, and `image_api.py` draws, edits
 *   and cuts out with it, asking Hermes for the token itself. A plan without images is a clean
 *   `image_not_in_plan`.
 *
 * `hermes_cli.auth` below is a stand-in written for this test (the two resolver names Hermes
 * exposes, same shapes); the token it hands out is a fake JWT carrying a ChatGPT account id.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  drainJobs,
  settle,
  signedInHub,
  type TestHub,
} from '../../../tests/unit/helpers.js';
import { hermesPythonRunner } from '../agents/index.js';
import { parseEnv } from './dotenv.js';
import { liveModels } from './live-models.js';
import { hermesSignInRuntime, type DashboardRequest } from './sign-in.js';

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
const SCRIPT = fileURLToPath(
  new URL('../../../skill-library/image-generate/scripts/image_api.py', import.meta.url),
);
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A JWT-shaped token (unsigned) naming a ChatGPT account, as the backend expects. */
const tokenFor = (account: string, tag: string) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
    tag,
  })}.sig`;
};
const PRO = tokenFor('acct-pro', 'fresh');
const PRO_EXPIRED = tokenFor('acct-pro', 'expired');
const PLUS = tokenFor('acct-plus', 'fresh');
const FREE = tokenFor('acct-free', 'fresh');

/** Hermes's credential resolvers, stood in for: the token from the environment, refreshed on ask. */
const STUB_AUTH = `
import os
def _log(what):
    path = os.environ.get("STUB_LOG")
    if path:
        with open(path, "a") as f:
            f.write(what + "\\n")
def resolve_codex_runtime_credentials(force_refresh=False, refresh_if_expiring=True):
    if os.environ.get("STUB_SIGNED_OUT"):
        raise RuntimeError("No Codex credentials stored. Run hermes auth to authenticate.")
    if force_refresh:
        _log("refresh")
        return {"api_key": os.environ["STUB_TOKEN_FRESH"], "base_url": os.environ["STUB_BASE"]}
    return {"api_key": os.environ["STUB_TOKEN"], "base_url": os.environ["STUB_BASE"]}
def resolve_xai_oauth_runtime_credentials(force_refresh=False):
    return {"api_key": os.environ["STUB_TOKEN"], "base_url": os.environ["STUB_XAI_BASE"]}
`;

/** Codex models per account, in the backend's own shape (`priority`, `visibility`). */
const CATALOGUES: Record<string, unknown[]> = {
  'acct-pro': [
    { slug: 'gpt-5.5', priority: 5 },
    { slug: 'gpt-6-sol', priority: 1 },
    { slug: 'gpt-6-astra', priority: 2 },
    { slug: 'gpt-6-luna', priority: 3 },
    { slug: 'gpt-5.6-sol', priority: 4 },
    { slug: 'codex-auto-review', priority: 0, visibility: 'hide' },
  ],
  'acct-plus': [
    { slug: 'gpt-5.6-sol', priority: 1 },
    { slug: 'gpt-5.5', priority: 2 },
  ],
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = '';
const seen: Seen[] = [];
let work = '';
let stubs = '';

const bearerOf = (seenHeaders: Seen['headers']) =>
  String(seenHeaders.authorization ?? '').replace(/^Bearer /, '');

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'corehub-codex-'));
  stubs = path.join(work, 'stubs');
  mkdirSync(path.join(stubs, 'hermes_cli'), { recursive: true });
  writeFileSync(path.join(stubs, 'hermes_cli', '__init__.py'), '');
  writeFileSync(path.join(stubs, 'hermes_cli', 'auth.py'), STUB_AUTH);
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body };
      seen.push(entry);
      const token = bearerOf(request.headers);
      const json = (status: number, value: unknown) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(value));
      };
      if (token === PRO_EXPIRED) return json(401, { error: { message: 'token expired' } });
      const account = String(request.headers['chatgpt-account-id'] ?? '');
      if (request.url === '/codex/models?client_version=0.0.0') {
        // The real backend answers an empty list, with a 200, to a request without the account.
        return json(200, { models: CATALOGUES[account] ?? [] });
      }
      if (request.url === '/xai/v1/models') return json(200, { data: [{ id: 'grok-5' }] });
      if (request.url === '/codex/responses' && request.method === 'POST') {
        if (account === 'acct-free') {
          return json(403, {
            error: { message: 'Image generation is not available on your current plan.' },
          });
        }
        response.setHeader('content-type', 'text/event-stream');
        const events = [
          { type: 'response.created', response: { id: 'resp_1' } },
          {
            type: 'response.output_item.done',
            item: { type: 'image_generation_call', status: 'completed', result: PNG },
          },
          { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
        ];
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        return;
      }
      return json(404, { error: { message: 'not part of this test' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
});

/** Hermes's Python as the hub runs it, with the stand-in credential store on its path. */
function runner(env: () => Record<string, string>) {
  return hermesPythonRunner({
    python: PY ?? 'python3',
    env: () => ({ PATH: process.env.PATH ?? '', PYTHONPATH: stubs, STUB_BASE: `${base}/codex`, ...env() }),
  });
}

describe.skipIf(!PY)('the provider’s own model list for a signed-in account (§83)', () => {
  it('lists what the backend offers this account, in its order, hidden ones left out, nothing invented', async () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    seen.length = 0;
    const pro = await liveModels(runner(() => ({ STUB_TOKEN: PRO })), home, 'openai-codex');
    expect(pro).toEqual({
      ok: true,
      models: ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5'].map((id) => ({
        id,
        label: id,
      })),
    });
    // No `-900k` names and no curated extras: only what the backend listed.
    expect(JSON.stringify(pro)).not.toContain('900k');
    const asked = seen.find((entry) => entry.url.startsWith('/codex/models'));
    expect(asked?.headers['chatgpt-account-id']).toBe('acct-pro');
    expect(asked?.headers.authorization).toBe(`Bearer ${PRO}`);

    const plus = await liveModels(runner(() => ({ STUB_TOKEN: PLUS })), home, 'openai-codex');
    expect(plus.ok && plus.models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
  });

  it('asks Hermes for a refreshed token once after a 401', async () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const log = path.join(home, 'auth.log');
    const listed = await liveModels(
      runner(() => ({ STUB_TOKEN: PRO_EXPIRED, STUB_TOKEN_FRESH: PRO, STUB_LOG: log })),
      home,
      'openai-codex',
    );
    expect(listed.ok).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['refresh']);
  });

  it('says why when the account cannot be asked, and never prints the token', async () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const out = await liveModels(
      runner(() => ({ STUB_TOKEN: PRO, STUB_SIGNED_OUT: '1' })),
      home,
      'openai-codex',
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('not signed in');
    // An account whose catalogue is empty is not a list either.
    const empty = await liveModels(
      runner(() => ({ STUB_TOKEN: FREE })),
      home,
      'openai-codex',
    );
    expect(empty).toEqual({ ok: false, reason: 'the provider listed no models' });
    expect(JSON.stringify(empty)).not.toContain(FREE);
  });

  it('asks the other signed-in providers on their OpenAI-shaped /models', async () => {
    const home = mkdtempSync(path.join(work, 'home-'));
    const xai = await liveModels(
      runner(() => ({ STUB_TOKEN: 'xai-token', STUB_XAI_BASE: `${base}/xai/v1` })),
      home,
      'xai-oauth',
    );
    expect(xai).toEqual({ ok: true, models: [{ id: 'grok-5', label: 'grok-5' }] });
  });
});

/** Hermes's server playing an approved device-code sign-in, with its own remembered list. */
function fakeDashboard(): DashboardRequest {
  return <T>(method: string, route: string): Promise<T> => {
    const url = new URL(route, 'http://hermes.test');
    if (url.pathname === '/api/providers/oauth/openai-codex/start') {
      return Promise.resolve({
        session_id: 's-1',
        user_code: 'ABCD-1234',
        verification_url: 'https://auth.example/device',
        expires_in: 900,
      } as T);
    }
    if (url.pathname === '/api/providers/oauth/openai-codex/poll/s-1') {
      return Promise.resolve({ session_id: 's-1', status: 'approved' } as T);
    }
    if (url.pathname === '/api/model/options') {
      // What Hermes falls back to when it cannot ask: its curated list, `-900k` names and all.
      return Promise.resolve({
        providers: [{ slug: 'openai-codex', models: ['gpt-5.6-sol', 'gpt-5.6-sol-900k', 'gpt-5.5'] }],
      } as T);
    }
    return Promise.resolve({ ok: true } as T);
  };
}

interface ProviderView {
  id: string;
  draws_images: boolean;
  catalogue: { source: string | null; fallback_reason: string | null; status: string };
  models: { model: string; capabilities: string[] }[];
}

async function providerIn(hub: TestHub & { token: string }, id: string): Promise<ProviderView> {
  const listed = (
    await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/providers' })
  ).json() as { items: ProviderView[] };
  const row = listed.items.find((item) => item.id === id);
  if (!row) throw new Error('provider not listed');
  return row;
}

describe.skipIf(!PY)('the ChatGPT subscription in the hub (§83, §84)', () => {
  it('signs in, lists the account’s own models plus its image model, and the Images role takes it', async () => {
    const home = mkdtempSync(path.join(work, 'hermes-'));
    let env: Record<string, string> = { STUB_TOKEN: PRO };
    const hub = await signedInHub(
      {},
      {
        models: {
          restartDelayMs: 0,
          signIn: hermesSignInRuntime(fakeDashboard(), {
            python: () => runner(() => env),
            home: (profile) => (profile ? path.join(home, 'profiles', profile) : home),
          }),
          hermes: {
            home: () => home,
            profileHomes: () => [],
            restart: () => Promise.resolve(true),
            applyEnvironment: () => true,
          },
        },
      },
    );
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'openai-codex', label: 'ChatGPT', kind: 'llm' },
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json() as { id: string };
      const started = (
        await authed(hub, hub.token, { method: 'POST', url: `/api/v1/models/providers/${id}/sign-in` })
      ).json() as { id: string };
      await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/models/providers/${id}/sign-in/${started.id}`,
      });
      await drainJobs(hub.app);

      const provider = await providerIn(hub, id);
      expect(provider.catalogue).toMatchObject({ status: 'ready', source: 'provider', fallback_reason: null });
      expect(provider.draws_images).toBe(true);
      expect(provider.models.map((model) => model.model)).toEqual([
        'gpt-5.5',
        'gpt-5.6-sol',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-6-sol',
        'gpt-image-2',
      ]);
      expect(provider.models.find((model) => model.model === 'gpt-image-2')?.capabilities).toContain(
        'image_output',
      );

      // The Images role takes the subscription's image model, and nothing else of it.
      const refused = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { image: { provider_id: id, model: 'gpt-5.5' } },
      });
      expect(refused.statusCode).toBe(400);
      const chosen = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { image: { provider_id: id, model: 'gpt-image-2' } },
      });
      expect(chosen.statusCode).toBe(200);
      await settle();
      const written = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(written.get('COREHUB_IMAGE_PROVIDER')).toBe('codex');
      expect(written.get('COREHUB_IMAGE_BASE_URL')).toBe('https://chatgpt.com/backend-api/codex');
      expect(written.get('COREHUB_IMAGE_MODEL')).toBe('gpt-image-2');
      // No key: the token is Hermes's and is asked for when drawing.
      expect(written.has('COREHUB_IMAGE_API_KEY')).toBe(false);

      // "Refresh models" asks again; the account can no longer be asked, so Hermes's list is
      // used — and said to be a fallback, with why.
      env = { STUB_TOKEN: PRO, STUB_SIGNED_OUT: '1' };
      const refreshed = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${id}/refresh`,
      });
      expect(refreshed.statusCode).toBeLessThan(300);
      await drainJobs(hub.app);
      const fallback = await providerIn(hub, id);
      expect(fallback.catalogue.source).toBe('fallback');
      expect(fallback.catalogue.fallback_reason).toContain('not signed in');
      expect(fallback.models.map((model) => model.model)).toEqual(
        expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.5', 'gpt-image-2']),
      );
    } finally {
      await hub.close();
    }
  });
});

/** `image_api.py` run as the skills run it, in Hermes's Python (here: with the stand-in). */
function runScript(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: Record<string, unknown>; raw: string }>((resolve, reject) => {
    const child = spawn(PY!, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        PYTHONPATH: stubs,
        STUB_BASE: `${base}/codex`,
        COREHUB_IMAGE_PROVIDER: 'codex',
        COREHUB_IMAGE_BASE_URL: `${base}/codex`,
        COREHUB_IMAGE_MODEL: 'gpt-image-2',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code: code ?? 1, out: JSON.parse(stdout) as Record<string, unknown>, raw: stdout + stderr });
      } catch {
        reject(new Error(`image_api.py printed no JSON: ${stderr}`));
      }
    });
  });
}

describe.skipIf(!PY)('image_api.py draws through the subscription (§84)', () => {
  it('generates a PNG through the image_generation tool, with the account’s token and no tool_choice', async () => {
    const out = path.join(work, 'drawn');
    seen.length = 0;
    const result = await runScript(
      ['generate', '--prompt', 'a red fox', '--aspect', '16:9', '--out', out],
      { STUB_TOKEN: PRO },
    );
    expect(result.code).toBe(0);
    expect(result.out).toMatchObject({ ok: true, provider: 'codex', model: 'gpt-image-2' });
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(out, files[0]!)).subarray(1, 4).toString()).toBe('PNG');
    const call = seen.find((entry) => entry.url === '/codex/responses');
    expect(call?.headers.authorization).toBe(`Bearer ${PRO}`);
    expect(call?.headers['chatgpt-account-id']).toBe('acct-pro');
    const body = JSON.parse(call!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      store: false,
      tools: [{ type: 'image_generation', model: 'gpt-image-2', size: '1536x1024', output_format: 'png' }],
    });
    expect(body).not.toHaveProperty('tool_choice');
    expect(result.raw).not.toContain(PRO);
  });

  it('edits and cuts out with the source image as an input_image, transparent straight from gpt-image', async () => {
    const source = path.join(work, 'photo.png');
    writeFileSync(source, Buffer.from(PNG, 'base64'));
    seen.length = 0;
    const edited = await runScript(
      ['edit', '--image', source, '--prompt', 'make it blue', '--out', path.join(work, 'edited')],
      { STUB_TOKEN: PRO },
    );
    expect(edited.code).toBe(0);
    const editBody = JSON.parse(seen.find((entry) => entry.url === '/codex/responses')!.body) as {
      input: { content: { type: string; image_url?: string }[] }[];
    };
    expect(editBody.input[0]!.content[1]).toMatchObject({ type: 'input_image' });
    expect(editBody.input[0]!.content[1]!.image_url).toMatch(/^data:image\/png;base64,/);

    seen.length = 0;
    const cut = await runScript(
      ['remove-bg', '--image', source, '--out', path.join(work, 'cut')],
      { STUB_TOKEN: PRO },
    );
    expect(cut.code).toBe(0);
    expect(cut.out).toMatchObject({ ok: true, command: 'remove-bg' });
    const cutBody = JSON.parse(seen.find((entry) => entry.url === '/codex/responses')!.body) as {
      tools: { background?: string }[];
    };
    expect(cutBody.tools[0]!.background).toBe('transparent');
  });

  it('refreshes once on a 401 and draws', async () => {
    const log = path.join(work, 'draw-auth.log');
    const result = await runScript(
      ['generate', '--prompt', 'a lighthouse', '--out', path.join(work, 'refreshed')],
      { STUB_TOKEN: PRO_EXPIRED, STUB_TOKEN_FRESH: PRO, STUB_LOG: log },
    );
    expect(result.code).toBe(0);
    expect(existsSync(log) && readFileSync(log, 'utf8').trim()).toBe('refresh');
  });

  it('says cleanly when the plan has no image access', async () => {
    const result = await runScript(
      ['generate', '--prompt', 'a red fox', '--out', path.join(work, 'free')],
      { STUB_TOKEN: FREE },
    );
    expect(result.code).toBe(2);
    expect(result.out).toMatchObject({ ok: false, error: 'image_not_in_plan', status: 403 });
    expect(String(result.out.detail)).toContain('not available on your current plan');
    expect(result.raw).not.toContain(FREE);
  });
});
