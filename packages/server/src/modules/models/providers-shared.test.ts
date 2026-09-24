/**
 * Providers belong to the hub, not to a profile (decision §SHARED of
 * `docs/contracts/DECISIONS.md`, ADR 0010).
 *
 * The owner adds a provider **once** and every agent in every profile uses it — a profile
 * made a minute later included. What stays per profile is the *choice* of model: a
 * profile may pick its own chat default, and one that picked none uses the default
 * profile's. Hermes's default profile keeps its own selection whichever profile somebody
 * happened to be in when they saved a provider.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { authed, drainJobs, settle, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { agentsServiceFor } from '../agents/index.js';
import { parseEnv } from './dotenv.js';
import { modelsServiceFor } from './index.js';

type Hub = TestHub & { token: string };

interface Provider {
  id: string;
  slug: string;
  profile: string;
  api_key: string | null;
  models: { model: string; key: string }[];
}

/** Anthropic and Groq list their models; Groq also streams one reply. */
function twoProviders(): { fetchImpl: typeof fetch; auth: string[] } {
  const auth: string[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      return json({
        data: [
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
        ],
        has_more: false,
      });
    }
    if (url.startsWith('https://api.groq.com/openai/v1/models')) {
      return json({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    }
    if (url.startsWith('https://api.groq.com/openai/v1/chat/completions')) {
      auth.push(headers.Authorization ?? headers.authorization ?? '');
      const frames = [
        { choices: [{ delta: { content: 'hello from groq' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      const text = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
      return Promise.resolve(
        new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }
    return json({ error: 'not part of this test' }, 503);
  }) as unknown as typeof fetch;
  return { fetchImpl, auth };
}

async function addProvider(
  hub: Hub,
  preset: string,
  apiKey: string | null,
  profile = 'default',
): Promise<Provider> {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    profile,
    payload: { preset, label: preset, kind: 'llm', api_key: apiKey },
  });
  if (response.statusCode !== 201) {
    throw new Error(`adding ${preset} answered ${String(response.statusCode)}: ${response.body}`);
  }
  return response.json() as Provider;
}

async function providersIn(hub: Hub, profile: string): Promise<Provider[]> {
  const response = await authed(hub, hub.token, {
    method: 'GET',
    url: '/api/v1/models/providers',
    profile,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Provider[] }).items;
}

/** A profile made through the API, as the person makes one. Returns its workspace id. */
async function makeProfile(hub: Hub, slug: string): Promise<string> {
  const made = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/profiles',
    payload: { slug, name: slug },
  });
  expect(made.statusCode).toBe(201);
  return (made.json() as { id: string }).id;
}

async function workspaceIdOf(hub: Hub, slug: string): Promise<string> {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' });
  const items = (response.json() as { items: { id: string; slug: string }[] }).items;
  const found = items.find((profile) => profile.slug === slug);
  if (!found) throw new Error(`no profile ${slug}`);
  return found.id;
}

/** What Hermes would be told for one turn in this workspace, and what it would start with. */
function hermesTurn(hub: Hub, workspaceId: string) {
  const agents = agentsServiceFor(hub.app);
  return agents.targetFor(agents.loadAgentBySlug('hermes'), workspaceId, {
    sessionRef: null,
    cwd: null,
    model: null,
    reasoningEffort: null,
  });
}

function claudeCodeEnv(hub: Hub, workspaceId: string) {
  const agents = agentsServiceFor(hub.app);
  return agents.targetFor(agents.loadAgentBySlug('claude-code'), workspaceId, {
    sessionRef: null,
    cwd: null,
    model: null,
    reasoningEffort: null,
  }).env;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function hermesHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-shared-'));
  homes.push(home);
  return home;
}

function configOf(home: string): { model?: { default?: string; provider?: string } } {
  return (YAML.parse(readFileSync(path.join(home, 'config.yaml'), 'utf8')) ?? {}) as {
    model?: { default?: string; provider?: string };
  };
}

describe('models: one provider list for every profile', () => {
  it('lists a provider added in one profile, with its key and models, in every other', async () => {
    const { fetchImpl } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      await makeProfile(hub, 'work');
      await addProvider(hub, 'anthropic', 'sk-ant-once');
      await drainJobs(hub.app);

      const inWork = await providersIn(hub, 'work');
      expect(inWork.map((provider) => provider.slug)).toEqual(['anthropic']);
      // The key is stored — and still never comes back.
      expect(inWork[0]!.api_key).toBe('[stored]');
      expect(JSON.stringify(inWork)).not.toContain('sk-ant-once');
      expect(inWork[0]!.models.map((model) => model.model).sort()).toEqual([
        'claude-haiku-4-5',
        'claude-sonnet-4-5',
      ]);
      // The same row, whichever profile asks: it is stored once, under the default profile.
      const inDefault = await providersIn(hub, 'default');
      expect(inDefault.map((provider) => provider.id)).toEqual(inWork.map((p) => p.id));
      expect(inWork[0]!.profile).toBe('default');

      const catalogue = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models',
        profile: 'work',
      });
      expect(
        (catalogue.json() as { items: { key: string }[] }).items.map((model) => model.key),
      ).toContain('anthropic/claude-sonnet-4-5');
    } finally {
      await hub.close();
    }
  });

  it('lets a profile made after the provider run a turn on it, with no setup in that profile', async () => {
    const { fetchImpl, auth } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const groq = await addProvider(hub, 'groq', 'gsk-added-once');
      await drainJobs(hub.app);
      const later = await makeProfile(hub, 'later');

      // Hermes in the new profile is told a model and the provider it runs on.
      const turn = hermesTurn(hub, later);
      expect(turn.profile).toBe('later');
      expect(turn.model).toBe('llama-3.3-70b-versatile');
      expect(turn.modelProvider).toBe('majlis-groq');
      expect(turn.modelProviderId).toBe(groq.id);

      // A coding agent there starts with the key, under the name it reads.
      await addProvider(hub, 'anthropic', 'sk-ant-for-everyone');
      await drainJobs(hub.app);
      expect(claudeCodeEnv(hub, later)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-for-everyone' });

      // And a real turn — the hub's own path to the provider — answers in that profile.
      const events: { type: string; text?: string }[] = [];
      for await (const event of modelsServiceFor(hub.app).chat(later, {
        providerId: groq.id,
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', text: 'hi' }],
      })) {
        events.push(event as { type: string; text?: string });
      }
      expect(events.find((event) => event.type === 'failed')).toBeUndefined();
      expect(events.some((event) => event.text === 'hello from groq')).toBe(true);
      expect(auth).toEqual(['Bearer gsk-added-once']);
    } finally {
      await hub.close();
    }
  });

  it('applies an edit or a removal made in one profile to every profile', async () => {
    const { fetchImpl } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      await makeProfile(hub, 'work');
      const added = await addProvider(hub, 'groq', 'gsk-typed-in-work', 'work');
      await drainJobs(hub.app);
      expect((await providersIn(hub, 'default')).map((p) => p.id)).toEqual([added.id]);
      // A second add of the same preset from another profile is the same provider.
      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { preset: 'groq', label: 'groq', kind: 'llm', api_key: 'gsk-again' },
      });
      expect(again.statusCode).toBe(409);

      // The key typed in the default profile is the key the work profile has.
      const keyed = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${added.id}`,
        payload: { api_key: 'gsk-typed-in-default' },
      });
      expect(keyed.statusCode).toBe(200);
      await drainJobs(hub.app);
      expect((await providersIn(hub, 'work'))[0]!.api_key).toBe('[stored]');
      const work = await workspaceIdOf(hub, 'work');
      expect(hermesTurn(hub, work).model).toBe('llama-3.3-70b-versatile');

      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${added.id}`,
        profile: 'work',
      });
      expect(removed.statusCode).toBe(204);
      expect(await providersIn(hub, 'default')).toEqual([]);
      expect(hermesTurn(hub, await workspaceIdOf(hub, 'default')).model).toBeNull();
    } finally {
      await hub.close();
    }
  });
});

describe('models: the model choice stays per profile', () => {
  it("uses the default profile's chat model in a profile that chose none, and its own once it chooses", async () => {
    const { fetchImpl } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const work = await makeProfile(hub, 'work');
      const anthropic = await addProvider(hub, 'anthropic', 'sk-ant');
      const groq = await addProvider(hub, 'groq', 'gsk');
      await drainJobs(hub.app);

      // The first provider's first model became the default profile's choice.
      const inherited = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models/defaults',
        profile: 'work',
      });
      expect(inherited.json()).toMatchObject({
        default: { provider_id: anthropic.id },
        inherited: ['default'],
      });
      expect(hermesTurn(hub, work).modelProvider).toBe('anthropic');

      const chosen = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        profile: 'work',
        payload: { default: { provider_id: groq.id, model: 'llama-3.3-70b-versatile' } },
      });
      expect(chosen.statusCode).toBe(200);
      expect(chosen.json()).toMatchObject({
        default: { provider_id: groq.id, model: 'llama-3.3-70b-versatile' },
        inherited: [],
      });
      expect(hermesTurn(hub, work).model).toBe('llama-3.3-70b-versatile');
      // The default profile's own choice did not move.
      const own = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/defaults' });
      expect(own.json()).toMatchObject({ default: { provider_id: anthropic.id }, inherited: [] });

      // Clearing the profile's choice goes back to inheriting.
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        profile: 'work',
        payload: { default: null },
      });
      expect(hermesTurn(hub, work).modelProvider).toBe('anthropic');
    } finally {
      await hub.close();
    }
  });
});

describe("models: Hermes's default profile is not the last saver's", () => {
  it("keeps the default profile's keys and model when providers are saved in another profile", async () => {
    const { fetchImpl } = twoProviders();
    const home = hermesHome();
    let processEnv: Record<string, string> = {};
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          restartDelayMs: 0,
          hermes: {
            home: () => home,
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
      await makeProfile(hub, 'work');
      await addProvider(hub, 'anthropic', 'sk-ant-default');
      await drainJobs(hub.app);
      const chosenInDefault = configOf(home).model;
      expect(chosenInDefault).toMatchObject({ provider: 'anthropic' });

      // Somebody in the work profile adds Groq and makes it that profile's model.
      const groq = await addProvider(hub, 'groq', 'gsk-work', 'work');
      await drainJobs(hub.app);
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/models/defaults',
        profile: 'work',
        payload: { default: { provider_id: groq.id, model: 'llama-3.3-70b-versatile' } },
      });
      await settle();

      // Hermes's default profile still runs on its own model…
      expect(configOf(home).model).toEqual(chosenInDefault);
      // …and has every key: the ones saved there and the ones saved elsewhere.
      const env = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(env.get('ANTHROPIC_API_KEY')).toBe('sk-ant-default');
      expect(env.get('GROQ_API_KEY')).toBe('gsk-work');
      expect(processEnv).toMatchObject({
        ANTHROPIC_API_KEY: 'sk-ant-default',
        GROQ_API_KEY: 'gsk-work',
      });

      // Removing Groq from the work profile removes it from Hermes everywhere.
      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${groq.id}`,
        profile: 'work',
      });
      expect(removed.statusCode).toBe(204);
      const after = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(after.has('GROQ_API_KEY')).toBe(false);
      expect(after.get('ANTHROPIC_API_KEY')).toBe('sk-ant-default');
      expect(processEnv.GROQ_API_KEY).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it("keeps the hub's keys out of a named profile's own .env, so a changed key is the key used", async () => {
    const { fetchImpl } = twoProviders();
    const home = hermesHome();
    // A profile made as a copy of `default` carries a copy of its `.env` (Hermes's
    // `--clone-from`), and Hermes reads a profile's `.env` before the process environment:
    // an old key left there would win over the one the hub hands every profile.
    const design = path.join(home, 'profiles', 'design');
    mkdirSync(design, { recursive: true });
    writeFileSync(
      path.join(design, '.env'),
      '# the design profile\nANTHROPIC_API_KEY=sk-ant-stale-copy\nTELEGRAM_BOT_TOKEN=keep-me\n',
    );
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          hermes: {
            home: () => home,
            profileHomes: () => [design],
            restart: () => Promise.resolve(true),
          },
        },
      },
    );
    try {
      await addProvider(hub, 'anthropic', 'sk-ant-current');
      await drainJobs(hub.app);
      const env = parseEnv(readFileSync(path.join(design, '.env'), 'utf8'));
      expect(env.has('ANTHROPIC_API_KEY')).toBe(false);
      expect(env.get('TELEGRAM_BOT_TOKEN')).toBe('keep-me');
      expect(readFileSync(path.join(design, '.env'), 'utf8')).toContain('# the design profile');

      // A profile that appears later (made in Hermes, or copied on first use) is put right
      // before its first turn.
      const fresh = path.join(home, 'profiles', 'fresh');
      mkdirSync(fresh, { recursive: true });
      writeFileSync(path.join(fresh, '.env'), 'ANTHROPIC_API_KEY=sk-ant-stale-copy\n');
      modelsServiceFor(hub.app).prepareProfile(fresh);
      expect(parseEnv(readFileSync(path.join(fresh, '.env'), 'utf8')).has('ANTHROPIC_API_KEY')).toBe(
        false,
      );
    } finally {
      await hub.close();
    }
  });
});
