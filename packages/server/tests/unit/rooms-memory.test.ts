/**
 * Rooms, part 3 (DECISIONS §69): the rolling summary — by hand, on request, every N messages,
 * written by the lead agent or by the hub when the agent cannot — and a task's progress
 * reported into its project's room (ROADMAP Phase 1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { conductorFor } from '../../src/modules/rooms/index.js';
import { digest } from '../../src/modules/rooms/memory.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { taskRunsFor } from '../../src/modules/tasks/index.js';
import { authed, drainJobs, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';

let hub: Hub;
/** What the lead agent answers when asked for the summary; `null` = it cannot. */
let summaryAnswer: string | null = null;
const asked: string[] = [];
const prompts: string[] = [];

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const res = await authed(hub, hub.token, {
    method,
    url: `/api/v1${url}`,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
}

async function settle() {
  await conductorFor(hub.app).idle();
  await drainJobs(hub.app);
  await taskRunsFor(hub.app).settled();
  await conductorFor(hub.app).idle();
}

async function room(extra: Json = {}) {
  const res = await call('POST', '/rooms', {
    name: 'غرفة الذاكرة',
    seats: [{ agent_id: AGENT, name: 'القائد' }],
    ...extra,
  });
  expect(res.status).toBe(201);
  return (res.body.room as Json & { id: string }).id;
}

const post = (roomId: string, text: string) =>
  call('POST', `/rooms/${roomId}/messages`, { content: [{ type: 'text', text }] });

beforeAll(async () => {
  const runner = new FakeAgentRunner({
    scriptFor(_request, prompt) {
      prompts.push(prompt);
      if (prompt.startsWith('#')) {
        return [
          { type: 'message_delta', text: 'أنجزت الصفحة. بقي: المراجعة.' },
          { type: 'completed' },
        ];
      }
      return [{ type: 'message_delta', text: 'حاضر.' }, { type: 'completed' }];
    },
    answer: (request) => {
      asked.push(request.prompt);
      return summaryAnswer;
    },
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  hub = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
});

afterAll(async () => {
  await hub?.close();
});

beforeEach(() => {
  summaryAnswer = null;
  asked.length = 0;
  prompts.length = 0;
});

describe('the room summary', () => {
  it('the manager writes it by hand; every turn after carries it', async () => {
    const id = await room({ summary_policy: { every_turns: 0, model: null, provider: null } });
    const put = await call('PUT', `/rooms/${id}/memory`, {
      summary: 'اتفقنا على الإطلاق في أكتوبر.',
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ summary: 'اتفقنا على الإطلاق في أكتوبر.', status: 'idle' });
    expect((await call('GET', `/rooms/${id}/memory`)).body.summary).toBe(
      'اتفقنا على الإطلاق في أكتوبر.',
    );
    await post(id, 'ما الموعد؟');
    await settle();
    expect(prompts.at(-1)).toContain('Summary of the room so far:\nاتفقنا على الإطلاق في أكتوبر.');
  });

  it('refresh asks the lead agent, and covers every finished message', async () => {
    const id = await room({ summary_policy: { every_turns: 0, model: null, provider: null } });
    await post(id, 'نبدأ بالواجهة');
    await settle();
    summaryAnswer = 'الفريق يبدأ بالواجهة، والقائد وافق.';
    const refresh = await call('POST', `/rooms/${id}/memory/refresh`);
    expect(refresh.status).toBe(202);
    expect(refresh.body.job_id).toEqual(expect.any(String));
    await settle();
    const memory = (await call('GET', `/rooms/${id}/memory`)).body;
    expect(memory).toMatchObject({
      summary: 'الفريق يبدأ بالواجهة، والقائد وافق.',
      status: 'idle',
      summarized_turn_count: 2,
      error: null,
    });
    expect(asked.at(-1)).toContain('[Admin] نبدأ بالواجهة');
    expect(asked.at(-1)).toContain('[@القائد] حاضر.');
  });

  it('when the agent cannot answer, the hub writes the summary itself', async () => {
    const id = await room({ summary_policy: { every_turns: 0, model: null, provider: null } });
    await post(id, 'السطر الأول');
    await settle();
    await call('POST', `/rooms/${id}/memory/refresh`);
    await settle();
    expect((await call('GET', `/rooms/${id}/memory`)).body.summary).toBe(
      '- Admin: السطر الأول\n- @القائد: حاضر.',
    );
  });

  it('is rewritten on its own every N messages', async () => {
    const id = await room({ summary_policy: { every_turns: 4, model: null, provider: null } });
    summaryAnswer = 'ملخّص تلقائي.';
    await post(id, 'واحد');
    await settle();
    expect((await call('GET', `/rooms/${id}/memory`)).body.summary).toBeNull();
    await post(id, 'اثنان');
    await settle();
    expect((await call('GET', `/rooms/${id}/memory`)).body).toMatchObject({
      summary: 'ملخّص تلقائي.',
      summarized_turn_count: 4,
    });
  });

  it('only the manager writes or refreshes it', async () => {
    const id = await room();
    await call('POST', '/auth/users', {
      username: 'mona',
      password: 'mona-password-1',
      role: 'member',
      profiles: ['default'],
    });
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'mona', password: 'mona-password-1' },
    });
    const token = (login.json() as { access_token: string }).access_token;
    const code = (await call('GET', `/rooms/${id}`)).body.invite_code as string;
    await authed(hub, token, {
      method: 'POST',
      url: `/api/v1/room-invites/${code}/join`,
      payload: {},
    });
    const put = await authed(hub, token, {
      method: 'PUT',
      url: `/api/v1/rooms/${id}/memory`,
      payload: { summary: 'x' },
    });
    expect(put.statusCode).toBe(403);
    const read = await authed(hub, token, { method: 'GET', url: `/api/v1/rooms/${id}/memory` });
    expect(read.statusCode).toBe(200);
  });

  it('the hub’s own summary keeps the newest lines when it grows too long', () => {
    const long = digest(
      'قديم',
      Array.from({ length: 60 }, (_, i) => ({
        authorKind: 'user' as const,
        authorName: 'Tariq',
        content: `${i} ${'كلام '.repeat(40)}`,
      })),
    );
    expect(long.length).toBeLessThanOrEqual(4_001);
    expect(long.startsWith('…')).toBe(true);
    expect(long).toContain('- Tariq: 59 ');
  });
});

describe('task progress in the project room', () => {
  it('a started task says so in its project room, and says how it ended', async () => {
    const roomId = await room();
    const project = await call('POST', '/projects', { name: 'الموقع', report_room_id: roomId });
    expect(project.status).toBe(201);
    const task = await call('POST', '/tasks', {
      title: 'الصفحة الرئيسية',
      status: 'ready',
      project_id: project.body.id,
    });
    expect(task.status).toBe(201);
    // In the language of the person who started it.
    const assigned = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/tasks/${String(task.body.id)}/assign`,
      payload: { agent_id: AGENT, start: true },
      headers: { 'accept-language': 'ar' },
    });
    expect(assigned.statusCode).toBe(202);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const messages = (await call('GET', `/rooms/${roomId}/messages`)).body.items as Array<
      Json & { content: Array<{ text: string }> }
    >;
    const reports = messages.filter((m) => m.role === 'system').map((m) => m.content[0]!.text);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatch(/^بدأ Hermes العمل على المهمة [^ ]+-1 «الصفحة الرئيسية»\.$/);
    expect(reports[1]).toMatch(
      /^أنهى Hermes المهمة [^ ]+-1 «الصفحة الرئيسية»: أنجزت الصفحة\. بقي: المراجعة\.$/,
    );
    expect(messages.find((m) => m.role === 'system')).toMatchObject({
      author: { kind: 'system', name: 'Core Hub' },
    });
  });

  it('a project with no room reports nowhere', async () => {
    const project = await call('POST', '/projects', { name: 'بلا غرفة' });
    const task = await call('POST', '/tasks', {
      title: 'مهمة صامتة',
      status: 'ready',
      project_id: project.body.id,
    });
    const assigned = await call('POST', `/tasks/${String(task.body.id)}/assign`, {
      agent_id: AGENT,
      start: true,
    });
    expect(assigned.status).toBe(202);
    await settle();
  });
});
