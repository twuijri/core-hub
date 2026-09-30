/**
 * "Hermes uses Core Hub's models" (DECISIONS §143): what the hub writes into Hermes's home when the
 * choice is `hub`, that a call made the way Hermes makes it — the row's own gateway address, the
 * profile's token from `.env`, the provider's own model id — reaches that row through the gateway,
 * and that switching back gives Hermes its own providers again. CLIProxyAPI is the stand-in.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { parseEnv } from '../dotenv.js';
import { readHermesSource, writeHermesSource } from '../hermes-source.js';
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
  decided?: 'native' | 'hub',
): Promise<Hub & { home: string }> {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-gw-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const made = await signedInHub(
    { COREHUB_MODEL_GATEWAY: gateway },
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
  if (decided) writeHermesSource(path.join(made.dataDir, 'gateway'), decided, 'chosen');
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
  it('a new hub with a gateway decides `hub`; a hub that already has providers stays native', async () => {
    const fresh = await hub('on');
    expect(readHermesSource(path.join(fresh.dataDir, 'gateway'))).toBe('hub');
    const read = await authed(fresh, fresh.token, {
      method: 'GET',
      url: '/api/v1/models/hermes-source',
    });
    expect(read.json()).toMatchObject({ source: 'hub', effective: 'hub', available: true });

    const off = await hub('off');
    expect(readHermesSource(path.join(off.dataDir, 'gateway'))).toBe('native');
    const refused = await authed(off, off.token, {
      method: 'PUT',
      url: '/api/v1/models/hermes-source',
      payload: { source: 'hub' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ details: { reason: 'gateway_unavailable' } });
  });

  it('writes one block per provider at its gateway address, with the profile’s token, and a call reaches the row', async () => {
    const h = await hub('on', 'native');
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
    // Native first: Hermes's own providers.
    expect(config(h.home).model?.provider).toBe('anthropic');

    const switched = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/hermes-source',
      payload: { source: 'hub' },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({ source: 'hub', effective: 'hub' });

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
    // The chain through the gateway, and Hermes's own route to the chat model last.
    expect(written.fallback_providers).toEqual([
      { provider: 'corehub-gw-groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    ]);
    const token = env(h.home).get('COREHUB_GATEWAY_TOKEN')!;
    expect(token).toMatch(/^chgwh_/);
    // The keys stay where they were, for what Hermes still does by itself (speech, a fallback).
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

    // Back to native: the hub's gateway blocks and the token go, Hermes's own providers return.
    const back = await authed(h, h.token, {
      method: 'PUT',
      url: '/api/v1/models/hermes-source',
      payload: { source: 'native' },
    });
    expect(back.json()).toMatchObject({ source: 'native', effective: 'native' });
    const after = config(h.home);
    expect(
      Object.keys(after.providers ?? {}).filter((name) => name.startsWith('corehub-gw-')),
    ).toEqual([]);
    expect(after.model?.provider).toBe('anthropic');
    expect(env(h.home).get('COREHUB_GATEWAY_TOKEN')).toBeUndefined();
  });
});
