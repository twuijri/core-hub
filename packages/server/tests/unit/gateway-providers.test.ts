/**
 * The second report of 2026-09-24: after the owner approved a sender, WhatsApp answered
 * «⚠️ Provider authentication failed», and the gateway's log said
 * `Unknown provider 'majlis-custom-cli-proxy-api'`, while chats in the web kept working.
 *
 * A chat names its provider and model on every turn; a messaging gateway names nothing and
 * reads `model.provider` from its own profile's `config.yaml`, resolving it against the
 * `providers:` blocks **of that same file** (`gateway/run.py` §_resolve_runtime_agent_kwargs).
 * Each profile's save rewrote the root file with that profile's providers only, so the block
 * the default model named could be gone when the gateway started.
 *
 * Here a hub that runs Hermes (a fake `hermes`, a fake spawner that keeps each gateway's
 * `config.yaml` as it was at its start) gets the owner's custom OpenAI-compatible provider as
 * the default model, then another profile saves; every gateway must start on a file whose
 * `model.provider` names a block that file has, and the block of the provider the profile's
 * chat default is.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SpawnedProcess, Spawner } from '../../src/modules/agents/index.js';
import { authed, drainJobs, signedInHub, type TestHub } from './helpers.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await hub?.close();
  hub = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeChild extends EventEmitter implements SpawnedProcess {
  static next = 9000;
  pid = FakeChild.next++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

interface Started {
  profile: string;
  config: {
    model?: { provider?: string; default?: string };
    providers?: Record<string, { base_url?: string }>;
  };
}

const PROXY = 'http://cli-proxy-api:8317/v1';
const OTHER = 'http://other-proxy:9000/v1';

/** Both endpoints list one model each; nothing reaches a network. */
const endpoints: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (url === `${PROXY}/models`) return json({ data: [{ id: 'gemini-2.5-pro' }] });
  if (url === `${OTHER}/models`) return json({ data: [{ id: 'qwen-max' }] });
  return new Response('{}', { status: 404 });
};

async function boot() {
  const bin = mkdtempSync(path.join(tmpdir(), 'majlis-gwp-bin-'));
  dirs.push(bin);
  writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bin, 'hermes'), 0o755);
  const started: Started[] = [];
  const spawnImpl: Spawner = (_command, args, options) => {
    const profile = args[0] === '-p' ? args[1]! : 'default';
    let config: Started['config'] = {};
    try {
      config = (parseYaml(readFileSync(path.join(options.cwd, 'config.yaml'), 'utf8')) ??
        {}) as Started['config'];
    } catch {
      // Nothing written yet.
    }
    started.push({ profile, config });
    return new FakeChild();
  };
  hub = await signedInHub(
    {},
    {
      agents: { pathValue: bin, runtime: { spawnImpl, healthIntervalMs: 0 } },
      models: { fetchImpl: endpoints, restartDelayMs: 0 },
    },
  );
  const agents = await authed(hub, hub.token, { url: '/api/v1/agents' });
  const agent = (agents.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  return { hub, agent, started, root: path.join(hub.dataDir, 'hermes') };
}

async function addEndpoint(
  h: Hub,
  label: string,
  baseUrl: string,
  profile = 'default',
  scope: 'all' | 'profile' = 'all',
) {
  const res = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    profile,
    payload: {
      label,
      kind: 'llm',
      base_url: baseUrl,
      api_mode: 'chat_completions',
      api_key: 'k',
      scope,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  await drainJobs(h.app);
  return res.json() as { id: string };
}

async function makeProfile(h: Hub, slug: string) {
  const res = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/profiles',
    payload: { slug, name: slug },
  });
  expect(res.statusCode, res.body).toBe(201);
  const home = path.join(h.dataDir, 'hermes', 'profiles', slug);
  mkdirSync(home, { recursive: true });
  return home;
}

/** The base URL of the provider a profile's chat default is, as the hub says it. */
async function chatDefaultUrl(h: Hub, profile: string, byId: Map<string, string>) {
  const res = await authed(h, h.token, { url: '/api/v1/models/defaults', profile });
  const ref = (res.json() as { default: { provider_id: string } | null }).default;
  return ref ? byId.get(ref.provider_id) : undefined;
}

/** A gateway can answer only when its file's provider is a block of that same file. */
function expectResolvable(start: Started | undefined, baseUrl: string | undefined) {
  expect(start).toBeDefined();
  const provider = start!.config.model?.provider;
  expect(provider, 'model.provider').toBeTruthy();
  const block = start!.config.providers?.[provider!];
  expect(block, `providers.${provider} (Hermes: "Unknown provider '${provider}'")`).toBeDefined();
  expect(block?.base_url).toBe(baseUrl);
}

describe('every messaging gateway starts on the providers its profile chats with', () => {
  it("the default one, after another profile's save rewrote the root file", async () => {
    const { hub: h, agent, started } = await boot();
    const proxy = await addEndpoint(h, 'cli-proxy-api', PROXY);
    const byId = new Map([[proxy.id, PROXY]]);
    await makeProfile(h, 'empty');
    // Another profile saves its (empty) choice: on the hub of 2026-09-24 this rewrote the root
    // `config.yaml` with that profile's providers — none — and left the default model naming a
    // block that was gone.
    const saved = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      profile: 'empty',
      payload: { default: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    // Hermes's Restart (the owner's own step).
    await authed(h, h.token, { method: 'POST', url: `/api/v1/agents/${agent}/restart` });
    await drainJobs(h.app);
    await vi.waitFor(() =>
      expect(started.filter((s) => s.profile === 'default').length).toBeGreaterThan(1),
    );
    expectResolvable(
      started.filter((s) => s.profile === 'default').at(-1),
      await chatDefaultUrl(h, 'default', byId),
    );
  });

  it('a named profile one, after the provider its copied file names was removed', async () => {
    const { hub: h, agent, root, started } = await boot();
    const proxy = await addEndpoint(h, 'cli-proxy-api', PROXY);
    const home = await makeProfile(h, 'manger');
    // Made as a copy of default at the time: its model names the proxy.
    writeFileSync(path.join(home, 'config.yaml'), readFileSync(path.join(root, 'config.yaml')));
    // The owner moves to another endpoint and removes the proxy. Every profile loses the
    // proxy's block; «manger»'s own file still names it — a chat there names the new default
    // itself, a gateway would read the file and answer "Unknown provider".
    const other = await addEndpoint(h, 'other-proxy', OTHER);
    const chosen = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: { default: { provider_id: other.id, model: 'qwen-max' } },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    const removed = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${proxy.id}`,
    });
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    await drainJobs(h.app);
    const byId = new Map([
      [proxy.id, PROXY],
      [other.id, OTHER],
    ]);

    // A channel in «manger» that can sign in: its gateway starts.
    const put = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/channels/telegram`,
      profile: 'manger',
      payload: { enabled: true, credentials: { token: '1234:abc' } },
    });
    expect(put.statusCode, put.body).toBe(200);
    await vi.waitFor(() => expect(started.some((s) => s.profile === 'manger')).toBe(true));
    const url = await chatDefaultUrl(h, 'manger', byId);
    expect(url).toBe(OTHER);
    expectResolvable(started.filter((s) => s.profile === 'manger').at(-1), url);
  });

  it('a named profile one, on its own profile-only provider chosen as its model', async () => {
    const { hub: h, agent, started } = await boot();
    await addEndpoint(h, 'cli-proxy-api', PROXY);
    await makeProfile(h, 'manger');
    // A provider only «manger» has (decision §37), made its chat model there.
    const own = await addEndpoint(h, 'other-proxy', OTHER, 'manger', 'profile');
    const chosen = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      profile: 'manger',
      payload: { default: { provider_id: own.id, model: 'qwen-max' } },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    const put = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/channels/telegram`,
      profile: 'manger',
      payload: { enabled: true, credentials: { token: '1234:abc' } },
    });
    expect(put.statusCode, put.body).toBe(200);
    await vi.waitFor(() => expect(started.some((s) => s.profile === 'manger')).toBe(true));
    const start = started.filter((s) => s.profile === 'manger').at(-1);
    expectResolvable(start, OTHER);
    expect(start?.config.model?.default).toBe('qwen-max');
    // The default profile's gateway knows nothing of «manger»'s own provider.
    const root = started.filter((s) => s.profile === 'default').at(-1);
    expect(Object.values(root?.config.providers ?? {}).map((b) => b.base_url)).not.toContain(OTHER);
  });
});
