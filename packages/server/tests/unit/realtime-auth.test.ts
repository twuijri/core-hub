/**
 * Who may open a realtime socket, and what it may hear (owner, 2026-09-24, on the hole
 * found while building cross-profile lists: «ايه صلحها دامها مشكله خطيره»).
 *
 * Before this, a socket with no token was still put in the room of whatever workspace its
 * handshake named, and `subscribe` joined any session id it was given — so chat events
 * could reach someone who had no right to them. Now:
 * - every namespace refuses a handshake without a valid token, with the error code;
 * - a workspace room is joined only when the caller may enter that workspace;
 * - following a session needs the session to exist in such a workspace;
 * - whatever takes access away (disable, logout, a membership moved) drops the socket,
 *   and the same token cannot bring it back.
 */
import { decodeJwt } from 'jose';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { loadOrCreateSigningKey, signAccessToken } from '../../src/modules/auth/tokens.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
/** A well-formed id no session has. */
const NO_SUCH_SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0ZZ';
const NAMESPACES = Object.values(REALTIME_NAMESPACES);

type Hub = TestHub & { token: string; userId: string };
type Refusal = Error & { data?: { code?: string } };
interface Ack {
  ok: boolean;
  code?: string;
}

let hub: Hub;
let baseUrl: string;
const sessionIn: Record<'alpha' | 'beta', string> = { alpha: '', beta: '' };
const opened: Socket[] = [];

/** Opens a socket and settles on the handshake: connected, or refused with the reason. */
function open(
  namespace: string,
  auth: Record<string, string>,
): Promise<{ socket: Socket; refused: Refusal | null }> {
  const socket = connect(`${baseUrl}${namespace}`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    reconnection: false,
    auth,
  });
  opened.push(socket);
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket, refused: null }));
    socket.once('connect_error', (error: Refusal) => resolve({ socket, refused: error }));
  });
}

async function admitted(namespace: string, auth: Record<string, string>): Promise<Socket> {
  const { socket, refused } = await open(namespace, auth);
  if (refused) throw new Error(`expected to connect, was refused: ${refused.message}`);
  return socket;
}

const subscribe = (socket: Socket, sessionId: string) =>
  new Promise<Ack>((resolve) => socket.emit('subscribe', { session_id: sessionId }, resolve));

/** Every event the socket hears, by name. */
function heard(socket: Socket): string[] {
  const events: string[] = [];
  socket.onAny((event: string) => events.push(event));
  return events;
}

const waitFor = (socket: Socket, event: string) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 5_000);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });

const dropped = (socket: Socket) =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the socket was not dropped')), 5_000);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });

async function login(username: string, password: string): Promise<string> {
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

/** A member enrolled in exactly `profiles`; returns their id and a signed-in token. */
async function member(username: string, profiles: string[]) {
  const password = `${username}-password-1`;
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/auth/users',
    payload: { username, password, role: 'member', profiles },
  });
  expect(res.statusCode).toBe(201);
  return { id: (res.json() as { id: string }).id, token: await login(username, password) };
}

async function newSession(profile: string): Promise<string> {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    profile,
    payload: { agent_id: AGENT_ID, title: `in ${profile}` },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function run(profile: string, sessionId: string): Promise<void> {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/runs`,
    profile,
    payload: { content: [{ type: 'text', text: 'سر' }] },
  });
  expect(res.statusCode).toBe(202);
}

beforeAll(async () => {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      script: [{ type: 'message_delta', text: 'كلمة السر هي…' }, { type: 'completed' }],
    }),
    scopes: principalScopeResolver,
  });
  hub = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  for (const slug of ['alpha', 'beta'] as const) {
    const res = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug, name: slug },
    });
    expect(res.statusCode).toBe(201);
    sessionIn[slug] = await newSession(slug);
  }
});

afterAll(async () => {
  for (const socket of opened) socket.disconnect();
  await hub.close();
});

describe('realtime: the handshake', () => {
  it('refuses a socket with no token on every namespace, saying why', async () => {
    for (const namespace of NAMESPACES) {
      const { refused } = await open(namespace, { profile: 'default' });
      expect(refused?.message, namespace).toBe('unauthorized');
      expect(refused?.data?.code, namespace).toBe('unauthorized');
    }
  });

  it('refuses a made-up token, an unknown app token and an expired session token', async () => {
    const { sid, sub } = decodeJwt(hub.token) as { sid: string; sub: string };
    const expired = await signAccessToken(
      loadOrCreateSigningKey(hub.dataDir),
      { userId: sub, role: 'owner', sessionId: sid },
      Date.now() - 60 * 60_000,
      60,
    );
    // Once: bad app tokens from one address are rate limited, as over HTTP.
    expect(
      (await open(REALTIME_NAMESPACES.devices, { token: 'hub_at_made_up' })).refused?.message,
    ).toBe('unauthorized');
    for (const namespace of NAMESPACES) {
      expect((await open(namespace, { token: 'not-a-jwt' })).refused?.message).toBe('unauthorized');
      expect((await open(namespace, { token: expired })).refused?.message).toBe('token_expired');
    }
  });

  it('keeps the main namespace, which carries nothing, closed even to a signed-in person', async () => {
    const { refused } = await open('/', { token: hub.token, profile: 'default' });
    expect(refused?.message).toBe('unauthorized');
  });

  it('admits a signed-in person on every namespace', async () => {
    for (const namespace of NAMESPACES) {
      const { refused } = await open(namespace, { token: hub.token, profile: 'default' });
      // The web terminal is the one exception: the owner's, and off on this hub (§70).
      if (namespace === REALTIME_NAMESPACES.terminal) expect(refused?.message).toBe('forbidden');
      else expect(refused, namespace).toBeNull();
    }
  });

  it('refuses a member the workspace they are not enrolled in, by slug or by id', async () => {
    const mem = await member('handshake', ['alpha']);
    const profiles = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' })
    ).json() as { items: Array<{ id: string; slug: string }> };
    const betaId = profiles.items.find((p) => p.slug === 'beta')!.id;
    for (const namespace of NAMESPACES) {
      for (const profile of ['beta', betaId]) {
        const { refused } = await open(namespace, { token: mem.token, profile });
        expect(refused?.message, `${namespace} ${profile}`).toBe('profile_not_found');
      }
      const { refused } = await open(namespace, { token: mem.token, profile: 'alpha' });
      // A member never reaches the owner's web terminal, whatever the profile (§70).
      if (namespace === REALTIME_NAMESPACES.terminal) expect(refused?.message).toBe('forbidden');
      else expect(refused).toBeNull();
    }
  });
});

describe('realtime: following a session', () => {
  it('refuses a session in another workspace and an id that does not exist', async () => {
    const mem = await member('follower', ['alpha']);
    const socket = await admitted(REALTIME_NAMESPACES.sessions, {
      token: mem.token,
      profile: 'alpha',
    });
    expect(await subscribe(socket, sessionIn.beta)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await subscribe(socket, NO_SUCH_SESSION)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('delivers nothing from another workspace: not its chat, not its session list', async () => {
    const mem = await member('outsider', ['alpha']);
    const outsider = await admitted(REALTIME_NAMESPACES.sessions, {
      token: mem.token,
      profile: 'alpha',
    });
    const outsiderHeard = heard(outsider);
    await subscribe(outsider, sessionIn.beta);

    const owner = await admitted(REALTIME_NAMESPACES.sessions, {
      token: hub.token,
      profile: 'beta',
    });
    expect(await subscribe(owner, sessionIn.beta)).toMatchObject({ ok: true });
    const completed = waitFor(owner, 'run.completed');
    await run('beta', sessionIn.beta);
    await completed;
    const created = waitFor(owner, 'session.created');
    await newSession('beta');
    await created;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(outsiderHeard).toEqual([]);
  });

  it('streams a session of a workspace the member may enter', async () => {
    const mem = await member('insider', ['alpha']);
    const socket = await admitted(REALTIME_NAMESPACES.sessions, {
      token: mem.token,
      profile: 'alpha',
    });
    const events = heard(socket);
    expect(await subscribe(socket, sessionIn.alpha)).toMatchObject({ ok: true });
    const completed = waitFor(socket, 'run.completed');
    await run('alpha', sessionIn.alpha);
    await completed;
    expect(events).toEqual(expect.arrayContaining(['message.created', 'message.delta']));
  });
});

describe('realtime: following across profiles (ADR 0016)', () => {
  it('follows a session in another profile the caller may enter', async () => {
    const socket = await admitted(REALTIME_NAMESPACES.sessions, {
      token: hub.token,
      profile: 'alpha',
      profiles: 'all',
    });
    expect(await subscribe(socket, sessionIn.beta)).toMatchObject({ ok: true });
  });

  it('never reaches past what the member may enter, even when asking for every profile', async () => {
    const mem = await member('everywhere', ['alpha']);
    const socket = await admitted(REALTIME_NAMESPACES.sessions, {
      token: mem.token,
      profile: 'alpha',
      profiles: 'all',
    });
    expect(await subscribe(socket, sessionIn.beta)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await subscribe(socket, sessionIn.alpha)).toMatchObject({ ok: true });
  });
});

describe('realtime: access taken away', () => {
  it('drops a disabled member at once, and refuses them on the way back', async () => {
    const mem = await member('disabled', ['alpha']);
    const socket = await admitted(REALTIME_NAMESPACES.jobs, { token: mem.token, profile: 'alpha' });
    const gone = dropped(socket);
    const patched = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/auth/users/${mem.id}`,
      payload: { status: 'disabled' },
    });
    expect(patched.statusCode).toBe(200);
    expect(await gone).toBe('io server disconnect');
    const again = await open(REALTIME_NAMESPACES.jobs, { token: mem.token, profile: 'alpha' });
    expect(again.refused?.message).toBe('unauthorized');
  });

  it('drops the sockets of a session that signed out, and refuses its token after', async () => {
    const mem = await member('leaver', ['alpha']);
    const socket = await admitted(REALTIME_NAMESPACES.sessions, {
      token: mem.token,
      profile: 'alpha',
    });
    const gone = dropped(socket);
    const out = await authed(hub, mem.token, { method: 'POST', url: '/api/v1/auth/logout' });
    expect(out.statusCode).toBe(204);
    expect(await gone).toBe('io server disconnect');
    const again = await open(REALTIME_NAMESPACES.sessions, { token: mem.token, profile: 'alpha' });
    expect(again.refused?.message).toBe('unauthorized');
  });

  it('drops a socket whose workspace the member was moved out of', async () => {
    const mem = await member('moved', ['alpha']);
    const socket = await admitted(REALTIME_NAMESPACES.sessions, {
      token: mem.token,
      profile: 'alpha',
    });
    const gone = dropped(socket);
    const patched = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/auth/users/${mem.id}`,
      payload: { profiles: ['beta'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(await gone).toBe('io server disconnect');
    const again = await open(REALTIME_NAMESPACES.sessions, { token: mem.token, profile: 'alpha' });
    expect(again.refused?.message).toBe('profile_not_found');
    expect(
      (await open(REALTIME_NAMESPACES.sessions, { token: mem.token, profile: 'beta' })).refused,
    ).toBeNull();
  });
});
