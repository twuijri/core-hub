/**
 * Assigning a task **starts** it — across two modules, which is why this lives here and not
 * inside either: `tasks` decides what the task does, `sessions` runs the turn (played by
 * the scripted runner), and the composition root joins them exactly as production does.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../src/lib/db.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import { runs } from '../../src/modules/sessions/schema.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { registerHermesBoard, taskRunsFor } from '../../src/modules/tasks/index.js';
import type { HermesKanban, HermesTask } from '../../src/modules/tasks/hermes-kanban.js';
import { tasks } from '../../src/modules/tasks/schema.js';
import { authed, drainJobs, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';
const OTHER = '01KAGENTSECND0000000000000';
const HERMES = '01KHERMESAGENT000000000000';

const finishes: ScriptStep[] = [
  { type: 'message_delta', text: 'أضفت الصفحة وكتبت اختبارها. بقي: مراجعة النصوص.' },
  { type: 'completed' },
];
/** A run that works until somebody stops it. */
const waits: ScriptStep[] = [{ type: 'message_delta', text: 'أعمل…' }, { type: 'await_input' }];

async function hubWith(script: ScriptStep[], env: Record<string, string> = {}) {
  const runner = new FakeAgentRunner({ script });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT), fakeHermes(OTHER), fakeHermes(HERMES)]),
    runner,
    agentTimeoutMs: 5_000,
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
    payload: { title, status: 'ready', auto_start: false, ...extra },
  });
  expect(created.statusCode).toBe(201);
  return created.json() as Json & { id: string };
}

const assign = (hub: Hub, id: string, payload: Json) =>
  authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${id}/assign`, payload });

async function getTask(hub: Hub, id: string) {
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${id}` })
  ).json() as Json;
}

async function getSession(hub: Hub, id: string) {
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/sessions/${id}` })
  ).json() as Json;
}

/** Wait for something the engine does on its own time (a run reaching the adapter). */
async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const promptOf = (runner: FakeAgentRunner, index = 0) =>
  (runner.started[index]?.prompt ?? [])
    .map((block) => ('text' in block ? block.text : ''))
    .join('');

describe('tasks: assigning and starting runs the agent', () => {
  it('answers with real ids at once, and the task is running in a session of its own', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات', {
        description: 'للهاتف أولًا.',
        subtasks: [{ title: 'التصميم' }, { title: 'الاختبار' }],
      });
      // One line of the checklist is already done; the agent must be told which.
      const detail = await getTask(hub, task.id);
      const first = (detail.subtasks as Json[])[0]!;
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id}/subtasks/${first.id as string}`,
        payload: { status: 'done' },
      });

      const response = await assign(hub, task.id, {
        agent_id: AGENT,
        model: 'model-x',
        provider: 'provider-y',
        instructions: 'ابدأ بتبويب الحساب.',
        start: true,
      });
      expect(response.statusCode).toBe(202);
      const ids = response.json() as Json;
      expect(ids.task_id).toBe(task.id);
      for (const key of ['job_id', 'run_id', 'session_id']) {
        expect(ids[key]).toMatch(/^[0-9A-Z]{26}$/);
      }

      const running = await getTask(hub, task.id);
      expect(running).toMatchObject({
        status: 'running',
        session_id: ids.session_id,
        attempt_count: 1,
        assignee: { kind: 'agent', id: AGENT },
      });
      expect(running.last_run).toMatchObject({ id: ids.run_id });

      const session = await getSession(hub, ids.session_id as string);
      expect(session).toMatchObject({
        source: 'task',
        origin: { kind: 'task', id: task.id },
        model: 'model-x',
      });
      expect((session.runs as Json[]).map((run) => run.id)).toContain(ids.run_id);

      await until(() => runner.started.length === 1);
      expect(runner.started[0]).toMatchObject({ model: 'model-x', provider: 'provider-y' });
      const prompt = promptOf(runner);
      expect(prompt).toContain('صفحة الإعدادات');
      expect(prompt).toContain('للهاتف أولًا.');
      expect(prompt).toContain('- [x] التصميم');
      expect(prompt).toContain('- [ ] الاختبار');
      expect(prompt).toContain('ابدأ بتبويب الحساب.');
      await authed(hub, hub.token, { method: 'POST', url: `/api/v1/tasks/${task.id}/stop` });
      await taskRunsFor(hub.app).settled();
    } finally {
      await hub.close();
    }
  });

  it('moves to review with the agent’s last words when the run completes', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const ids = (await assign(hub, task.id, { agent_id: AGENT, start: true })).json() as Json;
      await taskRunsFor(hub.app).settled();
      const after = await getTask(hub, task.id);
      expect(after).toMatchObject({
        status: 'review',
        latest_summary: 'أضفت الصفحة وكتبت اختبارها. بقي: مراجعة النصوص.',
        session_id: ids.session_id,
        blocked_reason: null,
      });
      // The run is over: the task keeps its session, not a run "in flight".
      expect(after.last_run).toMatchObject({ id: null });

      const activity = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/tasks/${task.id}/activity`,
        })
      ).json() as { items: Json[] };
      const moves = activity.items
        .filter((item) => item.kind === 'moved')
        .map((item) => (item.data as Json).to);
      expect(moves).toEqual(expect.arrayContaining(['running', 'review']));
      expect(
        activity.items.find((item) => (item.data as Json).to === 'review')?.actor,
      ).toMatchObject({ kind: 'agent', id: AGENT });
    } finally {
      await hub.close();
    }
  });

  it('moves to blocked, saying why, when the run fails', async () => {
    const { hub } = await hubWith([
      { type: 'message_delta', text: 'بدأت' },
      { type: 'failed', code: 'provider_error', message: 'the provider refused the key' },
    ]);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      await assign(hub, task.id, { agent_id: AGENT, start: true });
      await taskRunsFor(hub.app).settled();
      const after = await getTask(hub, task.id);
      expect(after.status).toBe('blocked');
      expect(after.blocked_reason).toContain('the provider refused the key');
    } finally {
      await hub.close();
    }
  });

  it('stop cancels the run for real; the task stays assigned, in ready', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const ids = (await assign(hub, task.id, { agent_id: AGENT, start: true })).json() as Json;
      await until(() => runner.started.length === 1);
      const stopped = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/stop`,
      });
      expect(stopped.statusCode).toBe(204);
      await taskRunsFor(hub.app).settled();
      expect(runner.interrupted).toContain(ids.run_id);

      const after = await getTask(hub, task.id);
      // Moved once, by the stop — the run's own ending does not move it a second time.
      expect(after).toMatchObject({ status: 'ready', assignee: { id: AGENT } });
      const run = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/sessions/${ids.session_id as string}/runs/${ids.run_id as string}`,
        })
      ).json() as Json;
      expect(run.status).toBe('cancelled');
    } finally {
      await hub.close();
    }
  });

  it('unassign stops the run and returns the task to ready, with nobody on it', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const ids = (await assign(hub, task.id, { agent_id: AGENT, start: true })).json() as Json;
      await until(() => runner.started.length === 1);
      const response = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${task.id}/assign`,
      });
      expect(response.statusCode).toBe(204);
      await taskRunsFor(hub.app).settled();
      expect(runner.interrupted).toContain(ids.run_id);
      expect(await getTask(hub, task.id)).toMatchObject({ status: 'ready', assignee: null });
    } finally {
      await hub.close();
    }
  });

  it('a person moving a running task elsewhere takes it off its run, and the run stops', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const ids = (await assign(hub, task.id, { agent_id: AGENT, start: true })).json() as Json;
      await until(() => runner.started.length === 1);
      const moved = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/move`,
        payload: { status: 'done' },
      });
      expect(moved.statusCode).toBe(200);
      await taskRunsFor(hub.app).settled();
      expect(runner.interrupted).toContain(ids.run_id);
      expect(await getTask(hub, task.id)).toMatchObject({ status: 'done' });
    } finally {
      await hub.close();
    }
  });

  it('reassigning a running task interrupts its run and starts the new one', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const first = (await assign(hub, task.id, { agent_id: AGENT, start: true })).json() as Json;
      await until(() => runner.started.length === 1);
      runner.play(finishes);
      const second = (await assign(hub, task.id, { agent_id: OTHER, start: true })).json() as Json;
      expect(second.run_id).not.toBe(first.run_id);
      expect(second.session_id).not.toBe(first.session_id);
      expect(runner.interrupted).toContain(first.run_id);
      await taskRunsFor(hub.app).settled();
      // The first run's ending found the task on another run and left it alone.
      expect(await getTask(hub, task.id)).toMatchObject({
        status: 'review',
        session_id: second.session_id,
        assignee: { id: OTHER },
        attempt_count: 2,
      });
    } finally {
      await hub.close();
    }
  });

  it('assigns only, with null ids, when start is not asked for', async () => {
    const { hub, runner } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const response = await assign(hub, task.id, { agent_id: AGENT });
      expect(response.json()).toEqual({
        job_id: null,
        run_id: null,
        session_id: null,
        task_id: task.id,
      });
      expect(runner.started).toHaveLength(0);
      expect((await getTask(hub, task.id)).status).toBe('ready');
    } finally {
      await hub.close();
    }
  });

  it('refuses an agent that cannot run before changing the task', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const response = await assign(hub, task.id, {
        agent_id: '01KZZZZZZZZZZZZZZZZZZZZZZZ',
        start: true,
      });
      expect(response.statusCode).toBe(404);
      expect(await getTask(hub, task.id)).toMatchObject({ status: 'ready', assignee: null });
      const sessions = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/sessions' })
      ).json() as { items: Json[] };
      expect(sessions.items).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it('dispatch starts the ready tasks it assigns, the same way', async () => {
    const { hub } = await hubWith(finishes);
    try {
      const task = await newTask(hub, 'صفحة الإعدادات');
      const project = task.project_id as string;
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/projects/${project}`,
        payload: { default_agent_id: AGENT },
      });
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/task-dispatches',
        payload: { project_id: project, max: 5, dry_run: false },
      });
      expect(response.statusCode).toBe(202);
      await drainJobs(hub.app);
      await taskRunsFor(hub.app).settled();
      const after = await getTask(hub, task.id);
      expect(after.status).toBe('review');
      expect(after.session_id).toMatch(/^[0-9A-Z]{26}$/);
    } finally {
      await hub.close();
    }
  });
});

describe("tasks: Hermes's cards are Hermes's to run", () => {
  let previous: ReturnType<typeof registerHermesBoard> = null;
  afterEach(() => {
    registerHermesBoard(previous);
  });

  it('starts no hub run for a task given to Hermes', async () => {
    const cards = new Map<string, HermesTask>();
    const kanban: HermesKanban = {
      list: async () => [...cards.values()],
      show: async (id) => cards.get(id) ?? null,
      create: async (input) => {
        const card: HermesTask = {
          id: `t_${String(cards.size + 1).padStart(8, '0')}`,
          title: input.title,
          body: input.body ?? null,
          assignee: null,
          status: 'ready',
          priority: 0,
          created_at: 1,
          result: null,
        };
        cards.set(card.id, card);
        return card;
      },
      archive: async () => {},
      move: async () => {},
    };
    previous = registerHermesBoard(() => ({
      kanban: () => kanban,
      agentId: () => HERMES,
      throttleMs: 0,
    }));
    const { hub, runner } = await hubWith(finishes);
    try {
      // A hub card given to Hermes, and a card that lives on Hermes's board.
      const plain = await newTask(hub, 'بطاقة المركز');
      const onHermes = await newTask(hub, 'بطاقة هرمز', { assignee_agent_id: HERMES });
      expect(onHermes.external).toMatchObject({ source: 'hermes' });
      for (const id of [plain.id, onHermes.id]) {
        const response = await assign(hub, id, { agent_id: HERMES, start: true });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ job_id: null, run_id: null, session_id: null });
      }
      await taskRunsFor(hub.app).settled();
      expect(runner.started).toHaveLength(0);
      // The hub's card went onto Hermes's board — one card, keyed by the hub's id — so
      // Hermes's dispatcher is the one that runs it.
      expect(cards.size).toBe(2);
      expect(await getTask(hub, plain.id)).toMatchObject({
        status: 'ready',
        external: { source: 'hermes' },
        assignee: { id: HERMES },
        session_id: null,
      });
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: a restart leaves nothing running forever', () => {
  it('settles at boot every task it finds running, by what its run says', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-restart-'));
    try {
      const first = await hubWith(finishes, { DATA_DIR: dir });
      const finished = await newTask(first.hub, 'انتهت قبل الانقطاع');
      const cutShort = await newTask(first.hub, 'قُطعت في منتصفها');
      const lost = await newTask(first.hub, 'لا أثر لتشغيلها');
      const a = (
        await assign(first.hub, finished.id, { agent_id: AGENT, start: true })
      ).json() as Json;
      const b = (
        await assign(first.hub, cutShort.id, { agent_id: AGENT, start: true })
      ).json() as Json;
      await taskRunsFor(first.hub.app).settled();

      // The state a crash leaves: tasks still `running`. One whose run had ended a moment
      // before (its follow-up never ran), one whose run was mid-stream, one with no run.
      const db = requireSqlite(first.hub.app.hub.database);
      const set = (id: string, runId: string) =>
        db
          .update(tasks)
          .set({ status: 'running', currentRunId: runId })
          .where(eq(tasks.id, id))
          .run();
      set(finished.id, a.run_id as string);
      set(cutShort.id, b.run_id as string);
      db.update(runs)
        .set({ status: 'streaming', finishedAt: null })
        .where(eq(runs.id, b.run_id as string))
        .run();
      set(lost.id, '01KZZZZZZZZZZZZZZZZZZZZZZY');
      await first.hub.app.close();

      const second = await hubWith(finishes, { DATA_DIR: dir });
      try {
        expect(await getTask(second.hub, finished.id)).toMatchObject({
          status: 'review',
          latest_summary: 'أضفت الصفحة وكتبت اختبارها. بقي: مراجعة النصوص.',
        });
        for (const id of [cutShort.id, lost.id]) {
          const after = await getTask(second.hub, id);
          expect(after.status).toBe('blocked');
          expect(after.blocked_reason).toMatch(/أُعيد تشغيل المركز/);
        }
      } finally {
        await second.hub.app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
