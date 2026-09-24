/**
 * Tasks and Schedules across profiles (ADR 0016 stage 2, DECISIONS §32).
 *
 * The owner: «الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون تصنيف». The board and the
 * Schedules page gather every profile the caller may enter — the server decides which:
 * owners every one, a member the ones they are enrolled in — and nothing the client sends
 * widens that. Acting on an item is a call in the item's own profile, checked like any
 * other: the profile in the header must be one the caller may enter, and the item must be
 * in it. The chats' half of the same rule is `modules/sessions/sessions-profiles.test.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../src/lib/db.js';
import { listWorkspacesFor } from '../../src/modules/auth/index.js';
import { registerHermesCron } from '../../src/modules/schedules/index.js';
import { createHermesJobs } from '../../src/modules/schedules/hermes-jobs.js';
import { FakeHermesApi } from '../../src/modules/schedules/testing/fake-hermes-api.js';
import { createHermesCardApi, registerHermesBoard } from '../../src/modules/tasks/index.js';
import type { HermesKanban, HermesTask } from '../../src/modules/tasks/hermes-kanban.js';
import { signedInHub, type TestHub } from './helpers.js';

type Json = Record<string, unknown>;
type Page = { items: Json[]; next_cursor: string | null; code?: string; details?: Json };

const HERMES_AGENT = '01KHERMESAGENT000000000000';

// ---------------------------------------------------------------- Hermes, scripted
// One board and one scheduler per Hermes home, as Hermes keeps them: a card given to the
// designer profile belongs in the designer workspace; a job made from a profile stays in it.
const cards = new Map<string, HermesTask>();
const kanban: HermesKanban = {
  list: async () => [...cards.values()],
  show: async (id) => cards.get(id) ?? null,
  create: async () => {
    throw new Error('this board takes no new cards');
  },
  archive: async () => {},
  move: async () => {},
};
const hermesJobs = new FakeHermesApi();
const previous = {
  board: null as ReturnType<typeof registerHermesBoard>,
  cron: null as ReturnType<typeof registerHermesCron>,
};

let hub: TestHub & { token: string };
let baseUrl = '';
const tokens = { owner: '', member: '' };
const made = {
  tasks: { default: [] as string[], designer: [] as string[] },
  schedules: { default: [] as string[], designer: [] as string[] },
};
let agent: { id: string; name: string };

function call(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

async function login(username: string, password: string): Promise<string> {
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  return (res.json() as { access_token: string }).access_token;
}

const schedule = (name: string) => ({
  name,
  trigger: { kind: 'interval', expression: null, every_minutes: 60, run_at: null, timezone: 'UTC' },
  target: {
    kind: 'agent_prompt',
    agent_id: null,
    prompt: 'say hello',
    model: null,
    provider: null,
    skills: [],
    workflow_id: null,
    input: null,
  },
  delivery: { kind: 'none', room_id: null, channel: null, address: null },
});

/** Every card on the board, as one list. */
async function board(token: string, query = '', profile = 'default') {
  const res = await call(token, 'GET', `/task-columns${query}`, profile);
  const body = res.json() as { columns?: Array<{ tasks: Json[] }>; code?: string };
  return { status: res.statusCode, body, cards: (body.columns ?? []).flatMap((c) => c.tasks) };
}

async function page(token: string, url: string, profile: string) {
  const res = await call(token, 'GET', url, profile);
  return { status: res.statusCode, body: res.json() as Page };
}

function workspacesOf(app: FastifyInstance) {
  return listWorkspacesFor(requireSqlite(app.hub.database), { id: '', role: 'owner' }).map(
    (row) => ({ workspace: row.id, slug: row.slug, profile: row.isDefault ? 'default' : row.slug }),
  );
}

beforeAll(async () => {
  const api = createHermesCardApi({
    request: async () => {
      throw new Error('not asked in these tests');
    },
    warm: () => {},
  });
  previous.board = registerHermesBoard((app) => ({
    kanban: () => kanban,
    agentId: () => HERMES_AGENT,
    throttleMs: 0,
    api: () => api,
    profiles: () => workspacesOf(app),
  }));
  previous.cron = registerHermesCron(() => ({
    jobs: () =>
      createHermesJobs({
        baseUrl: 'http://hermes.test:8642',
        apiKey: () => 'k',
        fetch: hermesJobs.fetch,
      }),
    agentId: () => HERMES_AGENT,
    timezone: () => 'UTC',
    throttleMs: 0,
  }));

  hub = await signedInHub();
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  tokens.owner = hub.token;

  expect(
    (await call(tokens.owner, 'POST', '/profiles', 'default', { slug: 'designer', name: 'D' }))
      .statusCode,
  ).toBe(201);
  expect(
    (
      await call(tokens.owner, 'POST', '/auth/users', 'default', {
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['designer'],
      })
    ).statusCode,
  ).toBe(201);
  tokens.member = await login('mem', 'mem-password-1');

  // An agent the registry knows, by the name the registry gives it.
  const agents = (await call(tokens.owner, 'GET', '/agents', 'default')).json() as {
    items: Array<{ id: string; name: string }>;
  };
  agent = agents.items[0]!;
  expect(agent?.name).toBeTruthy();

  for (const [profile, titles] of [
    ['default', ['default one', 'default two', 'default three']],
    ['designer', ['designer one', 'designer two']],
  ] as const) {
    for (const title of titles) {
      const res = await call(tokens.owner, 'POST', '/tasks', profile, {
        title,
        status: 'todo',
        assignee_agent_id: agent.id,
      });
      expect(res.statusCode).toBe(201);
      made.tasks[profile].push((res.json() as { id: string }).id);
      const s = await call(tokens.owner, 'POST', '/schedules', profile, schedule(title));
      expect(s.statusCode).toBe(201);
      made.schedules[profile].push((s.json() as { id: string }).id);
    }
  }
});

afterAll(async () => {
  registerHermesBoard(previous.board);
  registerHermesCron(previous.cron);
  await hub.close();
});

afterEach(() => {
  cards.clear();
});

const ids = (items: Json[]) => new Set(items.map((item) => item.id as string));
const own = (kind: 'tasks' | 'schedules', items: Json[]) =>
  items.filter(
    (item) =>
      made[kind].default.includes(item.id as string) ||
      made[kind].designer.includes(item.id as string),
  );

// ---------------------------------------------------------------- the board

describe('the Tasks board gathers every profile the caller may enter', () => {
  it('gives the owner both profiles, each card naming its own', async () => {
    const { status, cards: all } = await board(tokens.owner);
    expect(status).toBe(200);
    const mine = own('tasks', all);
    expect(ids(mine)).toEqual(new Set([...made.tasks.default, ...made.tasks.designer]));
    for (const card of mine) {
      const home = made.tasks.designer.includes(card.id as string) ? 'designer' : 'default';
      expect(card.profile).toBe(home);
    }
  });

  it('gives a member only the profile they are enrolled in', async () => {
    const { status, cards: all } = await board(tokens.member, '', 'designer');
    expect(status).toBe(200);
    expect(ids(own('tasks', all))).toEqual(new Set(made.tasks.designer));
    expect(new Set(all.map((card) => card.profile))).toEqual(new Set(['designer']));
  });

  it('takes `profiles=all` as the board it already is, and refuses it beside `profile`', async () => {
    const plain = await board(tokens.owner);
    const all = await board(tokens.owner, '?profiles=all');
    expect(all.status).toBe(200);
    expect(ids(all.cards)).toEqual(ids(plain.cards));
    const both = await board(tokens.owner, '?profiles=all&profile=designer');
    expect(both.status).toBe(400);
    expect(both.body.code).toBe('validation_failed');
    // A member's `all` is still the member's.
    const member = await board(tokens.member, '?profiles=all', 'designer');
    expect(new Set(member.cards.map((card) => card.profile))).toEqual(new Set(['designer']));
  });

  it('names each card’s agent on the hub, from the registry — in every profile', async () => {
    const { cards: all } = await board(tokens.owner);
    for (const card of own('tasks', all)) {
      expect(card.assignee).toMatchObject({ kind: 'agent', id: agent.id, name: agent.name });
    }
  });

  it('shows a member Hermes’s card for their profile as Hermes has it now, without the default profile', async () => {
    cards.set('t_designer1', {
      id: 't_designer1',
      title: 'For the designer',
      body: null,
      assignee: 'designer',
      status: 'ready',
      priority: 0,
      created_at: 1,
      result: null,
    });
    const { cards: all } = await board(tokens.member, '', 'designer');
    const reflected = all.find((card) => (card.external as Json | null)?.id === 't_designer1');
    expect(reflected).toMatchObject({ profile: 'designer', title: 'For the designer' });
  });
});

describe('tasks.listTasks?profiles=all', () => {
  it('lists every profile for the owner, and only the header’s without it', async () => {
    const all = await page(tokens.owner, '/tasks?profiles=all', 'default');
    expect(all.status).toBe(200);
    expect(ids(own('tasks', all.body.items))).toEqual(
      new Set([...made.tasks.default, ...made.tasks.designer]),
    );
    const one = await page(tokens.owner, '/tasks', 'designer');
    expect(ids(own('tasks', one.body.items))).toEqual(new Set(made.tasks.designer));
    for (const item of one.body.items) expect(item.profile).toBe('designer');
  });

  it('gives a member only their profiles, and never answers a header they may not enter', async () => {
    const all = await page(tokens.member, '/tasks?profiles=all', 'designer');
    expect(ids(own('tasks', all.body.items))).toEqual(new Set(made.tasks.designer));
    expect(new Set(all.body.items.map((item) => item.profile))).toEqual(new Set(['designer']));
    const outside = await page(tokens.member, '/tasks?profiles=all', 'default');
    expect(outside.status).toBe(404);
    expect(outside.body.code).toBe('profile_not_found');
  });

  it('pages across profiles in one order: the pages equal one big page, no repeats, no gaps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/tasks?profiles=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await page(tokens.owner, url, 'default');
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id as string));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    const single = await page(tokens.owner, '/tasks?profiles=all&limit=50', 'default');
    expect(seen).toEqual(single.body.items.map((item) => item.id as string));
    expect(pages).toBe(Math.ceil(single.body.items.length / 2));
  });

  it('refuses a value it does not know rather than guessing', async () => {
    expect((await page(tokens.owner, '/tasks?profiles=designer', 'default')).status).toBe(400);
  });
});

describe('a task is acted on in its own profile', () => {
  it('moves and edits a designer task with the designer in the header, whatever profile the person is in', async () => {
    const id = made.tasks.designer[0]!;
    const moved = await call(tokens.owner, 'POST', `/tasks/${id}/move`, 'designer', {
      status: 'ready',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id, profile: 'designer', status: 'ready' });
    const renamed = await call(tokens.owner, 'PATCH', `/tasks/${id}`, 'designer', {
      title: 'designer one, renamed',
    });
    expect(renamed.statusCode).toBe(200);
  });

  it('never finds a task in a profile it is not in', async () => {
    const id = made.tasks.designer[1]!;
    const wrong = await call(tokens.owner, 'POST', `/tasks/${id}/move`, 'default', {
      status: 'ready',
    });
    expect(wrong.statusCode).toBe(404);
    expect((wrong.json() as Json).code).toBe('not_found');
  });

  it('checks the item’s profile for a member: theirs works, another’s is refused either way', async () => {
    const ok = await call(
      tokens.member,
      'POST',
      `/tasks/${made.tasks.designer[1]!}/move`,
      'designer',
      {
        status: 'ready',
      },
    );
    expect(ok.statusCode).toBe(200);
    const target = made.tasks.default[0]!;
    // Naming the task's real profile: a profile the member may not enter.
    const header = await call(tokens.member, 'POST', `/tasks/${target}/move`, 'default', {
      status: 'ready',
    });
    expect(header.statusCode).toBe(404);
    expect((header.json() as Json).code).toBe('profile_not_found');
    // Naming their own: the task is not there.
    const smuggled = await call(tokens.member, 'POST', `/tasks/${target}/move`, 'designer', {
      status: 'ready',
    });
    expect(smuggled.statusCode).toBe(404);
    expect((smuggled.json() as Json).code).toBe('not_found');
    const after = (await call(tokens.owner, 'GET', `/tasks/${target}`, 'default')).json() as Json;
    expect(after.status).toBe('todo');
  });
});

// ---------------------------------------------------------------- schedules

describe('the Schedules page gathers every profile the caller may enter', () => {
  it('gives the owner both profiles, each schedule naming its own; a member only theirs', async () => {
    const owner = await page(tokens.owner, '/schedules', 'default');
    expect(ids(own('schedules', owner.body.items))).toEqual(
      new Set([...made.schedules.default, ...made.schedules.designer]),
    );
    for (const item of own('schedules', owner.body.items)) {
      const home = made.schedules.designer.includes(item.id as string) ? 'designer' : 'default';
      expect(item.profile).toBe(home);
    }
    const member = await page(tokens.member, '/schedules', 'designer');
    expect(ids(own('schedules', member.body.items))).toEqual(new Set(made.schedules.designer));
    expect(new Set(member.body.items.map((item) => item.profile))).toEqual(new Set(['designer']));
  });

  it('takes `profiles=all` as the list it already is, and refuses it beside `profile`', async () => {
    const all = await page(tokens.owner, '/schedules?profiles=all', 'default');
    expect(all.status).toBe(200);
    expect(own('schedules', all.body.items)).toHaveLength(5);
    const both = await page(tokens.owner, '/schedules?profiles=all&profile=default', 'default');
    expect(both.status).toBe(400);
  });

  it('pages across profiles in one order, as the cursor it declares says', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/schedules?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await page(tokens.owner, url, 'default');
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id as string));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    const single = await page(tokens.owner, '/schedules?limit=50', 'default');
    expect(single.body.next_cursor).toBeNull();
    expect(seen).toEqual(single.body.items.map((item) => item.id as string));
    expect(pages).toBeGreaterThan(1);
  });

  it('acts on a schedule in its own profile, and a member only in theirs', async () => {
    const id = made.schedules.designer[0]!;
    const paused = await call(tokens.owner, 'PATCH', `/schedules/${id}`, 'designer', {
      enabled: false,
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ profile: 'designer', enabled: false });
    expect(
      (await call(tokens.owner, 'PATCH', `/schedules/${id}`, 'default', { enabled: true }))
        .statusCode,
    ).toBe(404);
    const target = made.schedules.default[0]!;
    const header = await call(tokens.member, 'DELETE', `/schedules/${target}`, 'default');
    expect(header.statusCode).toBe(404);
    expect((header.json() as Json).code).toBe('profile_not_found');
    const smuggled = await call(tokens.member, 'DELETE', `/schedules/${target}`, 'designer');
    expect(smuggled.statusCode).toBe(404);
    expect((smuggled.json() as Json).code).toBe('not_found');
    expect((await call(tokens.owner, 'GET', `/schedules/${target}`, 'default')).statusCode).toBe(
      200,
    );
  });

  it('shows a member their profile’s Hermes job as Hermes has it now, without the default profile', async () => {
    const created = await call(tokens.owner, 'POST', '/schedules', 'designer', {
      ...schedule('designer brief'),
      target: { ...schedule('x').target, agent_id: HERMES_AGENT },
    });
    expect(created.statusCode).toBe(201);
    const external = (created.json() as { external: { id: string } }).external.id;
    // Hermes pauses it on its own side; the member's next read must show it.
    hermesJobs.jobs.get(external)!.enabled = false;
    hermesJobs.jobs.get(external)!.state = 'paused';
    const { body } = await page(tokens.member, '/schedules', 'designer');
    const item = body.items.find((one) => (one.external as Json | null)?.id === external);
    expect(item).toMatchObject({ profile: 'designer', enabled: false, state: 'paused' });
  });
});

// ---------------------------------------------------------------- realtime

function socketFor(namespace: string, token: string, profile: string): Promise<Socket> {
  const socket = connect(`${baseUrl}${namespace}`, {
    path: '/rt',
    transports: ['websocket'],
    auth: { token, profile, profiles: 'all' },
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('realtime across profiles on /rt/tasks and /rt/schedules', () => {
  it('reaches every profile the caller may enter, and only those', async () => {
    const ownerTasks = await socketFor('/rt/tasks', tokens.owner, 'default');
    const memberTasks = await socketFor('/rt/tasks', tokens.member, 'designer');
    const ownerSchedules = await socketFor('/rt/schedules', tokens.owner, 'default');
    const memberSchedules = await socketFor('/rt/schedules', tokens.member, 'designer');
    const heard = {
      ownerTasks: [] as string[],
      memberTasks: [] as string[],
      ownerSchedules: [] as string[],
      memberSchedules: [] as string[],
    };
    ownerTasks.on('task.created', (e: { profile: string }) => heard.ownerTasks.push(e.profile));
    memberTasks.on('task.created', (e: { profile: string }) => heard.memberTasks.push(e.profile));
    ownerSchedules.on('schedule.created', (e: { profile: string }) =>
      heard.ownerSchedules.push(e.profile),
    );
    memberSchedules.on('schedule.created', (e: { profile: string }) =>
      heard.memberSchedules.push(e.profile),
    );
    try {
      for (const profile of ['designer', 'default']) {
        await call(tokens.owner, 'POST', '/tasks', profile, { title: `rt ${profile}` });
        await call(tokens.owner, 'POST', '/schedules', profile, schedule(`rt ${profile}`));
      }
      await until(
        () =>
          heard.ownerTasks.length === 2 &&
          heard.ownerSchedules.length === 2 &&
          heard.memberTasks.length === 1 &&
          heard.memberSchedules.length === 1,
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(heard.ownerTasks.sort()).toEqual(['default', 'designer']);
      expect(heard.ownerSchedules.sort()).toEqual(['default', 'designer']);
      expect(heard.memberTasks).toEqual(['designer']);
      expect(heard.memberSchedules).toEqual(['designer']);
    } finally {
      for (const socket of [ownerTasks, memberTasks, ownerSchedules, memberSchedules])
        socket.close();
    }
  });
});
