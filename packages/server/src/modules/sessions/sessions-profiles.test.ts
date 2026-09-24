/**
 * Lists across profiles (ADR 0016): `sessions.list?profiles=all` and the realtime
 * handshake's `profiles: 'all'`.
 *
 * The rules under test are all about **who decides**: the server lists every profile the
 * caller may enter — owners and admins every one, a member only the ones they are enrolled
 * in — and nothing the client sends can widen that. Paging stays one order across every
 * profile, and a list without `profiles` is exactly what it was before.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../index.js';
import { principalScopeResolver } from '../auth/index.js';
import { TEST_ADMIN_PASSWORD, testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

type Item = { id: string; profile: string; title: string | null; match: unknown };
type PageBody = { items: Item[]; next_cursor: string | null };

let hub: TestHub;
let baseUrl = '';
const tokens: Record<'owner' | 'admin' | 'member' | 'free', string> = {
  owner: '',
  admin: '',
  member: '',
  free: '',
};
/** Session ids by profile, as the owner created them. */
const made: Record<'default' | 'designer', string[]> = { default: [], designer: [] };

async function inject(
  token: string,
  method: 'GET' | 'POST',
  url: string,
  profile: string,
  payload?: unknown,
) {
  return hub.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, 'x-hub-profile': profile },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const list = async (token: string, profile: string, query: string) => {
  const res = await inject(token, 'GET', `/sessions?${query}`, profile);
  return { status: res.statusCode, body: res.json() as PageBody & { code?: string } };
};

async function login(username: string, password: string): Promise<string> {
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  return (res.json() as { access_token: string }).access_token;
}

beforeAll(async () => {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
    // The real rule: who may enter which workspace is `auth`'s.
    scopes: principalScopeResolver,
  });
  hub = await testHub(
    { HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  tokens.owner = await login('admin', TEST_ADMIN_PASSWORD);
  const designer = await inject(tokens.owner, 'POST', '/profiles', 'default', {
    slug: 'designer',
    name: 'Designer',
  });
  expect(designer.statusCode).toBe(201);
  const person = (body: Record<string, unknown>) =>
    inject(tokens.owner, 'POST', '/auth/users', 'default', body);
  expect(
    (await person({ username: 'adm', password: 'adm-password-1', role: 'admin' })).statusCode,
  ).toBe(201);
  expect(
    (
      await person({
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['designer'],
      })
    ).statusCode,
  ).toBe(201);
  // A member with no enrolment may enter every workspace (the contract: empty = every profile).
  expect(
    (await person({ username: 'free', password: 'free-password-1', role: 'member' })).statusCode,
  ).toBe(201);
  tokens.admin = await login('adm', 'adm-password-1');
  tokens.member = await login('mem', 'mem-password-1');
  tokens.free = await login('free', 'free-password-1');

  for (const [profile, titles] of [
    ['default', ['خطة الإطلاق', 'default two', 'default three']],
    ['designer', ['خطة الشعار', 'designer two']],
  ] as const) {
    for (const title of titles) {
      const res = await inject(tokens.owner, 'POST', '/sessions', profile, {
        agent_id: AGENT_ID,
        title,
      });
      expect(res.statusCode).toBe(201);
      made[profile].push((res.json() as { id: string }).id);
    }
  }
});

afterAll(async () => {
  await hub.close();
});

describe('sessions.list?profiles=all — who sees what', () => {
  it('gives the owner every profile, each item naming its own', async () => {
    const { status, body } = await list(tokens.owner, 'default', 'profiles=all');
    expect(status).toBe(200);
    expect(new Set(body.items.map((s) => s.id))).toEqual(
      new Set([...made.default, ...made.designer]),
    );
    for (const item of body.items) {
      const home = made.designer.includes(item.id) ? 'designer' : 'default';
      expect(item.profile).toBe(home);
    }
  });

  it('gives an admin every profile too', async () => {
    const { body } = await list(tokens.admin, 'designer', 'profiles=all');
    expect(body.items).toHaveLength(made.default.length + made.designer.length);
  });

  it('gives a member only the profiles they are enrolled in, whatever they ask', async () => {
    const { status, body } = await list(tokens.member, 'designer', 'profiles=all');
    expect(status).toBe(200);
    expect(new Set(body.items.map((s) => s.id))).toEqual(new Set(made.designer));
    expect(new Set(body.items.map((s) => s.profile))).toEqual(new Set(['designer']));
    // The header must still be one they may enter: "all" does not open a door the header
    // could not.
    const outside = await list(tokens.member, 'default', 'profiles=all');
    expect(outside.status).toBe(404);
    expect(outside.body.code).toBe('profile_not_found');
  });

  it('gives a member with no enrolment every profile, as the header rule does', async () => {
    const { body } = await list(tokens.free, 'default', 'profiles=all');
    expect(body.items).toHaveLength(made.default.length + made.designer.length);
  });

  it('keeps the list without `profiles` exactly as it was: the header profile alone', async () => {
    const { body } = await list(tokens.owner, 'default', '');
    expect(new Set(body.items.map((s) => s.id))).toEqual(new Set(made.default));
    const designer = await list(tokens.owner, 'designer', '');
    expect(new Set(designer.body.items.map((s) => s.id))).toEqual(new Set(made.designer));
  });

  it('refuses a value it does not know rather than guessing', async () => {
    const { status } = await list(tokens.owner, 'default', 'profiles=designer');
    expect(status).toBe(400);
  });
});

describe('sessions.list?profiles=all — paging', () => {
  it('pages across profiles in one order: the pages equal one big page, no repeats, no gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `profiles=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await list(tokens.owner, 'default', query);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((s) => s.id));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    const single = await list(tokens.owner, 'default', 'profiles=all&limit=50');
    expect(seen).toEqual(single.body.items.map((s) => s.id));
  });
});

describe('search across profiles', () => {
  it('finds hits in every profile the caller may enter, each carrying its profile and match', async () => {
    const q = encodeURIComponent('خطة');
    const { body } = await list(tokens.owner, 'default', `profiles=all&archived=all&q=${q}`);
    expect(body.items.map((s) => s.profile).sort()).toEqual(['default', 'designer']);
    for (const item of body.items) expect(item.match).not.toBeNull();
  });

  it('never hands a member a hit from a profile they may not enter', async () => {
    const q = encodeURIComponent('خطة');
    const { body } = await list(tokens.member, 'designer', `profiles=all&archived=all&q=${q}`);
    expect(body.items.map((s) => s.title)).toEqual(['خطة الشعار']);
  });
});

// ------------------------------------------------------------------ realtime

function socketFor(token: string, profile: string, all: boolean): Promise<Socket> {
  const socket = connect(`${baseUrl}/rt/sessions`, {
    path: '/rt',
    transports: ['websocket'],
    auth: { token, profile, ...(all ? { profiles: 'all' } : {}) },
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function created(socket: Socket): string[] {
  const ids: string[] = [];
  socket.on('session.created', (envelope: { payload: { session: { id: string } } }) =>
    ids.push(envelope.payload.session.id),
  );
  return ids;
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('realtime across profiles', () => {
  it('reaches a client that asked for every profile, and only the profiles it may enter', async () => {
    const ownerAll = await socketFor(tokens.owner, 'default', true);
    const ownerOne = await socketFor(tokens.owner, 'default', false);
    const memberAll = await socketFor(tokens.member, 'designer', true);
    const heard = {
      ownerAll: created(ownerAll),
      ownerOne: created(ownerOne),
      memberAll: created(memberAll),
    };
    try {
      const inDesigner = (
        await inject(tokens.owner, 'POST', '/sessions', 'designer', { agent_id: AGENT_ID })
      ).json() as { id: string };
      const inDefault = (
        await inject(tokens.owner, 'POST', '/sessions', 'default', { agent_id: AGENT_ID })
      ).json() as { id: string };

      await until(
        () =>
          heard.ownerAll.includes(inDesigner.id) &&
          heard.ownerAll.includes(inDefault.id) &&
          heard.memberAll.includes(inDesigner.id) &&
          heard.ownerOne.includes(inDefault.id),
      );
      // Settle: anything that was going to arrive has.
      await new Promise((r) => setTimeout(r, 100));

      expect(heard.ownerAll).toEqual(expect.arrayContaining([inDesigner.id, inDefault.id]));
      // Without `profiles: 'all'` a socket hears its own profile only, as before.
      expect(heard.ownerOne).toContain(inDefault.id);
      expect(heard.ownerOne).not.toContain(inDesigner.id);
      // A member hears the profiles they may enter, and nothing else.
      expect(heard.memberAll).toContain(inDesigner.id);
      expect(heard.memberAll).not.toContain(inDefault.id);
    } finally {
      ownerAll.close();
      ownerOne.close();
      memberAll.close();
    }
  });
});
