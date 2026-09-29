/**
 * The last test and the tool filter through the hub's own routes (DECISIONS §134), with a
 * scripted Hermes API: a test is kept per profile and comes back on the list without testing
 * again; editing the server marks it stale; the filter is written as Hermes's own keys.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import type { HermesApiCall } from './hermes-tools.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

interface Row {
  name: string;
  last_test: null | {
    ok: boolean;
    tools: Array<{ name: string; access: string; access_source: string }>;
    tool_count: number;
    error: string | null;
    tested_at: string;
    duration_ms: number;
    stale: boolean;
  };
  tool_filter: { include: string[] | null; exclude: string[] | null };
  config: Record<string, unknown>;
}

async function boot(api: HermesApiCall) {
  hub = await signedInHub(
    {},
    { agents: { adapterOptions: { hermes: { fetchImpl: healthy } }, hermesApi: api } },
  );
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const root = path.join(hub.dataDir, 'hermes');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'config.yaml'),
    '# mine\nmcp_servers:\n  github:\n    command: node\n    args: [gh.js]\n  quiet:\n    command: node\n',
  );
  return { h: hub, agent, root };
}

const rows = async (h: Hub, agent: string, profile = 'default') => {
  const res = await authed(h, h.token, {
    method: 'GET',
    url: `/api/v1/agents/${agent}/mcp-servers`,
    profile,
  });
  expect(res.statusCode, res.body).toBe(200);
  return Object.fromEntries(
    (res.json() as { items: Row[] }).items.map((row) => [row.name, row]),
  ) as Record<string, Row>;
};

const TOOLS = [
  { name: 'get_issue', description: 'Read one issue.' },
  { name: 'list_repos', description: 'List repositories.' },
  { name: 'create_issue', description: 'Open an issue.' },
  { name: 'delete_repo', description: 'Delete a repository.' },
];

describe("an MCP server's last test (DECISIONS §134)", () => {
  it('is null until tested, then comes back on the list with its tools, classified', async () => {
    let answer: unknown = { ok: true, tools: TOOLS };
    const { h, agent } = await boot(async <T>() => answer as T);
    const before = await rows(h, agent);
    expect(before.github!.last_test).toBeNull();
    expect(before.github!.tool_filter).toEqual({ include: null, exclude: null });

    const tested = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/github/test`,
    });
    expect(tested.statusCode, tested.body).toBe(200);

    const after = (await rows(h, agent)).github!.last_test!;
    expect(after).toMatchObject({ ok: true, tool_count: 4, error: null, stale: false });
    expect(Date.parse(after.tested_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(after.tools.map((tool) => [tool.name, tool.access])).toEqual([
      ['get_issue', 'read'],
      ['list_repos', 'read'],
      ['create_issue', 'write'],
      ['delete_repo', 'write'],
    ]);
    // The other server was not tested; a failed test is kept as the failure it was.
    expect((await rows(h, agent)).quiet!.last_test).toBeNull();
    answer = { ok: false, error: 'boom', tools: [] };
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/quiet/test`,
    });
    expect((await rows(h, agent)).quiet!.last_test).toMatchObject({
      ok: false,
      error: 'boom',
      tool_count: 0,
    });
  });

  it('goes stale when the server is edited, not when it is switched or filtered', async () => {
    const { h, agent } = await boot(async <T>() => ({ ok: true, tools: TOOLS }) as T);
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/github/test`,
    });
    const patch = (payload: unknown) =>
      authed(h, h.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${agent}/mcp-servers/github`,
        payload,
      });
    expect((await patch({ enabled: false })).statusCode).toBe(200);
    const filtered = await patch({ tool_filter: { include: ['get_issue'], exclude: null } });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect((filtered.json() as Row).last_test?.stale).toBe(false);

    const edited = await patch({ config: { command: 'node', args: ['gh.js', '--v2'] } });
    expect((edited.json() as Row).last_test?.stale).toBe(true);
    // Testing again makes it fresh.
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/github/test`,
    });
    expect((await rows(h, agent)).github!.last_test?.stale).toBe(false);
  });

  it('is kept per profile, and goes with the server when it is deleted', async () => {
    const { h, agent, root } = await boot(async <T>() => ({ ok: true, tools: TOOLS }) as T);
    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    expect(made.statusCode, made.body).toBe(201);
    mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true });
    writeFileSync(
      path.join(root, 'profiles', 'work', 'config.yaml'),
      'mcp_servers:\n  github:\n    command: node\n    args: [gh.js]\n',
    );
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/github/test`,
    });
    expect((await rows(h, agent)).github!.last_test).not.toBeNull();
    expect((await rows(h, agent, 'work')).github!.last_test).toBeNull();

    const gone = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/mcp-servers/github`,
    });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers`,
      payload: { name: 'github', transport: 'stdio', config: { command: 'node' } },
    });
    expect((await rows(h, agent)).github!.last_test).toBeNull();
  });
});

describe('the tool filter (DECISIONS §134)', () => {
  it("writes Hermes's `tools.include` / `tools.exclude` and reads them back", async () => {
    const { h, agent, root } = await boot(async <T>() => ({ ok: true, tools: TOOLS }) as T);
    const patch = (payload: unknown) =>
      authed(h, h.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${agent}/mcp-servers/github`,
        payload,
      });
    const include = await patch({
      tool_filter: { include: ['get_issue', 'list_repos'], exclude: null },
    });
    expect(include.statusCode, include.body).toBe(200);
    expect((include.json() as Row).tool_filter).toEqual({
      include: ['get_issue', 'list_repos'],
      exclude: null,
    });
    const text = readFileSync(path.join(root, 'config.yaml'), 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain(
      '    tools:\n      include:\n        - get_issue\n        - list_repos\n',
    );

    const exclude = await patch({ tool_filter: { include: null, exclude: ['delete_*'] } });
    expect((exclude.json() as Row).tool_filter).toEqual({ include: null, exclude: ['delete_*'] });
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).not.toContain('include');

    const cleared = await patch({ tool_filter: { include: null, exclude: null } });
    expect((cleared.json() as Row).tool_filter).toEqual({ include: null, exclude: null });
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).not.toContain('tools:');

    // `config` and the filter in one patch: the filter is written after the config.
    const both = await patch({
      config: { command: 'node', args: ['gh.js'], tools: { include: ['x'] } },
      tool_filter: { include: ['get_issue'], exclude: null },
    });
    expect((both.json() as Row).tool_filter).toEqual({ include: ['get_issue'], exclude: null });

    const bad = await patch({ tool_filter: { include: [''], exclude: null } });
    expect(bad.statusCode).toBe(400);
  });

  it('is refused for a server that is not there', async () => {
    const { h, agent } = await boot(async <T>() => ({ ok: true, tools: [] }) as T);
    const res = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/mcp-servers/nope`,
      payload: { tool_filter: { include: [], exclude: null } },
    });
    expect(res.statusCode).toBe(404);
  });
});
