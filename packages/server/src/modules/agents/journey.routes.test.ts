/**
 * `agents.getJourney` through the hub's own route, with a scripted Hermes API in place of
 * `hermes serve`: the payload is what the real Hermes gave for a throwaway profile (recorded in
 * the change record); the real server is `hermes-journey.real.test.ts`. Before this change the
 * route was the contract's 501 stub.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { HermesDashboardUnavailable } from './hermes-dashboard.js';
import { journeyFromHermes } from './hermes-journey.js';
import type { HermesApiCall } from './hermes-tools.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

/** `hermes -p work journey --json` on the throwaway home, trimmed to what the hub reads. */
const HERMES_GRAPH = {
  nodes: [
    {
      id: 'summarize-pdf',
      label: 'summarize-pdf',
      kind: 'skill',
      timestamp: 1790352531,
      category: 'research',
      useCount: 0,
      state: 'active',
      createdBy: 'agent',
      pinned: false,
    },
    {
      id: 'web-research',
      label: 'web-research',
      kind: 'skill',
      timestamp: 1789898400,
      category: 'research',
      useCount: 12,
      state: 'active',
      createdBy: null,
      pinned: true,
    },
    {
      id: 'memory:memory:0',
      label: 'User prefers web research in Arabic',
      kind: 'memory',
      memorySource: 'memory',
      timestamp: 1790352531,
      category: 'memory',
      useCount: 0,
      state: 'active',
      createdBy: 'memory',
      pinned: false,
    },
    {
      id: 'memory:profile:1',
      label: 'يفضّل الردود القصيرة',
      kind: 'memory',
      memorySource: 'profile',
      timestamp: 1790352540,
      category: 'memory',
      useCount: 0,
      state: 'active',
      createdBy: 'memory',
      pinned: false,
    },
  ],
  edges: [
    { source: 'summarize-pdf', target: 'web-research' },
    { source: 'memory:memory:0', target: 'web-research' },
  ],
  clusters: [
    { category: 'research', count: 2 },
    { category: 'memory', count: 2 },
  ],
  memory: [],
  stats: { nodes: 2 },
};

async function boot(hermesApi?: HermesApiCall): Promise<{ hub: Hub; agent: string; root: string }> {
  hub = await signedInHub(
    {},
    {
      agents: {
        adapterOptions: { hermes: { fetchImpl: healthy } },
        ...(hermesApi ? { hermesApi } : {}),
      },
    },
  );
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  return { hub, agent, root: path.join(hub.dataDir, 'hermes') };
}

describe("Hermes's learning graph in the contract's shape", () => {
  it('renames the fields, keeps Hermes ids, and calls USER.md entries `user`', () => {
    const journey = journeyFromHermes(HERMES_GRAPH);
    expect(journey.nodes).toEqual([
      {
        id: 'summarize-pdf',
        label: 'summarize-pdf',
        kind: 'skill',
        category: 'research',
        use_count: 0,
        pinned: false,
        state: 'active',
        agent_created: true,
        memory_source: null,
        learned_at: '2026-09-25T16:08:51Z',
      },
      {
        id: 'web-research',
        label: 'web-research',
        kind: 'skill',
        category: 'research',
        use_count: 12,
        pinned: true,
        state: 'active',
        agent_created: false,
        memory_source: null,
        learned_at: '2026-09-20T10:00:00Z',
      },
      {
        id: 'memory:memory:0',
        label: 'User prefers web research in Arabic',
        kind: 'memory',
        category: 'memory',
        use_count: 0,
        pinned: false,
        state: 'active',
        agent_created: false,
        memory_source: 'memory',
        learned_at: '2026-09-25T16:08:51Z',
      },
      {
        id: 'memory:profile:1',
        label: 'يفضّل الردود القصيرة',
        kind: 'memory',
        category: 'memory',
        use_count: 0,
        pinned: false,
        state: 'active',
        agent_created: false,
        memory_source: 'user',
        learned_at: '2026-09-25T16:09:00Z',
      },
    ]);
    expect(journey.edges).toEqual(HERMES_GRAPH.edges);
    expect(journey.clusters).toEqual(HERMES_GRAPH.clusters);
  });

  it('leaves out what Hermes did not fill instead of guessing it', () => {
    const journey = journeyFromHermes({
      nodes: [
        { id: 'ok', kind: 'skill', timestamp: null, useCount: 'x', state: 'weird' },
        { id: '', kind: 'skill' },
        { id: 'tool-x', kind: 'tool' },
        null,
      ],
      edges: [
        { source: 'ok', target: 'gone' },
        { source: 'ok', target: 'ok' },
      ],
      clusters: [{ category: 'misc', count: 1 }, { category: '', count: 3 }, 'junk'],
    });
    expect(journey.nodes).toEqual([
      {
        id: 'ok',
        label: 'ok',
        kind: 'skill',
        category: null,
        use_count: 0,
        pinned: false,
        state: 'active',
        agent_created: false,
        memory_source: null,
        learned_at: null,
      },
    ]);
    expect(journey.edges).toEqual([{ source: 'ok', target: 'ok' }]);
    expect(journey.clusters).toEqual([{ category: 'misc', count: 1 }]);
    expect(journeyFromHermes({})).toEqual({ nodes: [], edges: [], clusters: [] });
  });
});

describe('agents.getJourney', () => {
  it("asks Hermes's server in the selected profile and answers the graph (no longer 501)", async () => {
    const calls: string[] = [];
    const api: HermesApiCall = async <T>(method: string, route: string): Promise<T> => {
      calls.push(`${method} ${route}`);
      return HERMES_GRAPH as T;
    };
    const { hub: h, agent, root } = await boot(api);
    mkdirSync(root, { recursive: true });

    const res = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/journey` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { nodes: Array<{ id: string; kind: string }>; clusters: unknown[] };
    expect(body.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual([
      'skill:summarize-pdf',
      'skill:web-research',
      'memory:memory:memory:0',
      'memory:memory:profile:1',
    ]);
    expect(body.clusters).toHaveLength(2);
    expect(calls).toEqual(['GET /api/learning/graph?profile=default']);

    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const absent = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/journey`,
      profile: 'work',
    });
    expect(absent.statusCode).toBe(409);
    expect(absent.json()).toMatchObject({ details: { reason: 'hermes_profile_absent' } });

    mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true });
    const work = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/journey`,
      profile: 'work',
    });
    expect(work.statusCode, work.body).toBe(200);
    expect(calls.at(-1)).toBe('GET /api/learning/graph?profile=work');
  });

  it('names the reason when this hub does not supervise Hermes', async () => {
    const { hub: h, agent, root } = await boot();
    mkdirSync(root, { recursive: true });
    const res = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/journey` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'hermes_not_supervised' },
    });
  });

  it('is 503 when Hermes does not answer, and 409 for an agent that is not Hermes', async () => {
    const api: HermesApiCall = async () => {
      throw new HermesDashboardUnavailable('Hermes server did not start');
    };
    const { hub: h, agent, root } = await boot(api);
    mkdirSync(root, { recursive: true });
    const down = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/journey`,
    });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ details: { reason: 'hermes_api_unavailable' } });

    const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' });
    const other = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
      (row) => row.kind !== 'hermes',
    )!.id;
    const notHermes = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${other}/journey`,
    });
    expect(notHermes.statusCode).toBe(409);
    expect(notHermes.json()).toMatchObject({ details: { reason: 'journey_is_hermes_only' } });
  });
});
