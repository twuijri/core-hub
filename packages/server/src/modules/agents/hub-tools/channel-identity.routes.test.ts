/**
 * Messages on a channel and the hub's own tools (contract decision §79), through the routes a
 * person, an admin and the hub's hook in Hermes's messaging gateway use:
 *
 * - a person proves a Telegram or WhatsApp account with a one-time code sent to the bot, which
 *   the hook hands to the hub (`agents.hubChannelEvent`, `link`), and sees and removes the link;
 *   an admin sees and removes anyone's;
 * - a turn from a linked account opens a channel lease for that person, and a call from the
 *   gateway (`X-Corehub-Origin: gateway`) then acts as them; an account nobody linked, a group
 *   chat, or a person who may not enter the profile gets no tools;
 * - a gateway's call never borrows a person's live chat in the hub, and a hub process's call
 *   never a channel turn.
 *
 * Before this change a message from a channel had no hub tools at all
 * (`hub_tools_no_live_run`), and none of these operations existed.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { runLeasesFor } from '../index.js';

type Hub = TestHub & { token: string; userId: string };

let current: { hub: Hub; agent: string; root: string } | null = null;

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(): Promise<{ hub: Hub; agent: string; root: string }> {
  if (current) return current;
  const hub = await signedInHub(
    { PORT: '8124' },
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

function keyOf(home: string): string {
  const line = readFileSync(path.join(home, '.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('COREHUB_MCP_TOKEN='));
  return line!.slice('COREHUB_MCP_TOKEN='.length);
}

async function event(h: Hub, key: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/hub-mcp/channel-events',
    headers: { authorization: `Bearer ${key}` },
    payload: { sender_id: null, session_id: null, chat_type: null, code: null, ...body },
  });
}

let nextId = 1;
async function call(
  h: Hub,
  key: string,
  origin: 'hub' | 'gateway' | null,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/hub-mcp',
    headers: {
      authorization: `Bearer ${key}`,
      ...(origin ? { 'x-corehub-origin': origin } : {}),
    },
    payload: {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const result = res.json().result as { isError: boolean; content: Array<{ text: string }> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: result.isError, body: JSON.parse(result.content[0]!.text) as any };
}

async function signIn(h: Hub, username: string, profiles: string[], role = 'member') {
  const created = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/auth/users',
    payload: { username, password: `${username}-password-1`, role, profiles },
  });
  expect(created.statusCode, created.body).toBe(201);
  const login = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: `${username}-password-1` },
  });
  return { id: created.json().id as string, token: login.json().access_token as string };
}

async function codeFor(h: Hub, token: string): Promise<string> {
  const res = await authed(h, token, {
    method: 'POST',
    url: '/api/v1/auth/me/channel-identities/link-codes',
  });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.json().command).toBe(`/start ${res.json().code}`);
  expect(res.json().code).toMatch(/^corehub_[A-Z2-9]{10}$/);
  return res.json().code as string;
}

describe('channel identities: a message on a channel acts for the person who linked its sender', () => {
  afterAll(async () => {
    await current?.hub.close();
    current = null;
  });

  it('writes the hook beside the block when the tools go on, and removes it when they go off', async () => {
    const { hub: h, agent, root } = await boot();
    const on = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      payload: { enabled: true, groups: [{ id: 'tasks', allow_writes: true }] },
    });
    expect(on.statusCode, on.body).toBe(200);
    const manifest = readFileSync(path.join(root, 'hooks', 'corehub', 'HOOK.yaml'), 'utf8');
    expect(manifest).toContain('agent:start');
    expect(manifest).toContain('command:start');
    const handler = readFileSync(path.join(root, 'hooks', 'corehub', 'handler.py'), 'utf8');
    expect(handler).toContain('"http://127.0.0.1:8124/api/v1/hub-mcp/channel-events"');
    // The block's second header carries where a call came from.
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).toContain(
      'X-Corehub-Origin: ${COREHUB_MCP_ORIGIN}',
    );

    await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      payload: { enabled: false },
    });
    expect(existsSync(path.join(root, 'hooks', 'corehub'))).toBe(false);
    await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/hub-tools`,
      payload: { enabled: true },
    });
    expect(existsSync(path.join(root, 'hooks', 'corehub', 'handler.py'))).toBe(true);
  });

  it('links an account proved with a one-time code, once, and never a second person', async () => {
    const { hub: h, root } = await boot();
    const key = keyOf(root);
    const code = await codeFor(h, h.token);

    // Not the hub's code: the gateway passes `/start` on as usual.
    const ping = await event(h, key, {
      event: 'link',
      platform: 'telegram',
      sender_id: '4242',
      code: 'hello',
    });
    expect(ping.json()).toEqual({ handled: false, message: null });

    const bad = await event(h, 'hub_mcp_nope', {
      event: 'link',
      platform: 'telegram',
      sender_id: '4242',
      code,
    });
    expect(bad.statusCode).toBe(401);

    const linked = await event(h, key, {
      event: 'link',
      platform: 'telegram',
      sender_id: '4242',
      code,
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().handled).toBe(true);
    expect(linked.json().message).toMatch(/تم الربط|Linked/);

    const mine = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/auth/me/channel-identities',
    });
    expect(mine.json().items).toEqual([
      expect.objectContaining({
        platform: 'telegram',
        sender_id: '4242',
        user_id: h.userId,
        last_used_at: null,
      }),
    ]);

    // A code works once.
    const again = await event(h, key, {
      event: 'link',
      platform: 'telegram',
      sender_id: '4242',
      code,
    });
    expect(again.json().handled).toBe(true);
    expect(again.json().message).toContain('not valid');

    // Somebody else cannot take an account that is linked.
    const other = await signIn(h, 'sara', ['default']);
    const theirs = await codeFor(h, other.token);
    const taken = await event(h, key, {
      event: 'link',
      platform: 'telegram',
      sender_id: '4242',
      code: theirs,
    });
    expect(taken.json().message).toContain('someone else');
    // A code is spent by its first use, whatever came of it: Sara makes another.
    const fresh = await codeFor(h, other.token);
    const discord = await event(h, key, {
      event: 'link',
      platform: 'discord',
      sender_id: '77',
      code: fresh,
    });
    expect(discord.json().message).toContain('Telegram or WhatsApp');
    const whatsapp = await event(h, key, {
      event: 'link',
      platform: 'whatsapp',
      sender_id: '966500000000@s.whatsapp.net',
      code: fresh,
    });
    expect(whatsapp.json().handled).toBe(true);
    const saras = await authed(h, other.token, {
      method: 'GET',
      url: '/api/v1/auth/me/channel-identities',
    });
    expect(saras.json().items).toEqual([
      expect.objectContaining({ platform: 'whatsapp', user_id: other.id }),
    ]);

    // An admin sees every link; a member sees only their own and cannot remove somebody else's.
    const all = await authed(h, h.token, { method: 'GET', url: '/api/v1/auth/channel-identities' });
    expect(all.json().items).toHaveLength(2);
    const listAll = await authed(h, other.token, {
      method: 'GET',
      url: '/api/v1/auth/channel-identities',
    });
    expect(listAll.statusCode).toBe(403);
    const ownerLink = mine.json().items[0].id as string;
    const notTheirs = await authed(h, other.token, {
      method: 'DELETE',
      url: `/api/v1/auth/me/channel-identities/${ownerLink}`,
    });
    expect(notTheirs.statusCode).toBe(404);
  });

  it("acts as the linked person for a gateway's call, and for nobody when the sender is a stranger", async () => {
    const { hub: h, root } = await boot();
    const key = keyOf(root);
    const workspace = (await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' }))
      .json()
      .items.find((p: { slug: string }) => p.slug === 'default').id as string;

    // Nothing live: as before, nobody to act for.
    expect((await call(h, key, 'gateway', 'tasks.list')).body.code).toBe('hub_tools_no_live_run');

    const start = await event(h, key, {
      event: 'turn_started',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-session-1',
      chat_type: 'dm',
    });
    expect(start.statusCode, start.body).toBe(200);
    const made = await call(h, key, 'gateway', 'tasks.create', { title: 'From Telegram' });
    expect(made.isError, JSON.stringify(made.body)).toBe(false);
    const board = await authed(h, h.token, { method: 'GET', url: '/api/v1/tasks' });
    const task = board.json().items.find((t: { title: string }) => t.title === 'From Telegram');
    expect(task.owner_id).toBe(h.userId);
    const mine = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/auth/me/channel-identities',
    });
    expect(mine.json().items[0].last_used_at).not.toBeNull();

    await event(h, key, {
      event: 'turn_step',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-session-1',
    });
    await event(h, key, {
      event: 'turn_ended',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-session-1',
    });
    expect((await call(h, key, 'gateway', 'tasks.list')).body.code).toBe('hub_tools_no_live_run');

    // A stranger's turn: no tools, and it says why.
    await event(h, key, {
      event: 'turn_started',
      platform: 'telegram',
      sender_id: '9999',
      session_id: 'tg-session-2',
      chat_type: 'dm',
    });
    const stranger = await call(h, key, 'gateway', 'tasks.create', { title: 'Stranger' });
    expect(stranger.isError).toBe(true);
    expect(stranger.body.code).toBe('hub_tools_sender_not_linked');

    // The owner's own chat in the hub is live at the same time: the stranger's gateway call
    // still acts for nobody, and a call from the hub's own process is the owner's run.
    const leases = runLeasesFor(h.app);
    leases.open({
      runId: 'RUNOWNER',
      sessionId: 'SESOWNER',
      workspaceId: workspace,
      userId: h.userId,
    });
    expect((await call(h, key, 'gateway', 'tasks.create', { title: 'Borrowed' })).body.code).toBe(
      'hub_tools_sender_not_linked',
    );
    const fromHub = await call(h, key, 'hub', 'tasks.list');
    expect(fromHub.isError, JSON.stringify(fromHub.body)).toBe(false);
    // Unknown origin (a Hermes the hub did not start): the two cannot be told apart.
    expect((await call(h, key, null, 'tasks.list')).body.code).toBe('hub_tools_run_ambiguous');
    leases.close('RUNOWNER');
    await event(h, key, {
      event: 'turn_ended',
      platform: 'telegram',
      sender_id: '9999',
      session_id: 'tg-session-2',
    });

    const titles = (await authed(h, h.token, { method: 'GET', url: '/api/v1/tasks' }))
      .json()
      .items.map((t: { title: string }) => t.title);
    expect(titles).not.toContain('Stranger');
    expect(titles).not.toContain('Borrowed');
  });

  it('gives no tools to a group chat, to a person outside the profile, or after an unlink', async () => {
    const { hub: h, root } = await boot();
    const key = keyOf(root);

    await event(h, key, {
      event: 'turn_started',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-group',
      chat_type: 'group',
    });
    expect((await call(h, key, 'gateway', 'tasks.list')).body.code).toBe('hub_tools_group_chat');
    await event(h, key, {
      event: 'turn_ended',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-group',
    });

    // A member granted another profile only, linked from WhatsApp.
    await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'work' },
    });
    const outsider = await signIn(h, 'omar', ['work']);
    const code = await codeFor(h, outsider.token);
    const linked = await event(h, key, {
      event: 'link',
      platform: 'whatsapp',
      sender_id: '555@lid',
      code,
    });
    expect(linked.json().handled).toBe(true);
    await event(h, key, {
      event: 'turn_started',
      platform: 'whatsapp',
      sender_id: '555@lid',
      session_id: 'wa-1',
      chat_type: 'dm',
    });
    expect((await call(h, key, 'gateway', 'tasks.list')).body.code).toBe(
      'hub_tools_sender_no_access',
    );
    await event(h, key, {
      event: 'turn_ended',
      platform: 'whatsapp',
      sender_id: '555@lid',
      session_id: 'wa-1',
    });

    // The owner unlinks their Telegram: its next turn gets nothing.
    const mine = await authed(h, h.token, {
      method: 'GET',
      url: '/api/v1/auth/me/channel-identities',
    });
    const link = mine.json().items.find((i: { platform: string }) => i.platform === 'telegram')
      .id as string;
    const gone = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/auth/me/channel-identities/${link}`,
    });
    expect(gone.statusCode).toBe(204);
    await event(h, key, {
      event: 'turn_started',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-3',
      chat_type: 'dm',
    });
    expect((await call(h, key, 'gateway', 'tasks.list')).body.code).toBe(
      'hub_tools_sender_not_linked',
    );
    await event(h, key, {
      event: 'turn_ended',
      platform: 'telegram',
      sender_id: '4242',
      session_id: 'tg-3',
    });

    // An admin removes somebody else's link.
    const all = await authed(h, h.token, { method: 'GET', url: '/api/v1/auth/channel-identities' });
    const omars = all.json().items.find((i: { user_id: string }) => i.user_id === outsider.id).id;
    const removed = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/auth/channel-identities/${omars}`,
    });
    expect(removed.statusCode).toBe(204);
    const left = await authed(h, outsider.token, {
      method: 'GET',
      url: '/api/v1/auth/me/channel-identities',
    });
    expect(left.json().items).toEqual([]);
  });
});
