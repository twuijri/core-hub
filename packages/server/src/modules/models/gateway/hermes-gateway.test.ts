/**
 * Hermes reaches its models through Core Hub's gateway, always (DECISIONS §144, reversing §143's
 * per-hub choice): what the hub writes into Hermes's home, that a call made the way Hermes makes
 * it — the row's own gateway address, the profile's token from `.env`, the provider's own model id
 * — reaches that row through the gateway, that there is no switch left to turn it off, and that a
 * person's own Hermes (`~/.hermes`, on a computer) is never written. CLIProxyAPI is the stand-in.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { parseEnv } from '../dotenv.js';
import { upstreamPrefix } from './cliproxy-config.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testing',
  'fake-cliproxy.mjs',
);

type Hub = TestHub & { token: string };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function providers(): typeof fetch {
  return (async (url: string) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      return json({ data: [{ id: 'claude-sonnet-4-5' }], has_more: false });
    }
    if (url.startsWith('https://api.groq.com/openai/v1/models')) {
      return json({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    }
    return new Response('{}', { status: 503 });
  }) as unknown as typeof fetch;
}

async function hub(
  gateway: 'on' | 'off',
  env: Record<string, string> = {},
): Promise<Hub & { home: string }> {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-gw-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const made = await signedInHub(
    { COREHUB_MODEL_GATEWAY: gateway, ...env },
    {
      models: {
        fetchImpl: providers(),
        cliproxyBin: gateway === 'on' ? FAKE : null,
        restartDelayMs: 0,
        hermes: { home: () => home, restart: () => Promise.resolve(true) },
      },
    },
  );
  cleanup.push(() => made.close());
  return Object.assign(made as Hub, { home });
}

async function add(h: Hub, preset: string, key: string | null) {
  const response = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset, label: preset, kind: 'llm', api_key: key, scope: 'all' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string };
}

interface HermesConfig {
  model?: { provider?: string; default?: string };
  providers?: Record<string, { base_url: string; api_mode?: string; key_env: string }>;
  fallback_providers?: { provider: string; model: string }[];
}

const config = (home: string) =>
  parse(readFileSync(path.join(home, 'config.yaml'), 'utf8')) as HermesConfig;
const env = (home: string) => parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));

describe('Hermes on the hub’s models', () => {
  it('has no switch: the choice’s routes are gone, and a choice an earlier build kept is ignored', async () => {
    const h = await hub('on');
    for (const method of ['GET', 'PUT'] as const) {
      const response = await authed(h, h.token, {
        method,
        url: '/api/v1/models/hermes-source',
        ...(method === 'PUT' ? { payload: { source: 'native' } } : {}),
      });
      expect(response.statusCode).toBe(404);
    }
    // A preview build's `native` choice, left in the data folder: read by nobody.
    writeFileSync(
      path.join(h.dataDir, 'gateway', 'hermes-models.json'),
      '{"source":"native","why":"chosen"}\n',
    );
    await add(h, 'groq', 'gsk-hermes-no-switch');
    await drainJobs(h.app);
    expect(Object.keys(config(h.home).providers ?? {})).toContain('corehub-gw-groq');
  });

  it('writes one block per provider at its gateway address, with the profile’s token, and a call reaches the row', async () => {
    const h = await hub('on');
    const anthropic = await add(h, 'anthropic', 'sk-ant-hermes-gateway');
    const groq = await add(h, 'groq', 'gsk-hermes-gateway');
    await drainJobs(h.app);
    await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: {
        default: { provider_id: anthropic.id, model: 'claude-sonnet-4-5' },
        fallbacks: [{ provider_id: groq.id, model: 'llama-3.3-70b-versatile' }],
      },
    });
    const written = config(h.home);
    const blocks = written.providers ?? {};
    const messages = blocks['corehub-gw-anthropic']!;
    const chat = blocks['corehub-gw-groq']!;
    expect(messages).toMatchObject({
      api_mode: 'anthropic_messages',
      key_env: 'COREHUB_GATEWAY_TOKEN',
    });
    expect(messages.base_url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/gateway/row/${anthropic.id}/anthropic$`),
    );
    expect(chat).toMatchObject({ api_mode: 'chat_completions' });
    expect(chat.base_url).toMatch(new RegExp(`/gateway/row/${groq.id}/openai/v1$`));
    // The model is the provider's own id; the block says which row.
    expect(written.model).toMatchObject({
      provider: 'corehub-gw-anthropic',
      default: 'claude-sonnet-4-5',
    });
    // The chain goes through the gateway too, with no route of Hermes's own around it.
    expect(written.fallback_providers).toEqual([
      { provider: 'corehub-gw-groq', model: 'llama-3.3-70b-versatile' },
    ]);
    const token = env(h.home).get('COREHUB_GATEWAY_TOKEN')!;
    expect(token).toMatch(/^chgwh_/);
    // The keys stay where they were, for what Hermes still does by itself (speech, embeddings).
    expect(env(h.home).get('ANTHROPIC_API_KEY')).toBe('sk-ant-hermes-gateway');

    // A call as Hermes makes it: the block's address, the token, the provider's own model id.
    const answer = await fetch(`${chat.base_url}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(answer.status, await answer.clone().text()).toBe(200);
    expect(answer.headers.get('x-fake-model')).toBe(
      `${upstreamPrefix(groq.id)}/llama-3.3-70b-versatile`,
    );
    await answer.text();
    const models = await fetch(`${chat.base_url}/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await models.json()) as unknown).toMatchObject({
      data: [{ id: 'llama-3.3-70b-versatile' }],
    });
    // A token that is not one the hub signed is refused.
    const forged = await fetch(`${chat.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.slice(0, -2)}xx`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [] }),
    });
    expect(forged.status).toBe(401);
  });

  it('a hub whose operator switched the gateway off gives Hermes its own routes', async () => {
    const h = await hub('off');
    const groq = await add(h, 'groq', 'gsk-hermes-gateway-off');
    await drainJobs(h.app);
    await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: { default: { provider_id: groq.id, model: 'llama-3.3-70b-versatile' } },
    });
    const written = config(h.home);
    expect(
      Object.keys(written.providers ?? {}).some((name) => name.startsWith('corehub-gw-')),
    ).toBe(false);
    expect(written.model?.provider).toBe('corehub-groq');
    expect(env(h.home).get('COREHUB_GATEWAY_TOKEN')).toBeUndefined();
  });

  it('never writes a person’s own Hermes (`~/.hermes`) on their computer', async () => {
    // A person's own Hermes, with a provider of their own: what their Hermes app keeps using.
    const person = mkdtempSync(path.join(tmpdir(), 'corehub-person-'));
    cleanup.push(() => rmSync(person, { recursive: true, force: true }));
    const own = path.join(person, '.hermes');
    mkdirSync(own, { recursive: true });
    const ownConfig = 'model:\n  provider: openrouter\n  default: my/own-model\n';
    const ownEnv = 'OPENROUTER_API_KEY=sk-or-the-persons-own\n';
    writeFileSync(path.join(own, 'config.yaml'), ownConfig);
    writeFileSync(path.join(own, '.env'), ownEnv);

    // The hub writes its own Hermes home (`${DATA_DIR}/hermes` on a computer, ADR 0021: the
    // runtime's `home`, proven in hermes-runtime.test.ts), wherever the person's HOME is.
    const h = await hub('on', { HOME: person });
    const groq = await add(h, 'groq', 'gsk-hermes-person');
    await drainJobs(h.app);
    await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: { default: { provider_id: groq.id, model: 'llama-3.3-70b-versatile' } },
    });
    expect(config(h.home).model?.provider).toBe('corehub-gw-groq');
    expect(readFileSync(path.join(own, 'config.yaml'), 'utf8')).toBe(ownConfig);
    expect(readFileSync(path.join(own, '.env'), 'utf8')).toBe(ownEnv);
  });
});
