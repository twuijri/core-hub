/**
 * The `models` module over HTTP, and the thing the whole module exists for: the owner
 * adds a provider key **once** and every agent has it (ADR 0010).
 *
 * The scripted `fetch` below is the only provider these tests ever talk to. A real key is
 * never needed; `models-live.test.ts` is the gated exception.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { agentsServiceFor } from '../agents/index.js';
import { parseEnv } from './dotenv.js';

interface Scripted {
  status?: number;
  json?: unknown;
  text?: string;
}

function scriptedFetch(byUrl: (url: string) => Scripted): {
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
    const answer = byUrl(String(url));
    return Promise.resolve(
      new Response(answer.text ?? JSON.stringify(answer.json ?? {}), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
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

describe('models: providers over HTTP', () => {
  it('offers the bundled catalogue to a fresh workspace, all unconfigured', async () => {
    const hub = await signedInHub();
    try {
      const list = await providers(hub, hub.token);
      expect(list.map((p) => p.slug)).toContain('anthropic');
      expect(list.map((p) => p.slug)).toEqual(expect.arrayContaining(['openai-stt', 'elevenlabs']));
      for (const provider of list) {
        expect(provider.builtin).toBe(true);
        // Visible and unconfigured, never hidden (ADR 0006's rule, ADR 0010 §1).
        expect(provider.api_key).toBeNull();
        expect(provider.models).toEqual([]);
      }
      // A local runtime takes no key, so it is "signed in" from the start.
      expect(bySlug(list, 'ollama').auth).toEqual({ kind: 'none', signed_in: true });
      expect(bySlug(list, 'anthropic').auth).toEqual({ kind: 'api_key', signed_in: false });
    } finally {
      await hub.close();
    }
  });

  it('stores a key masked, never echoes it, and fetches the catalogue by itself', async () => {
    const { fetchImpl } = anthropicOnly();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
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
      const openai = bySlug(await providers(hub, hub.token), 'openai');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${openai.id}`,
        payload: { api_key: 'sk-openai-once' },
      });

      // The chat tab, the dictation tab and the speech tab are one account (ADR 0010 §2).
      const list = await providers(hub, hub.token);
      expect(bySlug(list, 'openai').api_key).toBe('[stored]');
      expect(bySlug(list, 'openai-stt').api_key).toBe('[stored]');
      expect(bySlug(list, 'openai-tts').api_key).toBe('[stored]');
      // A different account is untouched.
      expect(bySlug(list, 'anthropic').api_key).toBeNull();
    } finally {
      await hub.close();
    }
  });

  it('leaves the stored key alone when a client sends the mask back', async () => {
    const hub = await signedInHub();
    try {
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      const url = `/api/v1/models/providers/${anthropic.id}`;
      await authed(hub, hub.token, { method: 'PATCH', url, payload: { api_key: 'sk-real' } });
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

  it('tests a provider for real and reports a failure as 200 with ok: false', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({
      status: 401,
      json: { error: { message: 'invalid x-api-key' } },
    }));
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${anthropic.id}`,
        payload: { api_key: 'sk-wrong' },
      });
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
      // It really asked: this is a connectivity check, not a guess.
      expect(calls.some((call) => call.url.startsWith('https://api.anthropic.com'))).toBe(true);
      expect(calls[0]!.headers['x-api-key']).toBe('sk-wrong');
    } finally {
      await hub.close();
    }
  });

  it('creates and removes a custom provider, and refuses to remove a built-in one', async () => {
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

      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      const refused = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${anthropic.id}`,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict' });
    } finally {
      await hub.close();
    }
  });
});

describe('models: catalogue and defaults', () => {
  async function hubWithModels() {
    const { fetchImpl } = anthropicOnly();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
    await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${anthropic.id}`,
      payload: { api_key: 'sk-ant-scripted' },
    });
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
      expect(speech.stt.providers.map((p) => p.slug)).toEqual(['openai-stt']);
      expect(speech.tts.providers.map((p) => p.slug).sort()).toEqual(['elevenlabs', 'openai-tts']);
    } finally {
      await hub.close();
    }
  });

  it('becomes ready once a provider is chosen and its family has a key', async () => {
    const hub = await signedInHub();
    try {
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
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
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
      // 1. The owner pastes the Anthropic key, once, on the Models screen.
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${anthropic.id}`,
        payload: { api_key: 'sk-ant-the-one-key' },
      });
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
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${anthropic.id}`,
        payload: { api_key: 'sk-ant-the-one-key' },
      });
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
    const home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-home-'));
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
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${anthropic.id}`,
        payload: { api_key: 'sk-ant-for-hermes' },
      });
      await drainJobs(hub.app);

      // The key landed in Hermes's own `.env`, under the name Hermes reads it from.
      const env = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(env.get('ANTHROPIC_API_KEY')).toBe('sk-ant-for-hermes');
      expect(restarts).toBeGreaterThan(0);

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

  it('leaves Hermes alone for a provider it has no slug for, and says so', async () => {
    const groqModels = scriptedFetch((url) =>
      url.startsWith('https://api.groq.com')
        ? { json: { data: [{ id: 'llama-3.3-70b-versatile' }] } }
        : { status: 503, json: {} },
    );
    const home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-home-'));
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
      const groq = bySlug(await providers(hub, hub.token), 'groq');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${groq.id}`,
        payload: { api_key: 'gsk-scripted' },
      });
      await drainJobs(hub.app);
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        payload: { default: { provider_id: groq.id, model: 'llama-3.3-70b-versatile' } },
      });

      // Hermes reads GROQ_API_KEY (for Whisper), so the key still goes across…
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).get('GROQ_API_KEY')).toBe(
        'gsk-scripted',
      );
      // …but Groq is not one of its chat providers, so no model selection is invented.
      expect(() => readFileSync(path.join(home, 'config.yaml'), 'utf8')).toThrow();
    } finally {
      await hub.close();
    }
  });

  it('writes nothing when no runtime this hub supervises has a home', async () => {
    const { fetchImpl } = anthropicOnly();
    // The suite's PATH has no `hermes`, so the runtime is `absent`.
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const anthropic = bySlug(await providers(hub, hub.token), 'anthropic');
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${anthropic.id}`,
        payload: { api_key: 'sk-ant-for-nobody' },
      });
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
describe.skipIf(!process.env.MAJLIS_LIVE_PROVIDER)('models: a live provider', () => {
  it('reaches the real provider named by MAJLIS_LIVE_PROVIDER', async () => {
    const slug = process.env.MAJLIS_LIVE_PROVIDER!;
    const key = process.env.MAJLIS_LIVE_PROVIDER_KEY;
    expect(key, 'MAJLIS_LIVE_PROVIDER_KEY must be set alongside MAJLIS_LIVE_PROVIDER').toBeTruthy();
    // The real `fetch`: this is the one test in the suite that is allowed out.
    const hub = await signedInHub({}, { models: { fetchImpl: globalThis.fetch } });
    try {
      const provider = bySlug(await providers(hub, hub.token), slug);
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${provider.id}`,
        payload: { api_key: key },
      });
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
