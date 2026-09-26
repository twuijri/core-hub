/**
 * Two provider scopes (contract decision §37, ADR 0010).
 *
 * A **shared** provider is added once and every profile uses it — a profile made a minute
 * later included. A profile may also have providers of its **own** (a team with its own
 * subscription): in that profile its own wins over the shared one of the same preset, and no
 * other profile ever uses its key. What stays per profile besides: the choice of model, which
 * falls back on the default profile's. Hermes's default profile keeps its own keys and model
 * whichever profile somebody saved in, and each named Hermes profile's `.env` holds exactly
 * the keys that differ from the root's.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { agentsServiceFor } from '../agents/index.js';
import { parseEnv } from './dotenv.js';
import { modelsServiceFor } from './index.js';

type Hub = TestHub & { token: string };

interface Provider {
  id: string;
  slug: string;
  profile: string;
  scope: 'all' | 'profile';
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
  scope: 'all' | 'profile' = 'all',
): Promise<Provider> {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    profile,
    payload: { preset, label: preset, kind: 'llm', api_key: apiKey, scope },
  });
  if (response.statusCode !== 201) {
    throw new Error(`adding ${preset} answered ${String(response.statusCode)}: ${response.body}`);
  }
  return response.json() as Provider;
}

/** The chat providers a profile sees (Groq's dictation and speech rows are on their tabs). */
async function providersIn(hub: Hub, profile: string): Promise<Provider[]> {
  const response = await authed(hub, hub.token, {
    method: 'GET',
    url: '/api/v1/models/providers?kind=llm',
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
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-shared-'));
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
      expect(turn.modelProvider).toBe('corehub-groq');
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

      // Removing Groq from the work profile removes it from Hermes everywhere. Groq is three
      // rows and one key — chat, dictation and speech (§91) — and the key goes with the last.
      const rows = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/models/providers',
        profile: 'work',
      });
      const groqRows = (rows.json() as { items: { id: string; slug: string }[] }).items.filter(
        (row) => row.slug.startsWith('groq'),
      );
      expect(groqRows.map((row) => row.slug).sort()).toEqual(['groq', 'groq-stt', 'groq-tts']);
      for (const row of groqRows) {
        const removed = await authed(hub, hub.token, {
          method: 'DELETE',
          url: `/api/v1/models/providers/${row.id}`,
          profile: 'work',
        });
        expect(removed.statusCode).toBe(204);
        if (row.id !== groqRows.at(-1)!.id) {
          // Still a Groq row with the key: still in Hermes.
          const partway = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
          expect(partway.get('GROQ_API_KEY')).toBe('gsk-work');
        }
      }
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
      expect(
        parseEnv(readFileSync(path.join(fresh, '.env'), 'utf8')).has('ANTHROPIC_API_KEY'),
      ).toBe(false);
    } finally {
      await hub.close();
    }
  });
});

describe("models: a profile's own providers and the shared ones (decision §37)", () => {
  it("uses a profile's own key in that profile, and the shared key in every other", async () => {
    const { fetchImpl } = twoProviders();
    const home = hermesHome();
    const design = path.join(home, 'profiles', 'design');
    const finance = path.join(home, 'profiles', 'finance');
    mkdirSync(design, { recursive: true });
    mkdirSync(finance, { recursive: true });
    let processEnv: Record<string, string> = {};
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          hermes: {
            home: () => home,
            profileHomes: () => [design, finance],
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
      const designId = await makeProfile(hub, 'design');
      const financeId = await makeProfile(hub, 'finance');
      const defaultId = await workspaceIdOf(hub, 'default');
      await addProvider(hub, 'anthropic', 'sk-ant-shared-key');
      // The Design team's own subscription, typed in the Design profile.
      const own = await addProvider(hub, 'anthropic', 'sk-ant-design-key', 'design', 'profile');
      expect(own).toMatchObject({ scope: 'profile', profile: 'design', api_key: '[stored]' });
      await drainJobs(hub.app);

      // Design lists both, each saying which it is; Finance only the shared one.
      const inDesign = await providersIn(hub, 'design');
      expect(inDesign.map((p) => [p.slug, p.scope, p.profile])).toEqual([
        ['anthropic', 'profile', 'design'],
        ['anthropic', 'all', 'default'],
      ]);
      const inFinance = await providersIn(hub, 'finance');
      expect(inFinance.map((p) => [p.slug, p.scope])).toEqual([['anthropic', 'all']]);
      // Keys never come back, in either scope.
      expect(JSON.stringify([...inDesign, ...inFinance])).not.toMatch(/sk-ant-(shared|design)/);

      // Agents: Design's own key in Design, the shared key everywhere else.
      expect(claudeCodeEnv(hub, designId)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-design-key' });
      expect(claudeCodeEnv(hub, financeId)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-shared-key' });
      expect(claudeCodeEnv(hub, defaultId)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-shared-key' });

      // Hermes: the shared key in the root and the process; Design's own in Design's `.env`,
      // which Hermes reads first; nothing in Finance's.
      const root = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
      expect(root.get('ANTHROPIC_API_KEY')).toBe('sk-ant-shared-key');
      expect(processEnv.ANTHROPIC_API_KEY).toBe('sk-ant-shared-key');
      const designEnv = parseEnv(readFileSync(path.join(design, '.env'), 'utf8'));
      expect(designEnv.get('ANTHROPIC_API_KEY')).toBe('sk-ant-design-key');
      expect(existsSync(path.join(finance, '.env'))).toBe(false);

      // The same preset twice in one scope is refused; its removal leaves the shared one.
      const twice = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        profile: 'design',
        payload: { preset: 'anthropic', label: 'a', kind: 'llm', api_key: 'x', scope: 'profile' },
      });
      expect(twice.statusCode).toBe(409);
      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${own.id}`,
        profile: 'design',
      });
      expect(removed.statusCode).toBe(204);
      expect(claudeCodeEnv(hub, designId)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-shared-key' });
      expect(
        parseEnv(readFileSync(path.join(design, '.env'), 'utf8')).has('ANTHROPIC_API_KEY'),
      ).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it("does not show a profile's own provider to another profile, nor let it act on it", async () => {
    const { fetchImpl } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      await makeProfile(hub, 'design');
      await makeProfile(hub, 'finance');
      const own = await addProvider(hub, 'groq', 'gsk-design-only', 'design', 'profile');
      expect(await providersIn(hub, 'finance')).toEqual([]);
      expect(await providersIn(hub, 'default')).toEqual([]);
      const reach = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/models/providers/${own.id}`,
        profile: 'finance',
        payload: { label: 'mine now' },
      });
      expect(reach.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  });

  it("runs a turn on a profile's own provider when the turn names the shared one", async () => {
    const { fetchImpl, auth } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const designId = await makeProfile(hub, 'design');
      const financeId = await makeProfile(hub, 'finance');
      const shared = await addProvider(hub, 'groq', 'gsk-shared-key');
      const own = await addProvider(hub, 'groq', 'gsk-design-key', 'design', 'profile');
      await drainJobs(hub.app);

      const say = async (workspace: string) => {
        for await (const event of modelsServiceFor(hub.app).chat(workspace, {
          providerId: shared.id,
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', text: 'hi' }],
        })) {
          expect(event.type).not.toBe('failed');
        }
      };
      await say(designId);
      await say(financeId);
      expect(auth).toEqual(['Bearer gsk-design-key', 'Bearer gsk-shared-key']);
      // Hermes in Design is told Design's own provider.
      expect(hermesTurn(hub, designId).modelProviderId).toBe(own.id);
      expect(hermesTurn(hub, financeId).modelProviderId).toBe(shared.id);
    } finally {
      await hub.close();
    }
  });

  it("does not let another profile fall back on the default profile's own key", async () => {
    const { fetchImpl } = twoProviders();
    const home = hermesHome();
    const finance = path.join(home, 'profiles', 'finance');
    mkdirSync(finance, { recursive: true });
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl,
          hermes: {
            home: () => home,
            profileHomes: () => [finance],
            restart: () => Promise.resolve(true),
          },
        },
      },
    );
    try {
      const financeId = await makeProfile(hub, 'finance');
      const defaultId = await workspaceIdOf(hub, 'default');
      await addProvider(hub, 'groq', 'gsk-default-own-key', 'default', 'profile');
      await drainJobs(hub.app);
      const service = modelsServiceFor(hub.app);
      expect(service.environmentFor(defaultId, { groq: 'GROQ_API_KEY' })).toEqual({
        GROQ_API_KEY: 'gsk-default-own-key',
      });
      expect(service.environmentFor(financeId, { groq: 'GROQ_API_KEY' })).toEqual({});
      // Hermes loads the root `.env` into its environment, so Finance's own `.env` blocks
      // the name: Finance has no key of that name to use.
      expect(parseEnv(readFileSync(path.join(home, '.env'), 'utf8')).get('GROQ_API_KEY')).toBe(
        'gsk-default-own-key',
      );
      expect(parseEnv(readFileSync(path.join(finance, '.env'), 'utf8')).get('GROQ_API_KEY')).toBe(
        '',
      );
    } finally {
      await hub.close();
    }
  });

  it("gives a profile made as a copy its source's own providers, keys included", async () => {
    const { fetchImpl } = twoProviders();
    const hub = await signedInHub({}, { models: { fetchImpl } });
    try {
      const designId = await makeProfile(hub, 'design');
      await addProvider(hub, 'anthropic', 'sk-ant-design-key', 'design', 'profile');
      await drainJobs(hub.app);
      const copied = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: 'design-copy', name: 'Design copy', clone_from: 'design' },
      });
      expect(copied.statusCode).toBe(201);
      const copyId = (copied.json() as { id: string }).id;
      const inCopy = await providersIn(hub, 'design-copy');
      expect(inCopy.map((p) => [p.slug, p.scope, p.profile, p.api_key])).toEqual([
        ['anthropic', 'profile', 'design-copy', '[stored]'],
      ]);
      expect(inCopy[0]!.models.length).toBe(2);
      expect(claudeCodeEnv(hub, copyId)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-design-key' });
      // Its own row: the source keeps its own, and removing the copy's leaves the source's.
      await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/models/providers/${inCopy[0]!.id}`,
        profile: 'design-copy',
      });
      expect(claudeCodeEnv(hub, designId)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-design-key' });
      // A profile made from scratch takes nothing of anybody's own.
      await makeProfile(hub, 'blank');
      expect(await providersIn(hub, 'blank')).toEqual([]);
    } finally {
      await hub.close();
    }
  });
});
