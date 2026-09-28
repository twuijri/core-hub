/**
 * MCP OAuth through the hub's own routes (DECISIONS §122), with Hermes's `hermes mcp login`
 * played by `testing/fake-mcp-login.ts` — a listener on the port the hub wrote, which takes the
 * callback, writes the tokens into the profile's home and says "Authenticated" — and Hermes's
 * test answered by a scripted API. The real command is `mcp-oauth.real.test.ts`. The last test
 * is the promise that matters most: no token value appears in any answer or any log line.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, capturingLogger, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import type { HermesApiCall } from './hermes-tools.js';
import { fakeMcpLogin, type FakeMcpLoginOptions } from './testing/fake-mcp-login.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

const ACCESS = 'at-9f8e7d6c5b4a-SECRET';
const REFRESH = 'rt-1a2b3c4d5e6f-SECRET';
const CLIENT_SECRET = 'cs-0011223344-SECRET';
const CODE = 'code-5566778899-SECRET';

/** Hermes's test: the tools once the profile holds a token, its sentence before. */
const hermesApi =
  (root: string): HermesApiCall =>
  async <T>(_method: string, route: string): Promise<T> => {
    const profile = new URL(route, 'http://hermes').searchParams.get('profile') ?? 'default';
    const home = profile === 'default' ? root : path.join(root, 'profiles', profile);
    try {
      readFileSync(path.join(home, 'mcp-tokens', 'clickup.json'));
    } catch {
      return {
        ok: false,
        error: 'OAuth authentication required — no token found.',
        tools: [],
      } as T;
    }
    return {
      ok: true,
      tools: [
        { name: 'get_tasks', description: 'List tasks.' },
        { name: 'create_task', description: 'Create a task.' },
        { name: 'get_workspace_hierarchy', description: 'The hierarchy.' },
      ],
    } as T;
  };

async function boot(
  logger?: ReturnType<typeof capturingLogger>['logger'],
  login: FakeMcpLoginOptions = {},
) {
  const calls: NonNullable<FakeMcpLoginOptions['calls']> = [];
  let root = '';
  hub = await signedInHub(
    {},
    {
      ...(logger ? { logger } : {}),
      agents: {
        adapterOptions: { hermes: { fetchImpl: healthy } },
        hermesApi: (...args) => hermesApi(root)(...args),
        mcpLogin: fakeMcpLogin({
          code: CODE,
          accessToken: ACCESS,
          refreshToken: REFRESH,
          calls,
          ...login,
        }),
      },
    },
  );
  root = path.join(hub.dataDir, 'hermes');
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'config.yaml'),
    [
      '# the person’s own comment',
      'mcp_servers:',
      '  clickup:',
      '    url: https://mcp.clickup.example/mcp',
      '  local:',
      '    command: node',
      '',
    ].join('\n'),
  );
  return { hub, agent, root, calls };
}

const servers = async (h: Hub, agent: string, profile = 'default') =>
  (
    (
      await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/agents/${agent}/mcp-servers`,
        profile,
      })
    ).json() as { items: Array<{ name: string; oauth?: { status: string; required: boolean } }> }
  ).items;

interface Flow {
  id: string;
  status: string;
  authorization_url: string | null;
  redirect_uri: string;
  error: string | null;
  tools: Array<{ name: string }>;
}

const start = async (h: Hub, agent: string, payload?: unknown, profile = 'default') =>
  authed(h, h.token, {
    method: 'POST',
    url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth`,
    profile,
    ...(payload ? { payload } : {}),
  });

describe('connecting an MCP server by OAuth', () => {
  it('prepares the block, starts Hermes’s login, hands the callback to its listener with `iss`, and says connected only once signed in', async () => {
    const { hub: h, agent, root, calls } = await boot();
    expect((await servers(h, agent)).map((s) => [s.name, s.oauth?.status ?? null])).toEqual([
      ['clickup', 'not_connected'],
      ['local', null],
    ]);

    const started = await start(h, agent, { hub_url: 'https://tunnel.example' });
    expect(started.statusCode, started.body).toBe(200);
    const flow = started.json() as Flow;
    expect(flow).toMatchObject({
      status: 'pending',
      redirect_uri: 'https://tunnel.example/api/v1/mcp-oauth/callback/clickup',
    });
    expect(flow.authorization_url).toContain('state=state-1');
    expect(flow.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(calls.map((c) => c.argv)).toEqual([['mcp', 'login', 'clickup']]);
    expect(calls[0]!.home).toBe(root);
    // The block Hermes's login needs; the comment and the other server stay.
    const config = readFileSync(path.join(root, 'config.yaml'), 'utf8');
    expect(config).toContain('# the person’s own comment');
    expect(config).toMatch(
      / {2}clickup:\n {4}url: https:\/\/mcp\.clickup\.example\/mcp\n {4}auth: oauth\n {4}oauth:\n {6}redirect_uri: https:\/\/tunnel\.example\/api\/v1\/mcp-oauth\/callback\/clickup\n {6}redirect_port: \d+/,
    );
    expect(config).toContain('  local:\n    command: node');

    const poll = async () =>
      (
        await authed(h, h.token, {
          method: 'GET',
          url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth/${flow.id}`,
        })
      ).json() as Flow;
    expect((await poll()).status).toBe('pending');

    // The provider sends the browser back: no session; the query reaches Hermes as it came.
    const back = await h.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-oauth/callback/clickup?code=${CODE}&state=state-1&iss=https%3A%2F%2Fauth.example`,
      headers: { 'accept-language': 'ar' },
    });
    expect(back.statusCode).toBe(200);
    expect(back.headers['content-type']).toContain('text/html');
    expect(calls[0]!.query).toBe(`code=${CODE}&state=state-1&iss=https%3A%2F%2Fauth.example`);
    // The page waited for Hermes: connected, with the tools it listed.
    expect(back.body).toContain('data-outcome="connected"');
    expect(back.body).toContain('عدد الأدوات التي يعرضها: 3');
    expect(back.body).toContain('dir="rtl"');

    const done = await poll();
    expect(done.status).toBe('approved');
    expect(done.tools.map((tool) => tool.name)).toEqual([
      'get_tasks',
      'create_task',
      'get_workspace_hierarchy',
    ]);
    expect((await servers(h, agent))[0]).toMatchObject({
      name: 'clickup',
      oauth: { status: 'connected', required: true },
      // The sign-in that landed is the server's last test now (DECISIONS §134).
      last_test: { ok: true, tool_count: 3, stale: false },
    });

    // Used once: the same callback again is an ended sign-in, said as such.
    const again = await h.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-oauth/callback/clickup?code=${CODE}&state=state-1`,
    });
    expect(again.body).toContain('data-outcome="expired"');
  });

  it('says the sign-in failed, with Hermes’s reason, when Hermes took the code but got no token', async () => {
    const { hub: h, agent } = await boot(undefined, {
      failWith: 'Token exchange failed (400): invalid_grant',
    });
    const flow = (await start(h, agent)).json() as Flow;
    const back = await h.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-oauth/callback/clickup?code=${CODE}&state=state-1`,
      headers: { 'accept-language': 'en' },
    });
    expect(back.body).toContain('data-outcome="failed"');
    expect(back.body).not.toMatch(/received|Connected/);
    expect(back.body).toContain('invalid_grant');
    const polled = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth/${flow.id}`,
    });
    expect(polled.json()).toMatchObject({ status: 'failed' });
    expect((polled.json() as Flow).error).toMatch(/invalid_grant/);
    expect((await servers(h, agent))[0]?.oauth?.status).toBe('not_connected');
  });

  it('says declined when the person refused at the provider', async () => {
    const { hub: h, agent } = await boot();
    await start(h, agent);
    const back = await h.app.inject({
      method: 'GET',
      url: '/api/v1/mcp-oauth/callback/clickup?error=access_denied&state=state-1',
    });
    expect(back.body).toContain('data-outcome="declined"');
  });

  it("uses the request's own address without `hub_url`, and keeps a redirect the person wrote", async () => {
    const { hub: h, agent, root } = await boot();
    const first = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth`,
      headers: { host: 'hub.lan:8080' },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      redirect_uri: 'http://hub.lan:8080/api/v1/mcp-oauth/callback/clickup',
    });

    writeFileSync(
      path.join(root, 'config.yaml'),
      'mcp_servers:\n  clickup:\n    url: https://mcp.clickup.example/mcp\n    oauth:\n      redirect_uri: https://my-proxy.example/cb\n',
    );
    const second = await start(h, agent, { hub_url: 'https://tunnel.example' });
    expect(second.json()).toMatchObject({ redirect_uri: 'https://my-proxy.example/cb' });
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).toContain(
      'redirect_uri: https://my-proxy.example/cb',
    );
  });

  it('refuses a stdio server, a bad hub_url, a missing server and a flow of another profile', async () => {
    const { hub: h, agent, root } = await boot();
    const named = (name: string, payload?: unknown) =>
      authed(h, h.token, {
        method: 'POST',
        url: `/api/v1/agents/${agent}/mcp-servers/${name}/oauth`,
        ...(payload ? { payload } : {}),
      });
    expect((await named('local')).json()).toMatchObject({
      code: 'conflict',
      details: { reason: 'mcp_oauth_stdio' },
    });
    expect((await named('clickup', { hub_url: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await named('nope')).statusCode).toBe(404);

    const flow = (await named('clickup')).json() as Flow;
    await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true });
    const elsewhere = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth/${flow.id}`,
      profile: 'work',
    });
    expect(elsewhere.statusCode).toBe(404);
    // Each profile signs in on its own: the other profile's list knows nothing of this one.
    writeFileSync(
      path.join(root, 'profiles', 'work', 'config.yaml'),
      'mcp_servers:\n  clickup:\n    url: https://mcp.clickup.example/mcp\n    auth: oauth\n',
    );
    expect((await servers(h, agent, 'work'))[0]).toMatchObject({
      oauth: { status: 'not_connected', required: true },
    });
  });

  it('cancels a sign-in by ending Hermes’s login; a new one ends the one before', async () => {
    const { hub: h, agent } = await boot();
    const flow = (await start(h, agent)).json() as Flow;
    const cancelled = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth/${flow.id}`,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const late = await h.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-oauth/callback/clickup?code=${CODE}&state=state-1`,
    });
    expect(late.body).toContain('data-outcome="expired"');

    const second = (await start(h, agent)).json() as Flow;
    const third = (await start(h, agent)).json() as Flow;
    const replaced = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth/${second.id}`,
    });
    expect(replaced.json()).toMatchObject({ status: 'cancelled' });
    expect(third.status).toBe('pending');
  });

  it('says so when this hub runs no Hermes to sign in with', async () => {
    hub = await signedInHub({}, { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } });
    const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
    const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
      (row) => row.kind === 'hermes',
    )!.id;
    const home = path.join(hub.dataDir, 'hermes');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, 'config.yaml'),
      'mcp_servers:\n  clickup:\n    url: https://x.example/mcp\n',
    );
    const none = await start(hub, agent);
    expect(none.json()).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'hermes_not_supervised' },
    });
  });

  it("disconnects by deleting that profile's sign-in files and says not connected", async () => {
    const { hub: h, agent, root } = await boot();
    const dir = path.join(root, 'mcp-tokens');
    mkdirSync(dir, { recursive: true });
    for (const suffix of ['.json', '.client.json', '.meta.json']) {
      writeFileSync(path.join(dir, `clickup${suffix}`), JSON.stringify({ access_token: ACCESS }));
    }
    expect((await servers(h, agent))[0]?.oauth?.status).toBe('connected');
    const res = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/mcp-servers/clickup/oauth`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'clickup', oauth: { status: 'not_connected' } });
    expect((await servers(h, agent))[0]?.oauth?.status).toBe('not_connected');
  });

  it('answers the callback of a sign-in it does not know with a page, never success', async () => {
    hub = await signedInHub();
    const res = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/mcp-oauth/callback/clickup?code=x&state=y',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-outcome="expired"');
  });
});

describe('no token value leaves Hermes’s files', () => {
  it('appears in no answer and no log line, the callback’s code included', async () => {
    const captured = capturingLogger();
    const { hub: h, agent, root } = await boot(captured.logger);
    // A secret the person put in the block itself, one level down, is masked as well.
    writeFileSync(
      path.join(root, 'config.yaml'),
      `mcp_servers:\n  clickup:\n    url: https://mcp.clickup.example/mcp\n    headers:\n      Authorization: Bearer ${ACCESS}\n    oauth:\n      client_secret: ${CLIENT_SECRET}\n`,
    );
    const bodies: string[] = [];
    const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
      const res = await authed(h, h.token, { method, url, ...(payload ? { payload } : {}) });
      bodies.push(res.body);
      return res;
    };
    const flow = (
      await call('POST', `/api/v1/agents/${agent}/mcp-servers/clickup/oauth`, {
        hub_url: 'https://hub.example',
      })
    ).json() as { id: string };
    const back = await h.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-oauth/callback/clickup?code=${CODE}&state=state-1`,
    });
    bodies.push(back.body);
    await call('GET', `/api/v1/agents/${agent}/mcp-servers/clickup/oauth/${flow.id}`);
    await call('GET', `/api/v1/agents/${agent}/mcp-servers`);
    await call('DELETE', `/api/v1/agents/${agent}/mcp-servers/clickup/oauth`);

    // The files did hold the values: the check below is not vacuous.
    expect(bodies.join('\n')).toContain('get_tasks');
    const logs = captured.lines.map((line) => JSON.stringify(line)).join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [ACCESS, REFRESH, CLIENT_SECRET, CODE]) {
      expect(bodies.join('\n')).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});
