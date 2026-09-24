/**
 * The `models` module over HTTP, and the thing the whole module exists for: the owner
 * adds a provider key **once** and every agent has it (ADR 0010).
 *
 * The scripted `fetch` below is the only provider these tests ever talk to. A real key is
 * never needed; `models-live.test.ts` is the gated exception.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authed,
  drainJobs,
  settle,
  signedInHub,
  type TestHub,
} from '../../../tests/unit/helpers.js';
import { agentsServiceFor } from '../agents/index.js';
import { parseEnv } from './dotenv.js';

interface Scripted {
  status?: number;
  json?: unknown;
  text?: string;
}

function scriptedFetch(byUrl: (url: string, headers: Record<string, string>) => Scripted): {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(url), headers });
    const answer = byUrl(String(url), headers);
    return Promise.resolve(
      new Response(answer.text ?? JSON.stringify(answer.json ?? {}), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * An endpoint that wants a key after all: 401 with its own words until the right
 * `Authorization` header arrives. The hub must relay those words, never replace them.
 */
function scriptedFetchWithAuth(url: string, expected: () => string | null, ok: unknown) {
  return scriptedFetch((requested, headers) => {
    if (requested !== url) return { status: 503, json: { error: 'not part of this test' } };
    const want = expected();
    if (want && headers.authorization === `Bearer ${want}`) return { json: ok };
    return { status: 401, json: { error: { message: 'missing api key' } } };
  });
}

/** Anthropic answers with two models; everything else is not listening. */
function anthropicOnly() {
  return scriptedFetch((url) => {
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      return {
        json: {
          data: [
            { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
          ],
          has_more: false,
        },
      };
    }
    return { status: 503, json: { error: 'not part of this test' } };
  });
}

interface Provider {
  id: string;
  slug: string;
  kind: string;
  api_key: string | null;
  builtin: boolean;
  enabled: boolean;
  auth: { kind: string; signed_in: boolean };
  catalogue: { status: string; refreshable: boolean; error: string | null };
  models: { model: string; key: string }[];
}

async function providers(hub: TestHub, token: string): Promise<Provider[]> {
  const response = await authed(hub, token, { method: 'GET', url: '/api/v1/models/providers' });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Provider[] }).items;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const bySlug = (list: Provider[], slug: string): Provider => {
  const found = list.find((provider) => provider.slug === slug);
  if (!found) throw new Error(`no provider "${slug}" in ${list.map((p) => p.slug).join(', ')}`);
  return found;
};

/**
 * Add a provider the way the dialog does: a preset, a key when the preset needs one.
 * A workspace starts with no providers at all now (contract decision §26), so every test
 * below says which ones this person added.
 */
async function addProvider(
  hub: TestHub & { token: string },
  preset: string,
  extra: { api_key?: string | null; base_url?: string; label?: string; kind?: string } = {},
): Promise<Provider> {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: {
      preset,
      label: extra.label ?? preset,
      kind: extra.kind ?? 'llm',
      ...(extra.base_url === undefined ? {} : { base_url: extra.base_url }),
      ...(extra.api_key === undefined ? {} : { api_key: extra.api_key }),
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`adding ${preset} answered ${String(response.statusCode)}: ${response.body}`);
  }
  return response.json() as Provider;
}

describe('models: providers over HTTP', () => {
  it('gives a fresh workspace no providers, and offers the presets instead', async () => {
    const hub = await signedInHub();
    try {
      // The screen lists what the person configured, which on day one is nothing.
      expect(await providers(hub, hub.token)).toEqual([]);

      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models/provider-presets',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        items: {
          id: string;
          key: string;
          base_url: string | null;
          base_url_required: boolean;
          local: boolean;
          repeatable: boolean;
        }[];
        host: { containerized: boolean; loopback_alias: string };
      };
      const preset = (id: string) => {
        const found = body.items.find((item) => item.id === id);
        if (!found) throw new Error(`no preset "${id}"`);
        return found;
      };
      // The local ones the owner asked for first.
      expect(preset('lmstudio')).toMatchObject({
        key: 'optional',
        base_url: 'http://127.0.0.1:1234/v1',
        base_url_required: false,
        local: true,
      });
      // No host could be guessed for a LiteLLM proxy, so the person must give one.
      expect(preset('litellm')).toMatchObject({
        key: 'optional',
        base_url: null,
        base_url_required: true,
      });
      expect(preset('openai-compatible')).toMatchObject({ key: 'optional', repeatable: true });
      expect(preset('ollama')).toMatchObject({ key: 'optional', local: true });
      // Nothing here refuses a key — `none` is not a value this contract has.
      expect(body.items.every((item) => item.key === 'required' || item.key === 'optional')).toBe(
        true,
      );
      expect(preset('anthropic').key).toBe('required');
      expect(body.host.loopback_alias).toBe('host.docker.internal');
    } finally {
      await hub.close();
    }
  });

  it('stores a key masked, never echoes it, and fetches the catalogue by itself', async () => {
    const { fetchImpl } = anthropicOnly();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant-placeholder' });
      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${anthropic.id}`,
        payload: { api_key: 'sk-ant-api03-NEVER-ECHOED' },
      });

      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain('NEVER-ECHOED');
      expect((saved.json() as Provider).api_key).toBe('[stored]');
      expect((saved.json() as Provider).auth).toEqual({ kind: 'api_key', signed_in: true });

      // Setting the key starts a catalogue refresh: nobody has to press a second button.
      await drainJobs(hub.app);
      const after = bySlug(await providers(hub, hub.token), 'anthropic');
      expect(after.catalogue.status).toBe('ready');
      expect(after.models.map((m) => m.model).sort()).toEqual([
        'claude-haiku-4-5',
        'claude-sonnet-4-5',
      ]);
      expect(after.models[0]!.key).toBe('anthropic/claude-haiku-4-5');
    } finally {
      await hub.close();
    }
  });

  it('shares one key across every provider row of the same credential family', async () => {
    const hub = await signedInHub();
    try {
      await addProvider(hub, 'openai', { api_key: 'sk-openai-once' });
      await addProvider(hub, 'anthropic', { api_key: 'sk-ant-other-account' });

      // Adding OpenAI adds its whole credential family in one go: the chat tab, the
      // dictation tab and the speech tab are one account (ADR 0010 §2).
      const list = await providers(hub, hub.token);
      expect(bySlug(list, 'openai').api_key).toBe('[stored]');
      expect(bySlug(list, 'openai-stt').api_key).toBe('[stored]');
      expect(bySlug(list, 'openai-tts').api_key).toBe('[stored]');

      // A different account is a different key: clearing one leaves the other alone.
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${bySlug(list, 'openai').id}`,
        payload: { api_key: '' },
      });
      const after = await providers(hub, hub.token);
      expect(bySlug(after, 'openai-tts').api_key).toBeNull();
      expect(bySlug(after, 'anthropic').api_key).toBe('[stored]');
    } finally {
      await hub.close();
    }
  });

  it('leaves the stored key alone when a client sends the mask back', async () => {
    const hub = await signedInHub();
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-real' });
      const url = `/api/v1/models/providers/${anthropic.id}`;
      // A form that round-trips what it was shown must not wipe the key.
      const again = await authed(hub, hub.token, {
        method: 'PATCH',
        url,
        payload: { api_key: '[stored]', label: 'Anthropic (work)' },
      });
      expect((again.json() as Provider).api_key).toBe('[stored]');

      const cleared = await authed(hub, hub.token, {
        method: 'PATCH',
        url,
        payload: { api_key: '' },
      });
      expect((cleared.json() as Provider).api_key).toBeNull();
    } finally {
      await hub.close();
    }
  });

  it('refuses a key the provider itself refuses, in the provider’s own words', async () => {
    // The whole of the owner's 2026-09-22 episode: a key for one provider pasted into
    // another's dialog, stored without a word, written into the runtime, and surfaced
    // twelve minutes later as an agent error. The check now happens on save.
    const { fetchImpl, calls } = scriptedFetch(() => ({
      status: 401,
      json: { error: { message: 'invalid x-api-key' } },
    }));
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const refused = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'anthropic', label: 'anthropic', kind: 'llm', api_key: 'sk-wrong' },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: 'provider_unauthorized',
        // Ours says what happened; the provider's own words say why, untouched.
        details: { provider: 'anthropic', detail: 'invalid x-api-key' },
      });
      // It really asked, with the key it was given.
      expect(calls.some((call) => call.url.startsWith('https://api.anthropic.com'))).toBe(true);
      expect(calls[0]!.headers['x-api-key']).toBe('sk-wrong');
      // And nothing was stored: a refused key is not a key.
      expect(await providers(hub, hub.token)).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('tests a provider for real and reports a failure as 200 with ok: false', async () => {
    // An endpoint that answers while the key is being saved and refuses later — a
    // revoked key, a changed plan. `Test` is still the surface that says so, and a
    // failure is still a `200` carrying the provider's words.
    let accept = true;
    const { fetchImpl, calls } = scriptedFetch(() =>
      accept
        ? { json: { data: [{ id: 'claude-sonnet-4-5' }] } }
        : { status: 401, json: { error: { message: 'invalid x-api-key' } } },
    );
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-was-good' });
      await drainJobs(hub.app);
      accept = false;
      calls.length = 0;

      const tested = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${anthropic.id}/test`,
      });
      expect(tested.statusCode).toBe(200);
      const body = tested.json() as { ok: boolean; message: string; duration_ms: number };
      expect(body.ok).toBe(false);
      expect(body.message).toContain('rejected the stored key');
      expect(body.message).toContain('invalid x-api-key');
      expect(typeof body.duration_ms).toBe('number');
      expect(calls.some((call) => call.url.startsWith('https://api.anthropic.com'))).toBe(true);
      expect(calls[0]!.headers['x-api-key']).toBe('sk-was-good');

      // And the self-check says so too: a provider that refused its last check is a
      // reason the runtime is not ready, visible without reading a log.
      const report = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/runtime' })
      ).json() as { checks: { id: string; ok: boolean; detail: string | null }[] };
      const verified = report.checks.find((c) => c.id === 'provider_verified')!;
      expect(verified.ok).toBe(false);
      expect(verified.detail).toBe('anthropic');
    } finally {
      await hub.close();
    }
  });

  it('removes any provider the workspace added, preset or custom', async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: {
          label: 'خادم محلي',
          kind: 'llm',
          base_url: 'http://ollama.local:11434/v1',
          api_mode: 'chat_completions',
        },
      });
      expect(created.statusCode).toBe(201);
      const custom = created.json() as Provider;
      expect(custom.builtin).toBe(false);
      expect(custom.slug.startsWith('custom')).toBe(true);
      await drainJobs(hub.app);

      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${custom.id}`,
      });
      expect(removed.statusCode).toBe(204);

      // A preset provider is not a fixture of the workspace either: what a person added,
      // a person removes, and it goes back to being an offer in the preset list.
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-added-then-removed' });
      const gone = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${anthropic.id}`,
      });
      expect(gone.statusCode).toBe(204);
      expect(await providers(hub, hub.token)).toEqual([]);

      // And it can be added again, key and all.
      const again = await addProvider(hub, 'anthropic', { api_key: 'sk-added-again' });
      expect(again.api_key).toBe('[stored]');
      expect(again.models).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('refuses to add the same preset twice, and says which one', async () => {
    const hub = await signedInHub();
    try {
      await addProvider(hub, 'lmstudio');
      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'lmstudio', label: 'LM Studio', kind: 'llm' },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        code: 'conflict',
        details: { reason: 'provider_exists', detail: expect.stringContaining('lmstudio') },
      });
    } finally {
      await hub.close();
    }
  });

  it('refuses a preset it does not know, and lists the ones it does', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'not-a-provider', label: 'x', kind: 'llm' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'validation_failed' });
    } finally {
      await hub.close();
    }
  });
});

/**
 * The local providers, which is what the owner asked for first: a model server on his
 * own machine, reached with no key at all — and the defect of 2026-09-22, where a
 * provider that needed no key was told it was missing one and given nowhere to type it.
 */
describe('models: a local provider, with no key and with one', () => {
  /** LM Studio's OpenAI-compatible surface, answering `GET /v1/models` to anybody. */
  function lmStudio(host = 'http://host.docker.internal:1234/v1') {
    return scriptedFetch((url) =>
      url === `${host}/models`
        ? {
            json: {
              data: [{ id: 'qwen2.5-coder-7b-instruct' }, { id: 'nomic-embed-text-v1.5' }],
            },
          }
        : { status: 503, json: { error: 'not part of this test' } },
    );
  }

  it('goes from add to fetched models to default, without a key anywhere', async () => {
    const { fetchImpl, calls } = lmStudio();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      // 1. Fetch, in the dialog, before anything is saved.
      const probed = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/provider-probes',
        payload: { preset: 'lmstudio', base_url: 'http://host.docker.internal:1234/v1' },
      });
      expect(probed.statusCode).toBe(200);
      const probe = probed.json() as {
        ok: boolean;
        message: string | null;
        models: { id: string }[];
      };
      expect(probe.ok).toBe(true);
      expect(probe.message).toBeNull();
      expect(probe.models.map((m) => m.id)).toContain('qwen2.5-coder-7b-instruct');
      // Nothing was stored by a probe.
      expect(await providers(hub, hub.token)).toEqual([]);
      // And it was asked with no Authorization header at all.
      expect(calls[0]!.headers.authorization).toBeUndefined();

      // 2. Add it — no key, no complaint.
      const added = await addProvider(hub, 'lmstudio', {
        base_url: 'http://host.docker.internal:1234/v1',
      });
      expect(added.auth).toEqual({ kind: 'none', signed_in: true });
      expect(added.api_key).toBeNull();
      await drainJobs(hub.app);

      // 3. The model list arrived by itself, from the provider's own endpoint.
      const row = bySlug(await providers(hub, hub.token), 'lmstudio');
      expect(row.catalogue.error).toBeNull();
      expect(row.catalogue.status).toBe('ready');
      expect(row.models.map((m) => m.model)).toContain('qwen2.5-coder-7b-instruct');

      // 4. Test says the provider answered — never that a key is missing.
      const tested = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${row.id}/test`,
      });
      const outcome = tested.json() as { ok: boolean; message: string };
      expect(outcome.ok).toBe(true);
      expect(outcome.message).not.toContain('key');

      // 5. And it can be the workspace default.
      const defaults = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: row.id, model: 'qwen2.5-coder-7b-instruct' } },
      });
      expect(defaults.statusCode).toBe(200);
      expect((defaults.json() as { default: { model: string } }).default.model).toBe(
        'qwen2.5-coder-7b-instruct',
      );
    } finally {
      await hub.close();
    }
  });

  it('never invents "missing key" for a keyless provider, and always takes one', async () => {
    // The owner's own case: `cli-proxy-api`, added as a custom OpenAI-compatible
    // endpoint, which turns out to want a key after all.
    let key: string | null = null;
    const { fetchImpl } = scriptedFetchWithAuth('http://cli-proxy-api:8317/v1/models', () => key, {
      data: [{ id: 'gemini-2.5-pro' }],
    });
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: {
          label: 'cli-proxy-api',
          kind: 'llm',
          base_url: 'http://cli-proxy-api:8317/v1',
          api_mode: 'chat_completions',
        },
      });
      expect(created.statusCode).toBe(201);
      const custom = created.json() as Provider;
      // The card's badge and the card's error can no longer contradict each other: the
      // hub demands no key (`kind: none`) and therefore never reports one as missing.
      expect(custom.auth).toEqual({ kind: 'none', signed_in: true });
      await drainJobs(hub.app);

      const before = bySlug(await providers(hub, hub.token), custom.slug);
      // The upstream 401 is the only thing allowed to mention a key, in its own words.
      expect(before.catalogue.error).toContain('missing api key');
      const failed = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${custom.id}/test`,
      });
      const outcome = failed.json() as { ok: boolean; message: string };
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('missing api key');
      // Not our sentence for "no key is stored" — that check is gone for these providers.
      expect(outcome.message).not.toContain('No API key is stored');

      // And a key can be typed on exactly this provider, which is what was impossible.
      key = 'proxy-master-key';
      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${custom.id}`,
        payload: { api_key: 'proxy-master-key' },
      });
      expect(saved.statusCode).toBe(200);
      const withKey = saved.json() as Provider;
      expect(withKey.api_key).toBe('[stored]');
      // Still "no key required" — storing one does not change what the endpoint demands,
      // and the badge stays honest instead of flipping to "needs a key".
      expect(withKey.auth).toEqual({ kind: 'none', signed_in: true });
      await drainJobs(hub.app);

      const passed = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${custom.id}/test`,
      });
      expect((passed.json() as { ok: boolean }).ok).toBe(true);
      expect(
        bySlug(await providers(hub, hub.token), custom.slug).models.map((m) => m.model),
      ).toEqual(['gemini-2.5-pro']);
    } finally {
      await hub.close();
    }
  });

  it('reports a probe of an endpoint that is not listening as a failure, not an empty list', async () => {
    const { fetchImpl } = scriptedFetch(() => ({ status: 502, text: 'Bad Gateway' }));
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const probed = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/provider-probes',
        payload: { base_url: 'http://127.0.0.1:1234/v1' },
      });
      expect(probed.statusCode).toBe(200);
      const probe = probed.json() as { ok: boolean; message: string; models: unknown[] };
      expect(probe.ok).toBe(false);
      expect(probe.models).toEqual([]);
      expect(probe.message).toContain('Bad Gateway');
    } finally {
      await hub.close();
    }
  });

  it('refuses to probe or add a LiteLLM proxy with no address', async () => {
    const hub = await signedInHub();
    try {
      const probed = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/provider-probes',
        payload: { preset: 'litellm' },
      });
      expect(probed.statusCode).toBe(400);
      const added = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'litellm', label: 'LiteLLM', kind: 'llm' },
      });
      expect(added.statusCode).toBe(400);
      expect(added.json()).toMatchObject({ code: 'validation_failed' });
    } finally {
      await hub.close();
    }
  });
});

describe('models: catalogue and defaults', () => {
  async function hubWithModels() {
    const { fetchImpl } = anthropicOnly();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant-scripted' });
    await drainJobs(hub.app);
    return { hub, providerId: anthropic.id };
  }

  it('lists the flat catalogue the pickers use', async () => {
    const { hub, providerId } = await hubWithModels();
    try {
      const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models' });
      expect(response.statusCode).toBe(200);
      const page = response.json() as {
        items: { key: string; provider: string; kind: string; disabled: boolean }[];
        next_cursor: string | null;
      };
      // Ordered by provider then model id, so two identical requests agree.
      expect(page.items.map((m) => m.key)).toEqual([
        'anthropic/claude-haiku-4-5',
        'anthropic/claude-sonnet-4-5',
      ]);
      expect(page.next_cursor).toBeNull();

      const firstPage = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models?limit=1',
      });
      const one = firstPage.json() as { items: { key: string }[]; next_cursor: string | null };
      expect(one.items.map((m) => m.key)).toEqual(['anthropic/claude-haiku-4-5']);
      expect(one.next_cursor).not.toBeNull();
      const nextPage = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/models?limit=1&cursor=${encodeURIComponent(one.next_cursor!)}`,
      });
      expect((nextPage.json() as { items: { key: string }[] }).items.map((m) => m.key)).toEqual([
        'anthropic/claude-sonnet-4-5',
      ]);

      const filtered = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/models?q=haiku&provider_id=${providerId}`,
      });
      expect((filtered.json() as { items: unknown[] }).items).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('sets an alias and a visibility, and registers a model the provider does not list', async () => {
    const { hub, providerId } = await hubWithModels();
    try {
      const aliased = await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/models/providers/${providerId}/models/claude-sonnet-4-5`,
        payload: { alias: 'سونيت', context_window: 200000 },
      });
      expect(aliased.statusCode).toBe(200);
      expect(aliased.json()).toMatchObject({ alias: 'سونيت', context_window: 200000 });

      const unknown = await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/models/providers/${providerId}/models/claude-experimental-9`,
        payload: { alias: null },
      });
      // Without `custom: true` the hub does not invent a model.
      expect(unknown.statusCode).toBe(404);

      const added = await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/models/providers/${providerId}/models/claude-experimental-9`,
        payload: { custom: true },
      });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toMatchObject({ custom: true, model: 'claude-experimental-9' });

      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${providerId}/models/claude-experimental-9`,
      });
      expect(removed.statusCode).toBe(204);
    } finally {
      await hub.close();
    }
  });

  it('stores the chat default and the coding assignment, and refuses an unknown model', async () => {
    const { hub, providerId } = await hubWithModels();
    try {
      const saved = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: {
          default: { provider_id: providerId, model: 'claude-sonnet-4-5' },
          fallbacks: [{ provider_id: providerId, model: 'claude-haiku-4-5' }],
          assignments: {
            coding: { provider_id: providerId, model: 'claude-sonnet-4-5' },
            title: { provider_id: providerId, model: 'claude-haiku-4-5' },
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      const defaults = saved.json() as {
        default: { model: string };
        fallbacks: { model: string }[];
        auxiliary: { tasks: { key: string }[]; assignments: Record<string, { model: string }> };
      };
      expect(defaults.default.model).toBe('claude-sonnet-4-5');
      expect(defaults.fallbacks.map((f) => f.model)).toEqual(['claude-haiku-4-5']);
      expect(defaults.auxiliary.tasks.map((t) => t.key)).toEqual([
        'coding',
        'title',
        'summary',
        'embedding',
      ]);
      expect(defaults.auxiliary.assignments.coding!.model).toBe('claude-sonnet-4-5');

      const rejected = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: providerId, model: 'a-model-nobody-has' } },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ code: 'validation_failed' });
    } finally {
      await hub.close();
    }
  });

  it('keeps at most one active ensemble and needs an aggregator', async () => {
    const { hub, providerId } = await hubWithModels();
    try {
      const member = { provider_id: providerId, model: 'claude-sonnet-4-5' };
      const aggregator = { provider_id: providerId, model: 'claude-haiku-4-5' };

      const incomplete = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/ensembles',
        payload: { name: 'بلا مجمِّع', members: [member] },
      });
      expect(incomplete.statusCode).toBe(400);

      const first = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/ensembles',
        payload: { name: 'ثلاثة آراء', members: [member], aggregator, active: true },
      });
      expect(first.statusCode).toBe(201);
      const second = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/ensembles',
        payload: { name: 'رأيان', members: [member], aggregator, active: true },
      });
      expect(second.statusCode).toBe(201);

      const listed = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models/ensembles',
      });
      const items = (listed.json() as { items: { name: string; active: boolean }[] }).items;
      expect(items.filter((e) => e.active).map((e) => e.name)).toEqual(['رأيان']);

      const deleted = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/ensembles/${(second.json() as { id: string }).id}`,
      });
      expect(deleted.statusCode).toBe(204);
    } finally {
      await hub.close();
    }
  });
});

describe('models: speech', () => {
  it('reports why dictation is not possible instead of an empty screen', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models/speech',
      });
      expect(response.statusCode).toBe(200);
      const speech = response.json() as {
        stt: { ready: boolean; reason: string | null; providers: { slug: string }[] };
        tts: { ready: boolean; reason: string | null; providers: { slug: string }[] };
      };
      expect(speech.stt.ready).toBe(false);
      // A sentence in the request's language, as the contract's example shows — the key
      // stays inside the server (`models/index.ts` §localiseSpeech).
      expect(speech.stt.reason).toBe('No speech-to-text provider is chosen.');
      // Nothing was added yet, so there is nothing to choose from — and the screen says
      // why rather than drawing an empty list.
      expect(speech.stt.providers).toEqual([]);

      // Adding OpenAI on the chat tab is what puts dictation and speech on the others.
      await addProvider(hub, 'openai', { api_key: 'sk-openai-once' });
      const after = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models/speech',
      });
      const filled = after.json() as typeof speech;
      expect(filled.stt.providers.map((p) => p.slug)).toEqual(['openai-stt']);
      expect(filled.tts.providers.map((p) => p.slug)).toEqual(['openai-tts']);
    } finally {
      await hub.close();
    }
  });

  it('becomes ready once a provider is chosen and its family has a key', async () => {
    const hub = await signedInHub();
    try {
      await addProvider(hub, 'openai', { api_key: 'sk-openai-chat' });
      const tts = bySlug(await providers(hub, hub.token), 'openai-tts');
      const updated = await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/models/speech',
        payload: {
          tts_provider_id: tts.id,
          providers: [
            { id: tts.id, api_key: 'sk-openai-for-speech', settings: { voice: 'alloy' } },
          ],
        },
      });
      expect(updated.statusCode).toBe(200);
      const speech = updated.json() as {
        tts: {
          ready: boolean;
          reason: string | null;
          providers: { id: string; api_key: string | null; settings: { voice: string | null } }[];
        };
      };
      expect(speech.tts.ready).toBe(true);
      expect(speech.tts.reason).toBeNull();
      const row = speech.tts.providers.find((p) => p.id === tts.id)!;
      expect(row.api_key).toBe('[stored]');
      expect(row.settings.voice).toBe('alloy');
      expect(updated.body).not.toContain('sk-openai-for-speech');
    } finally {
      await hub.close();
    }
  });

  it('answers 422 for synthesis with no provider chosen, never silence', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/speech/speech',
        payload: { text: 'اكتملت الاختبارات بنجاح.' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'agent_unavailable' });
    } finally {
      await hub.close();
    }
  });

  it('returns audio bytes and names the provider that spoke', async () => {
    const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]);
    const fetchImpl = ((url: string) => {
      if (String(url).includes('/audio/speech')) {
        return Promise.resolve(
          new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 503 }));
    }) as unknown as typeof fetch;

    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      await addProvider(hub, 'openai', { api_key: 'sk-openai-chat' });
      const tts = bySlug(await providers(hub, hub.token), 'openai-tts');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/models/speech',
        payload: {
          tts_provider_id: tts.id,
          providers: [{ id: tts.id, api_key: 'sk-speech', settings: { voice: 'alloy' } }],
        },
      });

      const spoken = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/speech/speech',
        payload: { text: 'اكتملت الاختبارات بنجاح.', language: 'ar' },
      });
      expect(spoken.statusCode).toBe(200);
      expect(spoken.headers['x-speech-provider']).toBe('openai-tts');
      expect(spoken.headers['content-type']).toContain('audio/mpeg');
      expect(spoken.rawPayload.equals(audio)).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it('is still a documented 501 for transcription, with the reason', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/speech/transcriptions',
        payload: {},
      });
      expect(response.statusCode).toBe(501);
      // Not the app's generic stub: the route says which gap it is waiting on.
      expect(response.json()).toMatchObject({
        code: 'not_implemented',
        error: expect.stringContaining('audio upload') as unknown as string,
      });
    } finally {
      await hub.close();
    }
  });

  it('is still a documented 501 for OAuth sign-in, because no provider uses it yet', async () => {
    const hub = await signedInHub();
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant-for-signin' });
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${anthropic.id}/sign-in`,
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({
        code: 'not_implemented',
        error: expect.stringContaining('API key') as unknown as string,
      });
    } finally {
      await hub.close();
    }
  });
});

// ------------------------------------------------- the point of the whole module

describe('models: one key, every agent (ADR 0010)', () => {
  it('starts a coding agent with the shared key without any per-agent setup', async () => {
    const { fetchImpl } = anthropicOnly();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      // 1. The owner adds Anthropic and pastes its key, once, on the Models screen.
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant-the-one-key' });
      await drainJobs(hub.app);

      // 2. He picks a coding model. He never opens an agent's settings.
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: {
          default: { provider_id: anthropic.id, model: 'claude-sonnet-4-5' },
          assignments: { coding: { provider_id: anthropic.id, model: 'claude-haiku-4-5' } },
        },
      });

      // 3. Claude Code — a catalog entry nobody configured — is started.
      const agents = agentsServiceFor(hub.app);
      const workspaceId = await workspaceIdOf(hub);
      const claudeCode = agents.loadAgentBySlug('claude-code');
      const target = agents.targetFor(claudeCode, workspaceId, {
        sessionRef: null,
        cwd: null,
        model: null,
        reasoningEffort: null,
      });

      // It has the key, under the name it reads, and the coding model.
      expect(target.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-the-one-key' });
      expect(target.model).toBe('claude-haiku-4-5');

      // The Gemini CLI declared a different family: it gets nothing, not the wrong key.
      const gemini = agents.targetFor(agents.loadAgentBySlug('gemini-cli'), workspaceId, {
        sessionRef: null,
        cwd: null,
        model: null,
        reasoningEffort: null,
      });
      expect(gemini.env).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it('shows on every agent card which model it inherited', async () => {
    const { fetchImpl } = anthropicOnly();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant-the-one-key' });
      await drainJobs(hub.app);
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: anthropic.id, model: 'claude-sonnet-4-5' } },
      });

      const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      const items = (
        listed.json() as {
          items: { slug: string; default_model: { provider_id: string; model: string } | null }[];
        }
      ).items;
      // Hermes takes the chat default; a coding agent falls back to it when no coding
      // assignment was made.
      expect(items.find((a) => a.slug === 'hermes')!.default_model).toEqual({
        provider_id: anthropic.id,
        model: 'claude-sonnet-4-5',
      });
      expect(items.find((a) => a.slug === 'claude-code')!.default_model).toEqual({
        provider_id: anthropic.id,
        model: 'claude-sonnet-4-5',
      });
    } finally {
      await hub.close();
    }
  });

  it('writes the key and the model into the Hermes home this hub supervises', async () => {
    const { fetchImpl } = anthropicOnly();
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    let restarts = 0;
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          hermes: {
            home: () => home,
            restart: () => {
              restarts += 1;
              return Promise.resolve(true);
            },
          },
        },
      },
    );
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant-for-hermes' });
      await drainJobs(hub.app);

      // The key landed in Hermes's own `.env`, under the name Hermes reads it from.
      const env = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(env.get('ANTHROPIC_API_KEY')).toBe('sk-ant-for-hermes');
      // One restart, not one per write: the key, the model list and the default that
      // follows from them are one action to the person who saved the provider.
      await settle();
      expect(restarts).toBe(1);

      // The chat default landed in `config.yaml`, as Hermes's own `model` mapping.
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: anthropic.id, model: 'claude-sonnet-4-5' } },
      });
      const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
      expect(config).toContain('default: claude-sonnet-4-5');
      // Hermes's own slug, not ours: its `openai` means OpenRouter (ADR 0010 §3).
      expect(config).toContain('provider: anthropic');
    } finally {
      await hub.close();
    }
  });

  it('gives Hermes a providers: block for an endpoint it ships no provider for', async () => {
    // Groq is not one of Hermes's chat providers — before this, the hub logged "no slug"
    // and wrote nothing, so a workspace whose default was Groq ran on nothing at all.
    // Hermes does understand an arbitrary OpenAI-compatible endpoint, named under
    // `providers:` and pointed at by `model.provider` (ADR 0010, re-read 2026-09-22).
    const groqModels = scriptedFetch((url) =>
      url.startsWith('https://api.groq.com')
        ? { json: { data: [{ id: 'llama-3.3-70b-versatile' }] } }
        : { status: 503, json: {} },
    );
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: groqModels.fetchImpl,
          hermes: { home: () => home, restart: () => Promise.resolve(true) },
        },
      },
    );
    try {
      const groq = await addProvider(hub, 'groq', { api_key: 'gsk-scripted' });
      await drainJobs(hub.app);

      // The key still goes across under the name the world knows it by…
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).get('GROQ_API_KEY')).toBe(
        'gsk-scripted',
      );
      // …and now the endpoint does too, prefixed so it cannot collide with one of
      // Hermes's own provider names.
      const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
      expect(config).toContain('corehub-groq:');
      expect(config).toContain('base_url: https://api.groq.com/openai/v1');
      expect(config).toContain('key_env: GROQ_API_KEY');

      // Its first model became the workspace chat default with nobody asking, and that
      // is what Hermes is told to run.
      const defaults = await authed(hub, hub.token, { url: '/api/v1/models/defaults' });
      expect(
        (defaults.json() as { default: { provider_id: string; model: string } }).default,
      ).toEqual({ provider_id: groq.id, model: 'llama-3.3-70b-versatile' });
      expect(config).toContain('default: llama-3.3-70b-versatile');
      expect(config).toContain('provider: corehub-groq');
    } finally {
      await hub.close();
    }
  });

  it("declares the endpoint in every Hermes profile's config too, and nothing else there", async () => {
    // A conversation runs in its workspace's own Hermes profile (ADR 0014 stage 3), which
    // reads its own `config.yaml`: a turn that names `corehub-groq` must find it there. The
    // key is not copied — it reaches every profile through the process environment.
    const groqModels = scriptedFetch((url) =>
      url.startsWith('https://api.groq.com')
        ? { json: { data: [{ id: 'llama-3.3-70b-versatile' }] } }
        : { status: 503, json: {} },
    );
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const design = path.join(home, 'profiles', 'design');
    mkdirSync(design, { recursive: true });
    writeFileSync(
      path.join(design, 'config.yaml'),
      '# design profile\nmodel:\n  default: its-own-model\n  provider: anthropic\n',
    );
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: groqModels.fetchImpl,
          hermes: {
            home: () => home,
            profileHomes: () => [design],
            restart: () => Promise.resolve(true),
          },
        },
      },
    );
    try {
      await addProvider(hub, 'groq', { api_key: 'gsk-scripted' });
      await drainJobs(hub.app);
      const config = readFileSync(path.join(design, 'config.yaml'), 'utf8');
      expect(config).toContain('# design profile');
      expect(config).toContain('corehub-groq:');
      expect(config).toContain('base_url: https://api.groq.com/openai/v1');
      expect(config).toContain('key_env: GROQ_API_KEY');
      // The profile's own model is its own; the hub names a model on every turn.
      expect(config).toContain('default: its-own-model');
      expect(config).not.toContain('llama-3.3-70b-versatile');
      expect(existsSync(path.join(design, '.env'))).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it('sets the first chat default once, and a second provider never steals it', async () => {
    const both = scriptedFetch((url) =>
      url.startsWith('https://api.anthropic.com')
        ? { json: { data: [{ id: 'claude-sonnet-4-5' }] } }
        : url.startsWith('https://api.groq.com')
          ? { json: { data: [{ id: 'llama-3.3-70b-versatile' }] } }
          : { status: 503, json: {} },
    );
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: both.fetchImpl,
          hermes: { home: () => home, restart: () => Promise.resolve(true) },
        },
      },
    );
    try {
      const anthropic = await addProvider(hub, 'anthropic', { api_key: 'sk-ant' });
      await drainJobs(hub.app);
      const first = (
        (await authed(hub, hub.token, { url: '/api/v1/models/defaults' })).json() as {
          default: { provider_id: string; model: string };
        }
      ).default;
      expect(first).toEqual({ provider_id: anthropic.id, model: 'claude-sonnet-4-5' });

      await addProvider(hub, 'groq', { api_key: 'gsk' });
      await drainJobs(hub.app);
      const after = (
        (await authed(hub, hub.token, { url: '/api/v1/models/defaults' })).json() as {
          default: { provider_id: string; model: string };
        }
      ).default;
      // The owner's first choice survives: a provider added later is available, not
      // promoted.
      expect(after).toEqual(first);
    } finally {
      await hub.close();
    }
  });

  it('carries a local, keyless provider to Hermes as an endpoint it can call', async () => {
    // LM Studio needs no key and Hermes ships no provider for it — but Hermes *is* one of
    // its canonical provider names, so an unprefixed `providers:` block would be ignored
    // outright (`runtime_provider_custom.py` §_shadowed_by_builtin).
    const lm = scriptedFetch((url) =>
      url.startsWith('http://127.0.0.1:1234/v1')
        ? { json: { data: [{ id: 'qwen3-30b' }] } }
        : { status: 503, json: {} },
    );
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: lm.fetchImpl,
          hermes: { home: () => home, restart: () => Promise.resolve(true) },
        },
      },
    );
    try {
      await addProvider(hub, 'lmstudio', { base_url: 'http://127.0.0.1:1234/v1' });
      await drainJobs(hub.app);
      const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
      expect(config).toContain('corehub-lmstudio:');
      expect(config).toContain('base_url: http://127.0.0.1:1234/v1');
      expect(config).toContain('provider: corehub-lmstudio');
      expect(config).toContain('default: qwen3-30b');
      // Nothing was invented for a provider that takes no key: the variable is named in
      // the block so a key added later needs no second screen, and the file holds none.
      expect(config).toContain('key_env: COREHUB_PROVIDER_LMSTUDIO_API_KEY');
      // And no `.env` at all: a file holding only the marker is a file that says nothing,
      // and the next merge would append a second marker above the first variable.
      expect(() => readFileSync(path.join(home, '.env'), 'utf8')).toThrow();
    } finally {
      await hub.close();
    }
  });

  it('carries somebody’s own endpoint, key and all, under a name minted for it', async () => {
    // The repeatable `openai-compatible` preset: its row has a slug of its own and **no
    // catalogue entry at all**, which is exactly the shape that used to reach Hermes as
    // nothing — no variable name, no slug, no block.
    const mine = scriptedFetchWithAuth('https://lab.example/v1/models', () => 'sk-my-own', {
      data: [{ id: 'my-model' }],
    });
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: mine.fetchImpl,
          hermes: { home: () => home, restart: () => Promise.resolve(true) },
        },
      },
    );
    try {
      const provider = await addProvider(hub, 'openai-compatible', {
        label: 'Lab',
        base_url: 'https://lab.example/v1',
        api_key: 'sk-my-own',
      });
      expect(provider.slug).toBe('custom-lab');
      await drainJobs(hub.app);

      const variable = 'COREHUB_PROVIDER_CUSTOM_LAB_API_KEY';
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).get(variable)).toBe(
        'sk-my-own',
      );
      const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
      expect(config).toContain('corehub-custom-lab:');
      expect(config).toContain('base_url: https://lab.example/v1');
      expect(config).toContain(`key_env: ${variable}`);
      expect(config).toContain('provider: corehub-custom-lab');
      expect(config).toContain('default: my-model');
    } finally {
      await hub.close();
    }
  });

  it('rewrites the Hermes home at boot when the volume no longer matches the rows', async () => {
    // A restored backup, an image upgrade, a hand-edited config: the rows are right and
    // the files are not. Writing only on change meant that state could never heal.
    const { fetchImpl } = anthropicOnly();
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hermes = { home: () => home, restart: () => Promise.resolve(true) };

    const first = await signedInHub({}, { models: { fetchImpl, hermes } });
    const dataDir = first.dataDir;
    try {
      await addProvider(first, 'anthropic', { api_key: 'sk-ant-boot' });
      await drainJobs(first.app);
      expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('provider: anthropic');
    } finally {
      // Not `close()`: the data volume has to survive for the second boot.
      await first.app.close();
    }

    rmSync(path.join(home, '.env'), { force: true });
    rmSync(path.join(home, 'config.yaml'), { force: true });

    const second = await signedInHub({ DATA_DIR: dataDir }, { models: { fetchImpl, hermes } });
    try {
      // Any request drives Fastify's `onReady`, which is where the reconciliation runs.
      await authed(second, second.token, { method: 'GET', url: '/api/v1/models/providers' });
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).get('ANTHROPIC_API_KEY')).toBe(
        'sk-ant-boot',
      );
      const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
      expect(config).toContain('provider: anthropic');
      expect(config).toContain('default: claude-haiku-4-5');
    } finally {
      await second.close();
    }
  });

  it('keeps a model id exactly as the provider spelled it, slashes and suffixes and all', async () => {
    // OpenRouter's router ids carry a vendor prefix and a `:free` suffix; the catalogue
    // key the client holds adds a second prefix of our own. Neither may reach the wire
    // rewritten: a provider's id is opaque to us (the owner's report of 2026-09-22).
    const ids = ['openrouter/free', 'z-ai/glm-5.2:free'];
    const or = scriptedFetch((url) =>
      url.startsWith('https://openrouter.ai')
        ? { json: { data: ids.map((id) => ({ id })) } }
        : { status: 503, json: {} },
    );
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: or.fetchImpl,
          hermes: { home: () => home, restart: () => Promise.resolve(true) },
        },
      },
    );
    try {
      const provider = await addProvider(hub, 'openrouter', { api_key: 'sk-or-v1-scripted' });
      await drainJobs(hub.app);

      // Stored byte for byte, and offered to a client as `<slug>/<id>` — two prefixes,
      // neither of which is part of the id.
      const catalogue = (
        (await authed(hub, hub.token, { url: '/api/v1/models', method: 'GET' })).json() as {
          items: { key: string; model: string }[];
        }
      ).items;
      expect(catalogue.map((m) => m.model).sort()).toEqual([...ids].sort());
      expect(catalogue.find((m) => m.model === 'openrouter/free')!.key).toBe(
        'openrouter/openrouter/free',
      );

      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: provider.id, model: 'z-ai/glm-5.2:free' } },
      });
      const config = readFileSync(path.join(home, 'config.yaml'), 'utf8');
      expect(config).toContain('default: z-ai/glm-5.2:free');
      expect(config).toContain('provider: openrouter');
    } finally {
      await hub.close();
    }
  });

  it('refuses a chat default the runtime could not be told about, out loud', async () => {
    // Silence was the defect: the hub logged one line, wrote nothing, and the run went
    // out on a different provider's configuration.
    const eleven = scriptedFetch(() => ({ status: 503, json: {} }));
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: eleven.fetchImpl,
          hermes: { home: () => home, restart: () => Promise.resolve(true) },
        },
      },
    );
    try {
      const tts = await addProvider(hub, 'elevenlabs', { api_key: 'el-key', kind: 'tts' });
      await authed(hub, hub.token, {
        method: 'PUT',
        url: `/api/v1/models/providers/${tts.id}/models/${encodeURIComponent('eleven_v3')}`,
        payload: { custom: true },
      });
      const refused = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: tts.id, model: 'eleven_v3' } },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        code: 'validation_failed',
        details: { field: 'default', provider: 'elevenlabs' },
      });
    } finally {
      await hub.close();
    }
  });

  it('shows, check by check, whether the runtime actually took any of it', async () => {
    const { fetchImpl } = anthropicOnly();
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    let startedAt: number | null = null;
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          hermes: {
            home: () => home,
            mode: () => 'managed',
            reloadedAt: () => startedAt,
            restart: () => {
              startedAt = Date.now();
              return Promise.resolve(true);
            },
          },
        },
      },
    );
    const report = async () =>
      (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/runtime' })).json() as {
        ready: boolean;
        mode: string;
        checks: { id: string; ok: boolean; detail: string | null }[];
      };
    const check = (r: Awaited<ReturnType<typeof report>>, id: string) =>
      r.checks.find((c) => c.id === id)!;
    try {
      // Before anything is configured: a runtime to write to, and nothing written.
      const empty = await report();
      expect(empty.mode).toBe('managed');
      expect(empty.ready).toBe(false);
      expect(check(empty, 'runtime_writable').ok).toBe(true);
      expect(check(empty, 'model_selected').ok).toBe(false);

      await addProvider(hub, 'anthropic', { api_key: 'sk-ant-report' });
      await drainJobs(hub.app);
      await settle();
      const after = await report();
      expect(check(after, 'provider_keys').ok).toBe(true);
      expect(check(after, 'model_selected').ok).toBe(true);
      // The value is the pair the runtime was given, in its own vocabulary.
      expect(check(after, 'model_selected').detail).toBe('anthropic/claude-haiku-4-5');
      expect(check(after, 'gateway_reloaded').ok).toBe(true);
      expect(after.ready).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it('waits for a turn to finish before recycling the runtime', async () => {
    const { fetchImpl } = anthropicOnly();
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-home-'));
    homes.push(home);
    let restarts = 0;
    let busy = true;
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          hermes: {
            home: () => home,
            busy: () => busy,
            restart: () => {
              restarts += 1;
              return Promise.resolve(true);
            },
          },
        },
      },
    );
    try {
      await addProvider(hub, 'anthropic', { api_key: 'sk-ant-busy' });
      await drainJobs(hub.app);
      await settle();
      // The files are written; the process is not interrupted mid-turn.
      expect(readFileSync(path.join(home, '.env'), 'utf8')).toContain('ANTHROPIC_API_KEY');
      expect(restarts).toBe(0);
      busy = false;
      await settle();
      expect(restarts).toBe(1);
    } finally {
      await hub.close();
    }
  });

  it('writes nothing when no runtime this hub supervises has a home', async () => {
    const { fetchImpl } = anthropicOnly();
    // The suite's PATH has no `hermes`, so the runtime is `absent`.
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      await addProvider(hub, 'anthropic', { api_key: 'sk-ant-for-nobody' });
      await drainJobs(hub.app);
      expect(() => readFileSync(path.join(hub.dataDir, 'hermes', '.env'), 'utf8')).toThrow();
    } finally {
      await hub.close();
    }
  });
});

/** The workspace id behind the `default` profile, for the service-level calls above. */
async function workspaceIdOf(hub: TestHub & { token: string }): Promise<string> {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' });
  const items = (response.json() as { items: { id: string; slug: string }[] }).items;
  const found = items.find((profile) => profile.slug === 'default');
  if (!found) throw new Error('no default workspace');
  return found.id;
}

/** A gated live check: a real key, only when the owner asks for it. */
describe.skipIf(!process.env.COREHUB_LIVE_PROVIDER)('models: a live provider', () => {
  it('reaches the real provider named by COREHUB_LIVE_PROVIDER', async () => {
    const slug = process.env.COREHUB_LIVE_PROVIDER!;
    const key = process.env.COREHUB_LIVE_PROVIDER_KEY;
    expect(key, 'COREHUB_LIVE_PROVIDER_KEY must be set alongside COREHUB_LIVE_PROVIDER').toBeTruthy();
    // The real `fetch`: this is the one test in the suite that is allowed out.
    const hub = await signedInHub({}, { models: { fetchImpl: globalThis.fetch } });
    try {
      const provider = await addProvider(hub, slug, { api_key: key ?? null });
      const tested = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/models/providers/${provider.id}/test`,
      });
      expect(tested.json()).toMatchObject({ ok: true });
      await drainJobs(hub.app);
      expect(bySlug(await providers(hub, hub.token), slug).models.length).toBeGreaterThan(0);
    } finally {
      await hub.close();
    }
  }, 60_000);
});
