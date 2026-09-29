/**
 * The model gateway inside a whole hub (ADR 0029): the providers a person added become
 * CLIProxyAPI's upstreams (with their keys, in its 0600 file only), the catalogue says which
 * models a coding agent can run, an agent on the hub's models is started with the gateway's
 * address and a token and none of the profile's keys, and a call with that token reaches the
 * provider row the turn chose. CLIProxyAPI is the stand-in of `gateway.test.ts`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

/** CLIProxyAPI's file, as far as these tests read it. */
interface CliproxyYaml {
  server: Record<string, unknown>;
  management: Record<string, unknown>;
  access: { 'api-keys': string[] };
  routing: Record<string, unknown>;
  plugins: { enabled: boolean };
  oauth: Record<string, string>;
  'api-keys': Record<string, { keys: unknown; models: unknown[]; [field: string]: unknown }[]>;
}
import { requireSqlite } from '../../../lib/db.js';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { agentsServiceFor } from '../../agents/index.js';
import { agents as agentRows } from '../../agents/schema.js';
import { modelsServiceFor } from '../index.js';
import { providers as providerRows } from '../schema.js';
import { upstreamPrefix } from './cliproxy-config.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testing',
  'fake-cliproxy.mjs',
);
const ANTHROPIC_KEY = 'sk-ant-must-stay-in-the-hub';
const GROQ_KEY = 'gsk-must-stay-in-the-hub';

type Hub = TestHub & { token: string; userId: string };

function providers(): typeof fetch {
  return (async (url: string) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      return json({
        data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
        has_more: false,
      });
    }
    if (url.startsWith('https://api.groq.com/openai/v1/models')) {
      return json({ data: [{ id: 'llama-3.3-70b-versatile' }] });
    }
    return new Response('{}', { status: 503 });
  }) as unknown as typeof fetch;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function hub(source: 'hub' | 'auto', home?: string): Promise<Hub> {
  const made = await signedInHub(
    { COREHUB_MODEL_GATEWAY: 'on', COREHUB_AGENT_MODEL_SOURCE: source },
    {
      models: { fetchImpl: providers(), cliproxyBin: FAKE },
      ...(home ? { agents: { agentHome: home } } : {}),
    },
  );
  cleanup.push(() => made.close());
  return made as Hub;
}

async function addProvider(h: Hub, preset: string, apiKey: string | null) {
  const response = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset, label: preset, kind: 'llm', api_key: apiKey, scope: 'all' },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

function workspaceOf(h: Hub): string {
  const db = requireSqlite(h.app.hub.database);
  const row = db.$client.prepare("select id from workspaces where slug = 'default'").get() as {
    id: string;
  };
  return row.id;
}

function markInstalled(h: Hub, slug: string): void {
  const db = requireSqlite(h.app.hub.database);
  db.update(agentRows).set({ installState: 'installed' }).where(eq(agentRows.slug, slug)).run();
}

describe('the model gateway in the hub', () => {
  it('hands CLIProxyAPI every provider with a key, and says which models agents can run', async () => {
    const h = await hub('hub');
    const anthropic = await addProvider(h, 'anthropic', ANTHROPIC_KEY);
    const groq = await addProvider(h, 'groq', GROQ_KEY);
    await drainJobs(h.app);

    const upstreams = modelsServiceFor(h.app).gatewayUpstreams();
    expect(upstreams.map((u) => [u.providerId, u.kind, u.baseUrl, u.apiKey])).toEqual(
      [
        [anthropic.id, 'claude', 'https://api.anthropic.com', ANTHROPIC_KEY],
        [groq.id, 'openai-compatibility', 'https://api.groq.com/openai/v1', GROQ_KEY],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const catalogue = await authed(h, h.token, { method: 'GET', url: '/api/v1/models' });
    const items = (catalogue.json() as { items: { key: string; agent_gateway?: boolean }[] }).items;
    expect(items.find((m) => m.key === 'anthropic/claude-sonnet-4-5')?.agent_gateway).toBe(true);
    expect(items.find((m) => m.key === 'groq/llama-3.3-70b-versatile')?.agent_gateway).toBe(true);
    // A subscription signed in to through Hermes is never lent to another agent.
    requireSqlite(h.app.hub.database)
      .update(providerRows)
      .set({ authKind: 'oauth' })
      .where(eq(providerRows.id, groq.id))
      .run();
    expect(
      modelsServiceFor(h.app)
        .gatewayUpstreams()
        .map((u) => u.providerId),
    ).toEqual([anthropic.id]);
    const after = await authed(h, h.token, { method: 'GET', url: '/api/v1/models' });
    const groqModel = (
      after.json() as { items: { key: string; agent_gateway?: boolean }[] }
    ).items.find((m) => m.key === 'groq/llama-3.3-70b-versatile');
    expect(groqModel?.agent_gateway).toBe(false);
  });

  it('starts a coding agent with the gateway and a token, never a key, and the token reaches the chosen row', async () => {
    const h = await hub('hub');
    const anthropic = await addProvider(h, 'anthropic', ANTHROPIC_KEY);
    await drainJobs(h.app);
    const workspace = workspaceOf(h);
    const agents = agentsServiceFor(h.app);
    const row = agents.loadAgentBySlug('claude-code');
    const selection = agents.selectionFor(row, workspace, { model: 'anthropic/claude-sonnet-4-5' });
    expect(agents.modelSourceFor(row, workspace, selection)).toBe('hub');

    const grant = await agents.openGateway(row, workspace, {
      sessionId: 's1',
      userId: h.userId,
      alive: () => true,
    });
    const target = agents.targetFor(row, workspace, {
      sessionRef: null,
      cwd: null,
      model: 'anthropic/claude-sonnet-4-5',
      reasoningEffort: null,
      gateway: grant,
    });
    const env = target.env ?? {};
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: grant.anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: grant.token,
      ANTHROPIC_MODEL: 'corehub-main',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'corehub-small',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(ANTHROPIC_KEY);
    expect(env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));
    // Whatever the host has, the key variables are taken out of the agent's environment.
    expect(target.envRemove).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
    );
    // Without the gateway, the same agent gets the profile's key as before.
    const before = agents.targetFor(row, workspace, {
      sessionRef: null,
      cwd: null,
      model: null,
      reasoningEffort: null,
    });
    expect(before.env?.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);

    // The key sits in CLIProxyAPI's own file, 0600, and nowhere the agent can read.
    const dir = path.join(h.dataDir, 'gateway');
    const file = readdirSync(dir).find((name) => name.endsWith('.yaml'))!;
    const config = parse(readFileSync(path.join(dir, file), 'utf8')) as CliproxyYaml;
    expect(config['api-keys'].claude[0]).toMatchObject({
      prefix: upstreamPrefix(anthropic.id),
      keys: [{ 'api-key': ANTHROPIC_KEY }],
    });

    grant.setTurn({
      runId: 'run-1',
      providerId: selection.providerId!,
      model: selection.model!,
      report: () => {},
    });
    const answer = await fetch(`${grant.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({ model: 'corehub-main', max_tokens: 5, messages: [] }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('x-fake-model')).toBe(
      `${upstreamPrefix(anthropic.id)}/claude-sonnet-4-5`,
    );
    grant.revoke();
  });

  it('shows the agent’s model source on its card and lets the person choose it', async () => {
    const h = await hub('hub');
    await addProvider(h, 'anthropic', ANTHROPIC_KEY);
    await drainJobs(h.app);
    markInstalled(h, 'claude-code');
    const agent = async () => {
      const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
      return (
        list.json() as {
          items: { id: string; slug: string; model_source?: string; credentials?: string }[];
        }
      ).items.find((a) => a.slug === 'claude-code')!;
    };
    const first = await agent();
    expect(first.model_source).toBe('hub');
    expect(first.credentials).toBe('ready');
    const settings = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${first.id}/settings`,
    });
    const section = (
      settings.json() as {
        sections: {
          key: string;
          fields: { key: string; default?: unknown; options: { value: string }[] }[];
        }[];
      }
    ).sections.find((s) => s.key === 'models');
    expect(section?.fields[0]).toMatchObject({ key: 'model_source', default: 'auto' });
    expect(section?.fields[0]?.options.map((o) => o.value)).toEqual(['auto', 'hub', 'agent']);
    const saved = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${first.id}/settings`,
      payload: { section: 'models', values: { model_source: 'agent' } },
    });
    expect(saved.statusCode).toBe(200);
    expect((await agent()).model_source).toBe('agent');
    // Hermes and the hub's own agent are not the gateway's.
    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
    for (const item of (list.json() as { items: { slug: string; model_source?: string }[] })
      .items) {
      if (item.slug === 'hermes' || item.slug === 'direct')
        expect(item.model_source).toBeUndefined();
    }
  });

  it('on a computer, keeps a signed-in agent on its own account unless switched', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-gw-home-'));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const h = await hub('auto', home);
    await addProvider(h, 'anthropic', ANTHROPIC_KEY);
    await drainJobs(h.app);
    const workspace = workspaceOf(h);
    const agents = agentsServiceFor(h.app);
    const row = agents.loadAgentBySlug('claude-code');
    const selection = agents.selectionFor(row, workspace, { model: 'anthropic/claude-sonnet-4-5' });
    // Nothing of its own: the hub's models.
    expect(agents.modelSourceFor(row, workspace, selection)).toBe('hub');
    // `claude login` on this computer: its own account.
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    expect(agents.modelSourceFor(row, workspace, selection)).toBe('agent');
    // The person's choice wins.
    agents.updateSettings(
      { id: workspace, slug: 'default', name: 'default', isDefault: true },
      row.id,
      { section: 'models', values: { model_source: 'hub' } },
    );
    expect(agents.modelSourceFor(row, workspace, selection)).toBe('hub');
    // No model to give it at all: its own, whatever the choice.
    expect(
      agents.modelSourceFor(row, workspace, { model: null, provider: null, providerId: null }),
    ).toBe('agent');
  });

  it('is off when the operator switched it off', async () => {
    const made = await signedInHub(
      { COREHUB_MODEL_GATEWAY: 'off' },
      { models: { fetchImpl: providers(), cliproxyBin: FAKE } },
    );
    cleanup.push(() => made.close());
    const h = made as Hub;
    await addProvider(h, 'anthropic', ANTHROPIC_KEY);
    await drainJobs(h.app);
    const agents = agentsServiceFor(h.app);
    const row = agents.loadAgentBySlug('claude-code');
    const workspace = workspaceOf(h);
    const selection = agents.selectionFor(row, workspace, { model: 'anthropic/claude-sonnet-4-5' });
    expect(agents.modelSourceFor(row, workspace, selection)).toBeNull();
    const catalogue = await authed(h, h.token, { method: 'GET', url: '/api/v1/models' });
    expect(JSON.stringify(catalogue.json())).not.toContain('agent_gateway');
  });
});
