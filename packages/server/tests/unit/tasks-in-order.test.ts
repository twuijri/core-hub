/**
 * Tasks run in order (DECISIONS §92): a task set to start on its own waits for what it
 * depends on, a running task whose run goes quiet is marked stuck and its owner told, and
 * the board counts the archive without sending it. Across modules — `tasks`, `sessions`
 * (played by the scripted runner), `schedules` (the clock) and `notify` (the inbox) — joined
 * by the composition root exactly as production does.
 */
import { describe, expect, it } from 'vitest';
import { requireSqlite } from '../../src/lib/db.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { schedulerFor } from '../../src/modules/schedules/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { TasksService, taskRunsFor, watchStuckTasks } from '../../src/modules/tasks/index.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';
const MINUTE = 60_000;

const finishes: ScriptStep[] = [{ type: 'message_delta', text: 'تم.' }, { type: 'completed' }];
/** A run that says one thing and then nothing, until somebody stops it. */
const goesQuiet: ScriptStep[] = [{ type: 'message_delta', text: 'أعمل…' }, { type: 'await_input' }];

async function hubWith(script: ScriptStep[], env: Record<string, string> = {}) {
  const runner = new FakeAgentRunner({ script });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 60_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  const hub = await signedInHub(env, { modules });
  return { hub, runner };
}

async function newTask(hub: Hub, title: string, extra: Json = {}) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/tasks',
    payload: { title, status: 'todo', auto_start: false, ...extra },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json() as Json & { id: string };
}

async function getTask(hub: Hub, id: string) {
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${id}` })
  ).json() as Json;
}

async function move(hub: Hub, id: string, status: string) {
  const moved = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/tasks/${id}/move`,
    payload: { status },
  });
  expect(moved.statusCode, moved.body).toBe(200);
  return moved.json() as Json;
}

async function dependOn(hub: Hub, id: string, on: string[]) {
  const set = await authed(hub, hub.token, {
    method: 'PUT',
    url: `/api/v1/tasks/${id}/dependencies`,
    payload: { depends_on: on },
  });
  expect(set.statusCode, set.body).toBe(200);
  return set.json() as Json;
}

async function board(hub: Hub, query = '') {
  const response = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/task-columns${query}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    columns: Array<{ status: string; count: number; tasks: Json[] }>;
    counts: { total: number; by_status: Record<string, number> };
  };
}

async function notices(hub: Hub) {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/notices' });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Json[] }).items;
}

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const stuckNotices = (items: Json[]) =>
  items.filter((item) => /A task seems stuck|مهمة متوقفة عن التقدّم/.test(String(item.title)));

describe('tasks: auto_start waits for what the task depends on', () => {
  it('stays waiting, says on what, and starts itself when the last one is done', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const first = await newTask(hub, 'First');
      const second = await newTask(hub, 'Second');
      const waiter = await newTask(hub, 'Waiter', { assignee_agent_id: AGENT, auto_start: true });
      const set = await dependOn(hub, waiter.id, [first.id, second.id]);
      expect(set.waiting_on).toEqual([
        { id: first.id, title: 'First', status: 'todo' },
        { id: second.id, title: 'Second', status: 'todo' },
      ]);

      // Ready, given to an agent, set to start on its own — and still it waits.
      await move(hub, waiter.id, 'ready');
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(0);
      expect((await getTask(hub, waiter.id)).status).toBe('ready');

      // One done is not all done; the card on the board says what is left.
      await move(hub, first.id, 'done');
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(0);
      const card = (await board(hub)).columns
        .find((column) => column.status === 'ready')!
        .tasks.find((task) => task.id === waiter.id)!;
      expect(card.waiting_on).toEqual([{ id: second.id, title: 'Second', status: 'todo' }]);

      // The last one reaches done: it starts by itself, and waits on nothing any more.
      await move(hub, second.id, 'done');
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(1);
      const after = await getTask(hub, waiter.id);
      expect(after).toMatchObject({ status: 'review', waiting_on: [], attempt_count: 1 });
    } finally {
      await hub.close();
    }
  });

  it('a person can still start it by hand before its dependencies are done', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const before = await newTask(hub, 'Before');
      const task = await newTask(hub, 'By hand', { status: 'ready' });
      await dependOn(hub, task.id, [before.id]);
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      expect(started.statusCode, started.body).toBe(202);
      expect((started.json() as Json).run_id).toMatch(/^[0-9A-Z]{26}$/);
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(1);
      expect((await getTask(hub, task.id)).waiting_on).toEqual([
        { id: before.id, title: 'Before', status: 'todo' },
      ]);
    } finally {
      await hub.close();
    }
  });

  it('counts archived-after-done as done, and archived by hand as not done', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const archivedByHand = await newTask(hub, 'Dropped');
      await move(hub, archivedByHand.id, 'archived');
      const finished = await newTask(hub, 'Finished');
      await move(hub, finished.id, 'done');
      // The weekly archive takes it, the way opening the board does after seven days.
      const profiles = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' })
      ).json() as { items: Array<{ id: string }> };
      const archived = new TasksService(requireSqlite(hub.app.hub.database)).archiveDoneBefore(
        profiles.items.map((profile) => profile.id),
        new Date(Date.now() + MINUTE),
      );
      expect(archived).toBe(1);
      expect((await getTask(hub, finished.id)).status).toBe('archived');
      const task = await newTask(hub, 'After both');
      const set = await dependOn(hub, task.id, [archivedByHand.id, finished.id]);
      expect(set.waiting_on).toEqual([
        { id: archivedByHand.id, title: 'Dropped', status: 'archived' },
      ]);
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: the stuck-task watchdog', () => {
  it('marks a running task whose run went quiet, tells its owner once, and clears on activity', async () => {
    const { hub, runner } = await hubWith(goesQuiet, { COREHUB_TASK_STUCK_MINUTES: '5' });
    try {
      const task = await newTask(hub, 'Quiet one', { status: 'ready' });
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      expect(started.statusCode, started.body).toBe(202);
      const runId = (started.json() as { run_id: string }).run_id;
      await until(() => runner.started.length === 1);

      // Within the allowed silence: nothing.
      expect(watchStuckTasks(hub.app, new Date(Date.now() + 4 * MINUTE))).toEqual({
        marked: 0,
        cleared: 0,
      });
      expect((await getTask(hub, task.id)).stuck_since).toBeNull();

      // Past it, on the scheduler's own clock: the marker, and one notice.
      await schedulerFor(hub.app).tick(new Date(Date.now() + 6 * MINUTE));
      const stuck = await getTask(hub, task.id);
      expect(stuck.status).toBe('running');
      expect(stuck.stuck_since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const told = stuckNotices(await notices(hub));
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({
        kind: 'task_moved',
        resource: { kind: 'task', id: task.id },
      });
      expect(String(told[0]!.body)).toContain('Quiet one');

      // Still quiet a while later: still stuck, and nobody is told twice.
      expect(watchStuckTasks(hub.app, new Date(Date.now() + 20 * MINUTE))).toEqual({
        marked: 0,
        cleared: 0,
      });
      expect(stuckNotices(await notices(hub))).toHaveLength(1);

      // The run speaks again: the marker goes.
      const later = Date.now() + 21 * MINUTE;
      taskRunsFor(hub.app).noteActivity(runId, later);
      expect(watchStuckTasks(hub.app, new Date(later + MINUTE))).toEqual({
        marked: 0,
        cleared: 1,
      });
      expect((await getTask(hub, task.id)).stuck_since).toBeNull();

      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${task.id}/stop` });
      await taskRunsFor(hub.app).settled();
    } finally {
      await hub.close();
    }
  });

  it('a task that leaves running is not stuck any more, and 0 switches the watchdog off', async () => {
    const { hub, runner } = await hubWith(goesQuiet, { COREHUB_TASK_STUCK_MINUTES: '5' });
    try {
      const task = await newTask(hub, 'Stopped one', { status: 'ready' });
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      await until(() => runner.started.length === 1);
      expect(watchStuckTasks(hub.app, new Date(Date.now() + 10 * MINUTE)).marked).toBe(1);
      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${task.id}/stop` });
      await taskRunsFor(hub.app).settled();
      expect(await getTask(hub, task.id)).toMatchObject({ status: 'ready', stuck_since: null });
    } finally {
      await hub.close();
    }
    const off = await hubWith(goesQuiet, { COREHUB_TASK_STUCK_MINUTES: '0' });
    try {
      const task = await newTask(off.hub, 'Unwatched', { status: 'ready' });
      await authed(off.hub, off.hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/assign`,
        payload: { agent_id: AGENT, start: true },
      });
      await until(() => off.runner.started.length === 1);
      expect(watchStuckTasks(off.hub.app, new Date(Date.now() + 999 * MINUTE))).toEqual({
        marked: 0,
        cleared: 0,
      });
      await authed(off.hub, off.hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/stop`,
      });
      await taskRunsFor(off.hub.app).settled();
    } finally {
      await off.hub.close();
    }
  });
});

describe('tasks: the archive is fetched when asked for', () => {
  it('the board counts the archive and sends none of it without include_archived', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const kept = await newTask(hub, 'Still here');
      for (const title of ['Old one', 'Old two']) {
        const task = await newTask(hub, title);
        await move(hub, task.id, 'archived');
      }
      const plain = await board(hub);
      const archive = plain.columns.find((column) => column.status === 'archived')!;
      expect(archive).toMatchObject({ count: 2, tasks: [] });
      expect(plain.counts.by_status.archived).toBe(2);
      expect(plain.counts.total).toBe(1);
      expect(plain.columns.flatMap((column) => column.tasks).map((task) => task.id)).toEqual([
        kept.id,
      ]);

      const full = await board(hub, '?include_archived=true');
      const opened = full.columns.find((column) => column.status === 'archived')!;
      expect(opened.count).toBe(2);
      expect(opened.tasks.map((task) => task.title).sort()).toEqual(['Old one', 'Old two']);
      expect(full.counts.total).toBe(3);
    } finally {
      await hub.close();
    }
  });
});
