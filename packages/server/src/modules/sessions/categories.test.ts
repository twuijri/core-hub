/**
 * Session categories (contract decision §53): create, rename, reorder, delete, and moving a
 * session in and out of one — through the routes, the way a client reaches them.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { principalScopeResolver } from '../auth/index.js';
import { TEST_ADMIN_PASSWORD, testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { MAX_CATEGORIES, nameKeyOf, reorder } from './categories.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const UNKNOWN = '01J8QK3ZR2W7M5N4P6T8V9X0CT';

const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function expectMatchesSchema(name: string, data: unknown): void {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document?.components ?? {},
  });
  expect(
    validate(data)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
    `response does not match ${name}`,
  ).toEqual([]);
}

interface Category {
  id: string;
  profile: string;
  name: string;
  color: string | null;
  position: number;
  session_count: number;
}

function sessionsModule() {
  return createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
  });
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; profile?: string; language?: string } = {},
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'x-hub-profile': options.profile ?? 'default',
      ...(options.language ? { 'accept-language': options.language } : {}),
    },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  return { status: res.statusCode, json: () => res.json() as never };
}

describe('categories: the order helpers', () => {
  it('moves an id to a place, clamping past the end to the end', () => {
    expect(reorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(reorder(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(reorder(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('compares names trimmed and without case', () => {
    expect(nameKeyOf('  Launch ')).toBe(nameKeyOf('launch'));
    expect(nameKeyOf(' الإطلاق')).toBe('الإطلاق');
  });
});

describe('categories: through the routes', () => {
  let hub: TestHub;
  beforeEach(async () => {
    const sessions = sessionsModule();
    hub = await testHub(
      {},
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
  });
  afterEach(async () => {
    await hub.close();
  });

  const create = (name: string, extra: Record<string, unknown> = {}, profile?: string) =>
    call(hub.app, 'POST', '/session-categories', {
      body: { name, ...extra },
      ...(profile ? { profile } : {}),
    });
  const list = async (profile?: string) =>
    (
      (await call(hub.app, 'GET', '/session-categories', profile ? { profile } : {})).json() as {
        items: Category[];
      }
    ).items;
  const newSession = async (profile?: string) =>
    (
      (
        await call(hub.app, 'POST', '/sessions', {
          body: { agent_id: AGENT_ID },
          ...(profile ? { profile } : {}),
        })
      ).json() as { id: string }
    ).id;

  it('creates categories last, in order, and lists them as the contract says', async () => {
    const first = await create('الإطلاق', { color: '#4a90d9' });
    expect(first.status).toBe(201);
    expectMatchesSchema('SessionCategory', first.json());
    expect(first.json()).toMatchObject({
      profile: 'default',
      name: 'الإطلاق',
      color: '#4a90d9',
      position: 0,
      session_count: 0,
    });
    expect((await create('  Research  ')).json()).toMatchObject({ name: 'Research', position: 1 });
    // At a place: the others make room.
    expect((await create('Inbox', { position: 0 })).json()).toMatchObject({ position: 0 });

    const items = await list();
    expect(items.map((c) => [c.name, c.position])).toEqual([
      ['Inbox', 0],
      ['الإطلاق', 1],
      ['Research', 2],
    ]);
    for (const item of items) expectMatchesSchema('SessionCategory', item);
    // Another profile has its own, none of these.
    expect(await list('other')).toEqual([]);
  });

  it('refuses a blank name and a name the profile already has, on create and rename', async () => {
    expect((await create('   ')).status).toBe(400);
    await create('Launch');
    const twin = await create(' launch ', {}, undefined);
    expect(twin.status).toBe(409);
    expect(twin.json()).toMatchObject({ code: 'conflict', details: { reason: 'name_taken' } });
    const arabic = await call(hub.app, 'POST', '/session-categories', {
      body: { name: 'LAUNCH' },
      language: 'ar',
    });
    expect(arabic.json()).toMatchObject({ error: 'في هذا البروفايل تصنيف بهذا الاسم.' });
    // The same name in another profile is another category.
    expect((await create('Launch', {}, 'other')).status).toBe(201);

    const other = (await create('Other')).json() as Category;
    const rename = await call(hub.app, 'PATCH', `/session-categories/${other.id}`, {
      body: { name: 'LAUNCH' },
    });
    expect(rename.status).toBe(409);
    // Renaming to its own name in another case is not a clash with itself.
    const own = await call(hub.app, 'PATCH', `/session-categories/${other.id}`, {
      body: { name: 'OTHER', color: null },
    });
    expect(own.status).toBe(200);
    expect(own.json()).toMatchObject({ name: 'OTHER', color: null });
  });

  it('reorders with one patch and keeps positions 0…n-1', async () => {
    const [a, b, c] = [
      (await create('A')).json() as Category,
      (await create('B')).json() as Category,
      (await create('C')).json() as Category,
    ];
    const moved = await call(hub.app, 'PATCH', `/session-categories/${c.id}`, {
      body: { position: 0 },
    });
    expect(moved.json()).toMatchObject({ position: 0 });
    expect((await list()).map((x) => x.name)).toEqual(['C', 'A', 'B']);

    await call(hub.app, 'PATCH', `/session-categories/${c.id}`, { body: { position: 99 } });
    expect((await list()).map((x) => [x.name, x.position])).toEqual([
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ]);

    // Deleting closes the gap.
    expect((await call(hub.app, 'DELETE', `/session-categories/${a.id}`)).status).toBe(204);
    expect((await list()).map((x) => [x.id, x.position])).toEqual([
      [b.id, 0],
      [c.id, 1],
    ]);
  });

  it('moves a session in and out, counts it, and filters the list by it', async () => {
    const launch = (await create('Launch')).json() as Category;
    const one = await newSession();
    const two = await newSession();

    const moved = await call(hub.app, 'PATCH', `/sessions/${one}`, {
      body: { category_id: launch.id },
    });
    expect(moved.status).toBe(200);
    expect(moved.json()).toMatchObject({ category_id: launch.id });
    expect((await list())[0]?.session_count).toBe(1);

    const inIt = await call(hub.app, 'GET', `/sessions?category_id=${launch.id}`);
    expect((inIt.json() as { items: { id: string }[] }).items.map((s) => s.id)).toEqual([one]);
    const loose = await call(hub.app, 'GET', '/sessions?category_id=none');
    expect((loose.json() as { items: { id: string }[] }).items.map((s) => s.id)).toEqual([two]);

    // Many at once, through the bulk patch.
    const bulk = await call(hub.app, 'PATCH', '/sessions', {
      body: { session_ids: [two], patch: { category_id: launch.id } },
    });
    expect(bulk.json()).toMatchObject({ results: [{ id: two, ok: true }] });
    expect((await list())[0]?.session_count).toBe(2);

    // An archived conversation stays filed but is not counted.
    await call(hub.app, 'PATCH', `/sessions/${two}`, { body: { archived: true } });
    expect((await list())[0]?.session_count).toBe(1);

    // Out again.
    const out = await call(hub.app, 'PATCH', `/sessions/${one}`, { body: { category_id: null } });
    expect(out.json()).toMatchObject({ category_id: null });
    expect((await list())[0]?.session_count).toBe(0);
  });

  it('refuses a category the profile does not have, instead of dropping it', async () => {
    const id = await newSession();
    const unknown = await call(hub.app, 'PATCH', `/sessions/${id}`, {
      body: { category_id: UNKNOWN },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json()).toMatchObject({
      code: 'not_found',
      details: { resource: 'session_category' },
    });

    // Another profile's category is not this profile's.
    const elsewhere = (await create('Elsewhere', {}, 'other')).json() as Category;
    const crossed = await call(hub.app, 'PATCH', `/sessions/${id}`, {
      body: { category_id: elsewhere.id },
    });
    expect(crossed.status).toBe(404);
    const created = await call(hub.app, 'POST', '/sessions', {
      body: { agent_id: AGENT_ID, category_id: elsewhere.id },
    });
    expect(created.status).toBe(404);
    // ...and it cannot be renamed or deleted from here either.
    expect(
      (
        await call(hub.app, 'PATCH', `/session-categories/${elsewhere.id}`, {
          body: { name: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await call(hub.app, 'DELETE', `/session-categories/${elsewhere.id}`)).status).toBe(404);
  });

  it('creates a session straight into a category', async () => {
    const launch = (await create('Launch')).json() as Category;
    const created = await call(hub.app, 'POST', '/sessions', {
      body: { agent_id: AGENT_ID, category_id: launch.id },
    });
    expect(created.status).toBe(201);
    expect(created.json()).toMatchObject({ category_id: launch.id });
  });

  it('keeps the conversations when their category is deleted', async () => {
    const launch = (await create('Launch')).json() as Category;
    const one = await newSession();
    const two = await newSession();
    for (const id of [one, two]) {
      await call(hub.app, 'PATCH', `/sessions/${id}`, { body: { category_id: launch.id } });
    }
    await call(hub.app, 'PATCH', `/sessions/${two}`, { body: { archived: true } });

    expect((await call(hub.app, 'DELETE', `/session-categories/${launch.id}`)).status).toBe(204);
    for (const id of [one, two]) {
      const session = await call(hub.app, 'GET', `/sessions/${id}`);
      expect(session.status).toBe(200);
      expect(session.json()).toMatchObject({ category_id: null });
    }
    expect(await list()).toEqual([]);
    expect((await call(hub.app, 'DELETE', `/session-categories/${launch.id}`)).status).toBe(404);
  });

  it('holds at most 100 per profile', async () => {
    for (let i = 0; i < MAX_CATEGORIES; i += 1) {
      expect((await create(`c${i}`)).status).toBe(201);
    }
    const over = await create('one too many');
    expect(over.status).toBe(409);
    expect(over.json()).toMatchObject({ details: { reason: 'category_limit' } });
  });
});

describe('categories: across profiles (ADR 0016)', () => {
  let hub: TestHub;
  const token: Record<'owner' | 'member', string> = { owner: '', member: '' };
  const inject = (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    profile: string,
    body?: object,
  ) =>
    hub.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'x-hub-profile': profile },
      ...(body ? { payload: body } : {}),
    });
  const login = async (username: string, password: string) =>
    (
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password },
        })
      ).json() as { access_token: string }
    ).access_token;

  beforeAll(async () => {
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    token.owner = await login('admin', TEST_ADMIN_PASSWORD);
    expect(
      (
        await inject(token.owner, 'POST', '/profiles', 'default', {
          slug: 'designer',
          name: 'Designer',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await inject(token.owner, 'POST', '/auth/users', 'default', {
          username: 'mem',
          password: 'mem-password-1',
          role: 'member',
          profiles: ['designer'],
        })
      ).statusCode,
    ).toBe(201);
    token.member = await login('mem', 'mem-password-1');
    for (const [profile, name] of [
      ['default', 'Home'],
      ['designer', 'Sketches'],
      ['designer', 'Reviews'],
    ] as const) {
      expect(
        (await inject(token.owner, 'POST', '/session-categories', profile, { name })).statusCode,
      ).toBe(201);
    }
  });
  afterAll(async () => {
    await hub.close();
  });

  const listAll = async (who: string, profile: string) => {
    const res = await inject(who, 'GET', '/session-categories?profiles=all', profile);
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: Category[] }).items.map((c) => [c.profile, c.name]);
  };

  it('lists every profile the caller may enter, each in its own order', async () => {
    const owner = await listAll(token.owner, 'default');
    expect(owner).toEqual(
      expect.arrayContaining([
        ['default', 'Home'],
        ['designer', 'Sketches'],
        ['designer', 'Reviews'],
      ]),
    );
    const designer = owner.filter(([profile]) => profile === 'designer').map(([, name]) => name);
    expect(designer).toEqual(['Sketches', 'Reviews']);
  });

  it('never widens a member past the profiles they were given', async () => {
    expect(await listAll(token.member, 'designer')).toEqual([
      ['designer', 'Sketches'],
      ['designer', 'Reviews'],
    ]);
    // The header must still be a profile they may enter.
    const refused = await inject(
      token.member,
      'GET',
      '/session-categories?profiles=all',
      'default',
    );
    expect(refused.statusCode).not.toBe(200);
  });
});
