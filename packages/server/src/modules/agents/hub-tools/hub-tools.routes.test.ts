/**
 * The hub's own tools (contract decision §67), through the routes a person and an agent use:
 *
 * - the card switches them on per profile, which writes one `corehub` block into that
 *   profile's Hermes `config.yaml` and its key into the profile's `.env` — and off again;
 * - the MCP endpoint answers the protocol with the key alone, but acts only while a run of
 *   the hub's is live in the key's profile, and then as that run's owner: the same routes,
 *   the same permission checks, that profile only, never an admin;
 * - each tool is the REST operation it names (a task created by `tasks.create` is the one the
 *   board lists), a write is offered only where its group allows writes, and the files stay
 *   inside the profile's folder.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { runLeasesFor } from '../index.js';

type Hub = TestHub & { token: string; userId: string };

/**
 * One hub per `describe`, its tests in order: booting a hub (migrations, Argon2id) is most of
 * a test's time, and these tests leave the state the next one expects.
 */
let current: { hub: Hub; agent: string; root: string } | null = null;
async function closeHub(): Promise<void> {
  await current?.hub.close();
  current = null;
}

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(): Promise<{ hub: Hub; agent: string; root: string }> {
  if (current) return current;
  const hub = await signedInHub(
    { PORT: '8123' },
    { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } },
  );
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const root = path.join(hub.dataDir, 'hermes');
  mkdirSync(root, { recursive: true });
  current = { hub, agent, root };
  return current;
}

interface Rpc {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 1;
async function rpc(h: Hub, key: string | null, method: string, params?: unknown) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/hub-mcp',
    headers: key ? { authorization: `Bearer ${key}` } : {},
    payload: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) },
  });
  return res;
}

async function call(h: Hub, key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(h, key, 'tools/call', { name, arguments: args });
  expect(res.statusCode, res.body).toBe(200);
  const result = (res.json() as Rpc).result as {
    isError: boolean;
    content: Array<{ text: string }>;
  };
  // A tool's answer is whatever JSON the tool returns; each test reads the fields it expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: result.isError, body: JSON.parse(result.content[0]!.text) as any };
}

function keyOf(home: string): string {
  const line = readFileSync(path.join(home, '.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('COREHUB_MCP_TOKEN='));
  return line!.slice('COREHUB_MCP_TOKEN='.length);
}

async function enable(h: Hub, agent: string, profile: string, groups?: unknown) {
  const res = await authed(h, h.token, {
    method: 'PATCH',
    url: `/api/v1/agents/${agent}/hub-tools`,
    profile,
    payload: { enabled: true, ...(groups ? { groups } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    enabled: boolean;
    url: string;
    groups: Array<{ id: string; enabled: boolean; allow_writes: boolean; tools: unknown[] }>;
    recent_calls: Array<{
      tool: string;
      ok: boolean;
      user_id: string | null;
      error_code: string | null;
    }>;
  };
}

describe("the hub's own tools: the card and the profile's Hermes config", () => {
  afterAll(closeHub);

  it('is off until an admin switches it on; on writes the block and the key, off removes both', async () => {
    const { hub: h, agent, root } = await boot();
    const before = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/hub-tools`,
    });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      enabled: false,
      available: true,
      server_name: 'corehub',
    });
    // Switched on, every group reads and none writes until someone says so.
    expect(
      (before.json().groups as Array<{ enabled: boolean; allow_writes: boolean }>).every(
        (g) => g.enabled && !g.allow_writes,
      ),
    ).toBe(true);
    writeFileSync(path.join(root, 'config.yaml'), '# mine\nmodel:\n  default: x\n');

    const on = await enable(h, agent, 'default');
    expect(on.enabled).toBe(true);
    expect(on.url).toBe('http://127.0.0.1:8123/api/v1/hub-mcp');
    const config = readFileSync(path.join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('# mine');
    expect(config).toContain('Managed by Core Hub');
    expect(config).toContain('url: http://127.0.0.1:8123/api/v1/hub-mcp');
    expect(config).toContain('Authorization: Bearer ${COREHUB_MCP_TOKEN}');
    const key = keyOf(root);
    expect(key).toMatch(/^hub_mcp_[0-9a-f]{48}$/);
    // The key is in `.env`, never in the config a profile export carries.
    expect(config).not.toContain(key);
    expect((await rpc(h, key, 'ping')).statusCode).toBe(200);

    // The block is the card's: the generic MCP page cannot edit or delete it.
    const edit = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/mcp-servers/corehub`,
      payload: { enabled: false },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().details.reason).toBe('mcp_managed');

    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).not.toContain('corehub');
    expect(readFileSync(path.join(root, '.env'), 'utf8')).not.toContain('COREHUB_MCP_TOKEN');
    expect((await rpc(h, key, 'ping')).statusCode).toBe(401);
  });

  it('only an admin changes it', async () => {
    const { hub: h, agent } = await boot();
    await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'mem', password: 'mem-password-1' },
    });
    const member = login.json().access_token as string;
    const res = await authed(h, member, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });

  // A coding agent over ACP is handed the same server.
  it('is given the same server with the profile key while the tools are on, and nothing when off', async () => {
    const { hub: h, agent, root } = await boot();
    const { hubToolsFor } = await import('../index.js');
    const workspace = (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' }))
      .json()
      .items.find((p: { slug: string }) => p.slug === 'default').id as string;
    expect(hubToolsFor(h.app).acpServersFor(workspace)).toEqual([]);
    await enable(h, agent, 'default');
    expect(hubToolsFor(h.app).acpServersFor(workspace)).toEqual([
      {
        type: 'http',
        name: 'corehub',
        url: 'http://127.0.0.1:8123/api/v1/hub-mcp',
        headers: [
          { name: 'Authorization', value: `Bearer ${keyOf(root)}` },
          // A coding agent is always one of the hub's own runs (§79).
          { name: 'X-Corehub-Origin', value: 'hub' },
        ],
      },
    ]);
    await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      payload: { enabled: false },
    });
    expect(hubToolsFor(h.app).acpServersFor(workspace)).toEqual([]);
  });

  it('puts a block a person edited back at boot, with a new key when the old one is gone', async () => {
    const { hub: h, agent, root } = await boot();
    await enable(h, agent, 'default');
    const first = keyOf(root);
    writeFileSync(path.join(root, 'config.yaml'), 'mcp_servers: {}\n');
    writeFileSync(path.join(root, '.env'), '');
    const { hubToolsFor } = await import('../index.js');
    hubToolsFor(h.app).syncAll();
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).toContain('corehub');
    const second = keyOf(root);
    expect(second).not.toBe(first);
    expect((await rpc(h, first, 'ping')).statusCode).toBe(401);
    expect((await rpc(h, second, 'ping')).statusCode).toBe(200);
  });
});

describe("the hub's own tools: the MCP endpoint", () => {
  afterAll(closeHub);

  it('speaks the protocol with the key alone and lists only what the groups offer', async () => {
    const { hub: h, agent, root } = await boot();
    expect((await rpc(h, null, 'ping')).statusCode).toBe(401);
    expect((await rpc(h, 'hub_mcp_nope', 'ping')).statusCode).toBe(401);
    await enable(h, agent, 'default', [{ id: 'tasks', allow_writes: true }]);
    const key = keyOf(root);

    const init = await rpc(h, key, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.json()).toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'corehub' },
      },
    });
    const note = await h.app.inject({
      method: 'POST',
      url: '/api/v1/hub-mcp',
      headers: { authorization: `Bearer ${key}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(note.statusCode).toBe(202);
    expect(note.body).toBe('');

    const list = await rpc(h, key, 'tools/list');
    const names = ((list.json() as Rpc).result!.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(names).toContain('tasks.create');
    expect(names).toContain('files.read');
    expect(names).not.toContain('files.write'); // files reads only
    expect(names).not.toContain('notifications.notify'); // a write, not allowed there
    expect((await rpc(h, key, 'no/such')).json().error.code).toBe(-32601);
  });

  it('acts only while a run is live, as its owner, through the REST routes', async () => {
    const { hub: h, agent, root } = await boot();
    await enable(h, agent, 'default', [{ id: 'tasks', allow_writes: true }]);
    const key = keyOf(root);

    const idle = await call(h, key, 'tasks.create', { title: 'nobody asked' });
    expect(idle).toMatchObject({ isError: true, body: { code: 'hub_tools_no_live_run' } });

    const workspace = (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' }))
      .json()
      .items.find((p: { slug: string }) => p.slug === 'default').id as string;
    const leases = runLeasesFor(h.app);
    leases.open({ runId: 'RUN1', sessionId: 'SES1', workspaceId: workspace, userId: h.userId });

    const made = await call(h, key, 'tasks.create', { title: 'Write the release notes' });
    expect(made.isError, JSON.stringify(made.body)).toBe(false);
    expect(made.body.task).toMatchObject({ title: 'Write the release notes', status: 'triage' });
    const board = await authed(h, h.token, { method: 'GET', url: '/api/v1/tasks' });
    expect(
      (board.json().items as Array<{ id: string; title: string }>).map((t) => t.title),
    ).toContain('Write the release notes');

    const moved = await call(h, key, 'tasks.move', { task_id: made.body.task.id, status: 'todo' });
    expect(moved.body.task.status).toBe('todo');
    const listed = await call(h, key, 'tasks.list', { status: 'todo' });
    expect(listed.body.tasks.map((t: { id: string }) => t.id)).toEqual([made.body.task.id]);
    // A REST refusal comes back in the hub's words.
    const bad = await call(h, key, 'tasks.move', {
      task_id: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
      status: 'todo',
    });
    expect(bad).toMatchObject({ isError: true, body: { code: 'not_found' } });

    // A group that does not write refuses its writes even when asked by name.
    const denied = await call(h, key, 'files.write', { path: 'x.txt', content: 'x' });
    expect(denied.body.code).toBe('hub_tools_tool_off');

    leases.close('RUN1');
    expect((await call(h, key, 'tasks.list')).body.code).toBe('hub_tools_no_live_run');

    const card = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/hub-tools`,
    });
    const calls = card.json().recent_calls as Array<{
      tool: string;
      ok: boolean;
      user_id: string | null;
      session_id: string | null;
      error_code: string | null;
    }>;
    expect(calls[0]).toMatchObject({
      tool: 'tasks.list',
      ok: false,
      error_code: 'hub_tools_no_live_run',
      user_id: null,
    });
    expect(calls.find((c) => c.tool === 'tasks.create' && c.ok)).toMatchObject({
      user_id: h.userId,
      session_id: 'SES1',
    });
  });

  it("a member's run reaches that member's profile only, and never as an admin", async () => {
    const { hub: h, agent, root } = await boot();
    const asOwner = (method: 'GET' | 'POST', url: string, payload?: unknown, profile?: string) =>
      authed(h, h.token, {
        method,
        url,
        ...(payload ? { payload } : {}),
        ...(profile ? { profile } : {}),
      });
    const work = (
      await asOwner('POST', '/api/v1/profiles', { slug: 'work', name: 'Work' })
    ).json() as {
      id: string;
    };
    const workHome = path.join(root, 'profiles', 'work');
    mkdirSync(workHome, { recursive: true });
    const member = (
      await asOwner('POST', '/api/v1/auth/users', {
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['work'],
      })
    ).json() as { id: string };
    await asOwner('POST', '/api/v1/tasks', { title: 'default secret' });
    await asOwner('POST', '/api/v1/tasks', { title: 'work item' }, 'work');

    await enable(h, agent, 'work', [{ id: 'tasks', allow_writes: true }]);
    await enable(h, agent, 'default');
    const workKey = keyOf(workHome);
    const defaultKey = keyOf(root);
    expect(workKey).not.toBe(defaultKey);

    const leases = runLeasesFor(h.app);
    leases.open({ runId: 'RUNM', sessionId: 'SESM', workspaceId: work.id, userId: member.id });

    const seen = await call(h, workKey, 'tasks.list');
    expect(seen.body.tasks.map((t: { title: string }) => t.title)).toEqual(['work item']);
    // The default profile's key finds no run of its own: the member's run is not there.
    expect((await call(h, defaultKey, 'tasks.list')).body.code).toBe('hub_tools_no_live_run');

    // The run's token itself: that profile only, and a member's reach whoever the person is.
    const token = leases.live(work.id)[0]!.token;
    const elsewhere = await authed(h, token, {
      method: 'GET',
      url: '/api/v1/tasks',
      profile: 'default',
    });
    expect(elsewhere.statusCode).toBe(404);
    const across = await authed(h, token, {
      method: 'GET',
      url: '/api/v1/tasks?profiles=all',
      profile: 'work',
    });
    expect(across.statusCode, across.body).toBe(200);
    expect((across.json().items as Array<{ title: string }>).map((t) => t.title)).toEqual([
      'work item',
    ]);
    leases.close('RUNM');

    // Even the owner's run token is pinned and is not an admin.
    leases.open({ runId: 'RUNO', sessionId: 'SESO', workspaceId: work.id, userId: h.userId });
    const owners = leases.live(work.id)[0]!.token;
    expect(
      (await authed(h, owners, { method: 'GET', url: '/api/v1/tasks', profile: 'default' }))
        .statusCode,
    ).toBe(404);
    const adminOnly = await authed(h, owners, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      profile: 'work',
      payload: { enabled: false },
    });
    expect(adminOnly.statusCode).toBe(403);
    leases.close('RUNO');
    // Closed, the token is gone.
    expect(
      (await authed(h, owners, { method: 'GET', url: '/api/v1/tasks', profile: 'work' }))
        .statusCode,
    ).toBe(401);
  });

  it('refuses rather than guesses when two people run at once and neither announced the call', async () => {
    const { hub: h, agent, root } = await boot();
    const other = (
      await authed(h, h.token, {
        method: 'POST',
        url: '/api/v1/auth/users',
        payload: { username: 'two', password: 'two-password-1', role: 'admin' },
      })
    ).json() as { id: string };
    await enable(h, agent, 'default');
    const key = keyOf(root);
    const workspace = (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' }))
      .json()
      .items.find((p: { slug: string }) => p.slug === 'default').id as string;
    const leases = runLeasesFor(h.app);
    leases.open({ runId: 'A', sessionId: 'SA', workspaceId: workspace, userId: h.userId });
    leases.open({ runId: 'B', sessionId: 'SB', workspaceId: workspace, userId: other.id });

    const unsure = await call(h, key, 'conversations.list');
    expect(unsure.body.code).toBe('hub_tools_run_ambiguous');

    // The agent of run B announced a call to one of the hub's tools: that settles it.
    leases.toolStarted('B', 'mcp__corehub__conversations_list');
    const sure = await call(h, key, 'conversations.list');
    expect(sure.isError).toBe(false);
    const card = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/hub-tools`,
    });
    expect(card.json().recent_calls[0]).toMatchObject({
      ok: true,
      user_id: other.id,
      session_id: 'SB',
    });
    leases.toolEnded('B', 'mcp__corehub__conversations_list');
    leases.close('A');
    leases.close('B');
  }, 20_000);
});

describe("the hub's own tools: each group", () => {
  afterAll(closeHub);

  async function live(h: Hub, profile = 'default') {
    const workspace = (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' }))
      .json()
      .items.find((p: { slug: string }) => p.slug === profile).id as string;
    runLeasesFor(h.app).open({
      runId: 'R',
      sessionId: 'S',
      workspaceId: workspace,
      userId: h.userId,
    });
  }

  it('files: reads and (when allowed) writes inside the profile folder, never outside it', async () => {
    const { hub: h, agent, root } = await boot();
    await enable(h, agent, 'default', [{ id: 'files', allow_writes: true }]);
    const key = keyOf(root);
    await live(h);
    const folder = path.join(h.dataDir, 'workspaces', 'default');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(h.dataDir, 'outside.txt'), 'secret');

    const wrote = await call(h, key, 'files.write', { path: 'notes/today.md', content: 'hello' });
    expect(wrote.body).toMatchObject({ path: 'notes/today.md', bytes: 5 });
    expect(readFileSync(path.join(folder, 'notes', 'today.md'), 'utf8')).toBe('hello');
    expect((await call(h, key, 'files.read', { path: 'notes/today.md' })).body.content).toBe(
      'hello',
    );
    expect((await call(h, key, 'files.list', {})).body.entries).toEqual([
      { name: 'notes', type: 'folder', size: null },
    ]);
    for (const attempt of ['../outside.txt', '/../../outside.txt', 'notes/../../outside.txt']) {
      const out = await call(h, key, 'files.read', { path: attempt });
      expect(out.body.code, attempt).toBe('path_outside_profile');
    }
    symlinkSync(path.join(h.dataDir, 'outside.txt'), path.join(folder, 'link.txt'));
    expect((await call(h, key, 'files.read', { path: 'link.txt' })).body.code).toBe(
      'path_outside_profile',
    );
    expect(existsSync(path.join(h.dataDir, 'outside.txt'))).toBe(true);
  });

  it('schedules, workflows and conversations are the REST operations they name', async () => {
    const { hub: h, agent, root } = await boot();
    await enable(h, agent, 'default', [
      { id: 'schedules', allow_writes: true },
      { id: 'notifications', allow_writes: true },
    ]);
    const key = keyOf(root);
    await live(h);

    // The hub's own agent: a Hermes schedule would live in Hermes's scheduler, not here.
    const direct = (await authed(h, h.token, { method: 'GET', url: '/api/v1/agents' }))
      .json()
      .items.find((row: { kind: string }) => row.kind === 'builtin').id as string;
    const made = await call(h, key, 'schedules.create', {
      agent_id: direct,
      name: 'Morning digest',
      prompt: 'Summarise yesterday',
      cron: '0 7 * * *',
      timezone: 'Asia/Riyadh',
    });
    expect(made.isError, JSON.stringify(made.body)).toBe(false);
    const id = made.body.schedule.id as string;
    const listed = await call(h, key, 'schedules.list');
    expect(listed.body.schedules.map((s: { id: string }) => s.id)).toContain(id);
    const paused = await call(h, key, 'schedules.pause', { schedule_id: id });
    expect(paused.body.schedule.enabled).toBe(false);
    const rest = await authed(h, h.token, { method: 'GET', url: `/api/v1/schedules/${id}` });
    expect(rest.json()).toMatchObject({ name: 'Morning digest', enabled: false });
    expect((await call(h, key, 'schedules.create', { name: 'x', prompt: 'y' })).body.code).toBe(
      'validation_failed',
    );

    expect((await call(h, key, 'workflows.list')).body).toEqual({ workflows: [] });
    // Workflows read only: running one is a write this profile did not allow.
    expect((await call(h, key, 'workflows.run', { workflow_id: 'x' })).body.code).toBe(
      'hub_tools_tool_off',
    );

    const convs = await call(h, key, 'conversations.search', { query: 'nothing like it' });
    expect(convs.body).toEqual({ conversations: [] });

    const told = await call(h, key, 'notifications.notify', { title: 'Done', body: 'All green' });
    expect(told.body).toEqual({ notified: true });
    const inbox = await authed(h, h.token, { method: 'GET', url: '/api/v1/notify/notices' });
    expect(inbox.statusCode, inbox.body).toBe(200);
    expect(JSON.stringify(inbox.json())).toContain('All green');
  });
});
