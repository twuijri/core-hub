/**
 * The owner's web terminal, end to end on a real hub with a real shell (owner, 2026-09-25:
 * «الا خله للمشرف الرئيسي بس» — the main owner only).
 *
 * - off by default: `GET /terminal` is `403 terminal_disabled`, and `/rt/terminal` refuses;
 * - on, an admin or a member is refused on both; so is the owner's own app token;
 * - the owner opens a shell in the profile's folder, types `echo hi`, and reads `hi`;
 *   a page that reloads attaches again and gets the screen back;
 * - a session nobody types into closes by itself; at most three run at once;
 * - every start and end is in the audit log.
 */
import { like } from 'drizzle-orm';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { requireSqlite } from '../../src/lib/db.js';
import { auditEvents } from '../../src/modules/audit/schema.js';
import { terminalManagerFor } from '../../src/modules/terminal/index.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

type Hub = TestHub & { token: string; userId: string };
type Refusal = Error & { data?: { code?: string; reason?: string } };
interface Ack {
  ok: boolean;
  code?: string;
  error?: string;
  details?: { reason?: string };
  session?: { id: string; cwd: string; profile: string; attached: boolean };
  backlog?: string;
}
interface Envelope {
  event: string;
  profile: string;
  payload: { terminal_id: string; data?: string; reason?: string; exit_code?: number | null };
}

const opened: Socket[] = [];

async function listen(hub: TestHub): Promise<string> {
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

function open(
  baseUrl: string,
  token: string,
): Promise<{ socket: Socket; refused: Refusal | null }> {
  const socket = connect(`${baseUrl}/rt/terminal`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    reconnection: false,
    auth: { token },
  });
  opened.push(socket);
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket, refused: null }));
    socket.once('connect_error', (error: Refusal) => resolve({ socket, refused: error }));
  });
}

const command = (socket: Socket, name: string, payload: Record<string, unknown>) =>
  new Promise<Ack>((resolve) => socket.emit(name, payload, resolve));

/** Resolves with everything the session printed once `predicate` holds for it. */
function outputUntil(socket: Socket, id: string, predicate: (text: string) => boolean) {
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(
      () => reject(new Error(`no match in: ${JSON.stringify(text)}`)),
      10_000,
    );
    const listener = (envelope: Envelope) => {
      if (envelope.payload.terminal_id !== id) return;
      text += envelope.payload.data ?? '';
      if (predicate(text)) {
        clearTimeout(timer);
        socket.off('terminal.output', listener);
        resolve(text);
      }
    };
    socket.on('terminal.output', listener);
  });
}

const exited = (socket: Socket, id: string) =>
  new Promise<Envelope>((resolve) => {
    const listener = (envelope: Envelope) => {
      if (envelope.payload.terminal_id !== id) return;
      socket.off('terminal.exited', listener);
      resolve(envelope);
    };
    socket.on('terminal.exited', listener);
  });

async function signIn(hub: TestHub, username: string, password: string): Promise<string> {
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

async function person(hub: Hub, username: string, role: 'admin' | 'member'): Promise<string> {
  const password = `${username}-password-1`;
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/auth/users',
    payload: { username, password, role, profiles: ['default'] },
  });
  expect(res.statusCode).toBe(201);
  return signIn(hub, username, password);
}

function auditRows(hub: TestHub) {
  return requireSqlite(hub.app.hub.database)
    .select()
    .from(auditEvents)
    .where(like(auditEvents.action, 'terminal.%'))
    .all();
}

/** Client sockets first: a hub does not finish closing while one is still connected. */
async function close(hub: TestHub): Promise<void> {
  for (const socket of opened.splice(0)) socket.disconnect();
  await hub.close();
}

describe('web terminal: off unless COREHUB_WEB_TERMINAL=1', () => {
  let hub: Hub;
  let baseUrl: string;
  beforeAll(async () => {
    hub = await signedInHub();
    baseUrl = await listen(hub);
  });
  afterAll(async () => {
    await close(hub);
  });

  it('refuses even the owner, on the route and on the socket', async () => {
    const res = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/terminal' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'forbidden',
      details: { reason: 'terminal_disabled' },
    });

    const { refused } = await open(baseUrl, hub.token);
    expect(refused?.message).toBe('forbidden');
    expect(refused?.data).toEqual({ code: 'forbidden', reason: 'terminal_disabled' });
    expect(terminalManagerFor(hub.app)?.size).toBe(0);
  });
});

describe('web terminal: on', () => {
  let hub: Hub;
  let baseUrl: string;
  beforeAll(async () => {
    hub = await signedInHub({ COREHUB_WEB_TERMINAL: '1' });
    baseUrl = await listen(hub);
  });
  afterAll(async () => {
    await close(hub);
  });

  it('an admin and a member get 403 and never connect', async () => {
    for (const token of [await person(hub, 'amal', 'admin'), await person(hub, 'badr', 'member')]) {
      const res = await authed(hub, token, { method: 'GET', url: '/api/v1/terminal' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'forbidden', details: { required_role: 'owner' } });
      const { refused } = await open(baseUrl, token);
      expect(refused?.data).toEqual({ code: 'forbidden', reason: 'owner_only' });
    }
  });

  it("the owner's app token (a paired phone, an integration) is not a way in", async () => {
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/app-tokens',
      payload: { name: 'script', scopes: ['admin'], expires_at: null },
    });
    expect(created.statusCode).toBe(201);
    const appToken = (created.json() as { token: string }).token;
    const res = await authed(hub, appToken, { method: 'GET', url: '/api/v1/terminal' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ details: { reason: 'web_session_required' } });
    const { refused } = await open(baseUrl, appToken);
    expect(refused?.data).toEqual({ code: 'forbidden', reason: 'web_session_required' });
  });

  it('the owner opens a shell in the profile folder, runs echo hi and reads hi; a reload attaches again', async () => {
    const status = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/terminal' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: true,
      idle_timeout_seconds: 900,
      max_sessions: 3,
      sessions: [],
    });

    const { socket, refused } = await open(baseUrl, hub.token);
    expect(refused).toBeNull();
    const ack = await command(socket, 'open', { profile: 'default', cols: 80, rows: 24 });
    expect(ack.ok).toBe(true);
    const id = ack.session!.id;
    expect(ack.session).toMatchObject({
      profile: 'default',
      cwd: path.join(hub.dataDir, 'workspaces', 'default'),
      attached: true,
    });

    const said = outputUntil(socket, id, (text) => /\rhi\r\n/.test(text));
    expect((await command(socket, 'input', { terminal_id: id, data: 'echo hi\r' })).ok).toBe(true);
    await said;
    const folder = path.join(hub.dataDir, 'workspaces', 'default');
    const where = outputUntil(socket, id, (text) => text.includes(`${folder}\r\n`));
    await command(socket, 'input', { terminal_id: id, data: 'pwd\r' });
    await where;

    // The page reloads: a new socket lists the live session and attaches to it again.
    socket.disconnect();
    const listed = async () =>
      (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/terminal' })).json() as {
          sessions: Array<{ id: string; attached: boolean }>;
        }
      ).sessions;
    // The hub hears the page go a moment after the page goes.
    await expect.poll(listed).toEqual([expect.objectContaining({ id, attached: false })]);
    const again = (await open(baseUrl, hub.token)).socket;
    const attached = await command(again, 'attach', { terminal_id: id });
    expect(attached.ok).toBe(true);
    expect(attached.backlog).toMatch(/\rhi\r\n/);
    const more = outputUntil(again, id, (text) => text.includes('again'));
    await command(again, 'input', { terminal_id: id, data: 'echo again\r' });
    await more;

    const end = exited(again, id);
    expect((await command(again, 'close', { terminal_id: id })).ok).toBe(true);
    expect((await end).payload).toEqual({ terminal_id: id, reason: 'closed', exit_code: null });
    expect((await command(again, 'attach', { terminal_id: id })).code).toBe('not_found');

    const rows = auditRows(hub).filter((row) => row.entityId === id);
    expect(rows.map((row) => row.action).sort()).toEqual(['terminal.closed', 'terminal.opened']);
    const openedRow = rows.find((row) => row.action === 'terminal.opened')!;
    expect(openedRow).toMatchObject({
      actorKind: 'user',
      actorId: hub.userId,
      ownerId: hub.userId,
    });
    expect(openedRow.data).toMatchObject({
      cwd: path.join(hub.dataDir, 'workspaces', 'default'),
      profile: 'default',
    });
    expect(rows.find((row) => row.action === 'terminal.closed')!.data).toMatchObject({
      reason: 'closed',
    });
  });

  it('runs at most three at once: the fourth is refused with conflict', async () => {
    const { socket } = await open(baseUrl, hub.token);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ack = await command(socket, 'open', { profile: 'default', cols: 80, rows: 24 });
      expect(ack.ok).toBe(true);
      ids.push(ack.session!.id);
    }
    const fourth = await command(socket, 'open', { profile: 'default', cols: 80, rows: 24 });
    expect(fourth).toMatchObject({
      ok: false,
      code: 'conflict',
      details: { reason: 'terminal_limit' },
    });
    for (const id of ids) await command(socket, 'close', { terminal_id: id });
    expect(terminalManagerFor(hub.app)?.size).toBe(0);
  });

  it('closes a session nobody typed into once the idle timeout passes, and audits why', async () => {
    const config = hub.app.hub.config.webTerminal;
    const before = config.idleMs;
    config.idleMs = 300;
    try {
      const { socket } = await open(baseUrl, hub.token);
      const ack = await command(socket, 'open', { profile: 'default', cols: 80, rows: 24 });
      const id = ack.session!.id;
      const end = await exited(socket, id);
      expect(end.payload).toEqual({ terminal_id: id, reason: 'idle', exit_code: null });
      const closedRow = auditRows(hub).find(
        (row) => row.entityId === id && row.action === 'terminal.closed',
      )!;
      expect(closedRow).toMatchObject({ actorKind: 'system', ownerId: hub.userId });
      expect(closedRow.data).toMatchObject({ reason: 'idle' });
    } finally {
      config.idleMs = before;
    }
  });
});
