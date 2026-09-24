/**
 * The hub fires its own schedules — across two modules, which is why this lives here:
 * `schedules` decides when and what, `sessions` runs the turn (played by the scripted
 * runner), and the composition root joins them exactly as production does.
 *
 * What a person sees: "Run now" and a schedule's own time both start a real run in a
 * session of source `schedule`, the history line carries that session so the page can open
 * it, the run's ending lands on the line and on the schedule, a workflow schedule starts
 * its workflow, and a restart leaves no line open forever.
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
import { schedulerFor, workflowEngineFor } from '../../src/modules/schedules/index.js';
import { scheduleRuns, schedules } from '../../src/modules/schedules/schema.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';

const answers: ScriptStep[] = [
  { type: 'message_delta', text: 'ملخص اليوم: ثلاث مهام أُنجزت.' },
  { type: 'completed' },
];
/** A run that works until somebody stops it. */
const waits: ScriptStep[] = [{ type: 'message_delta', text: 'أعمل…' }, { type: 'await_input' }];

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function hubWith(script: ScriptStep[], env: Record<string, string> = {}) {
  const runner = new FakeAgentRunner({ script });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  const hub = await signedInHub(env, { modules });
  return { hub, runner };
}

const promptSchedule = (over: Json = {}) => ({
  name: 'تقرير الصباح',
  trigger: {
    kind: 'cron',
    expression: '0 9 * * *',
    every_minutes: null,
    run_at: null,
    timezone: 'Asia/Riyadh',
  },
  target: {
    kind: 'agent_prompt',
    agent_id: AGENT,
    prompt: 'اكتب ملخص اليوم',
    model: null,
    provider: null,
    skills: [],
    workflow_id: null,
    input: null,
  },
  ...over,
});

async function create(hub: Hub, payload: Json) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/schedules',
    payload,
  });
  expect(created.statusCode).toBe(201);
  return created.json() as Json & { id: string };
}

const runNow = (hub: Hub, id: string) =>
  authed(hub, hub.token, { method: 'POST', url: `/api/v1/schedules/${id}/run` });

async function history(hub: Hub, id: string) {
  const got = await authed(hub, hub.token, { method: 'GET', url: `/api/v1/schedules/${id}/runs` });
  expect(got.statusCode).toBe(200);
  return (got.json() as { items: Json[] }).items;
}

async function getSchedule(hub: Hub, id: string) {
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/schedules/${id}` })
  ).json() as Json;
}

/** Wait for something that happens on the run's own time. */
async function until(check: () => Promise<boolean> | boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const promptOf = (runner: FakeAgentRunner, index = 0) =>
  (runner.started[index]?.prompt ?? [])
    .map((block) => ('text' in block ? block.text : ''))
    .join('');

describe('schedules: run now starts a real run', () => {
  it('answers with the real ids, in a session of source schedule, and the history opens it', async () => {
    const { hub, runner } = await hubWith(answers);
    try {
      const schedule = await create(hub, promptSchedule());
      const nextBefore = schedule.next_run_at;
      const response = await runNow(hub, schedule.id);
      expect(response.statusCode).toBe(202);
      const ids = response.json() as Json;
      for (const key of ['job_id', 'schedule_run_id', 'session_id', 'run_id']) {
        expect(ids[key]).toMatch(/^[0-9A-Z]{26}$/);
      }
      expect(ids.workflow_run_id).toBeNull();

      // An ordinary conversation, in the schedule's profile, that says what started it.
      const session = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/sessions/${ids.session_id as string}`,
        })
      ).json() as Json;
      expect(session).toMatchObject({
        source: 'schedule',
        profile: 'default',
        origin: { kind: 'schedule_run', id: ids.schedule_run_id },
      });
      await until(() => runner.started.length === 1);
      expect(promptOf(runner)).toContain('اكتب ملخص اليوم');

      // The line ends with the run, carries its session, and the schedule remembers.
      await until(async () => (await history(hub, schedule.id))[0]?.status === 'succeeded');
      const [line] = await history(hub, schedule.id);
      expect(line).toMatchObject({
        id: ids.schedule_run_id,
        session_id: ids.session_id,
        run_id: ids.run_id,
        trigger: 'manual',
        status: 'succeeded',
        output_preview: 'ملخص اليوم: ثلاث مهام أُنجزت.',
      });
      const after = await getSchedule(hub, schedule.id);
      expect(after).toMatchObject({ last_status: 'succeeded', repeat: { completed: 1 } });
      // Run now leaves the schedule's own next time alone.
      expect(after.next_run_at).toBe(nextBefore);
    } finally {
      await hub.close();
    }
  });

  it('records a failed line and answers 409 when the agent is not installed', async () => {
    const { hub } = await hubWith(answers);
    try {
      const schedule = await create(
        hub,
        promptSchedule({
          target: { ...promptSchedule().target, agent_id: '01KZZZZZZZZZZZZZZZZZZZZZZX' },
        }),
      );
      const response = await runNow(hub, schedule.id);
      expect(response.statusCode).toBe(409);
      expect((response.json() as { details: Json }).details).toMatchObject({
        reason: 'target_unavailable',
        message: 'the agent this schedule names is not installed',
      });
      const [line] = await history(hub, schedule.id);
      expect(line).toMatchObject({ status: 'failed', session_id: null });
      expect(await getSchedule(hub, schedule.id)).toMatchObject({
        last_status: 'failed',
        last_error: 'the agent this schedule names is not installed',
      });
    } finally {
      await hub.close();
    }
  });
});

describe("schedules: the schedule's own time", () => {
  it('fires when due, records the session, and moves the next time on', async () => {
    const { hub, runner } = await hubWith(answers);
    try {
      const schedule = await create(hub, promptSchedule());
      const due = new Date(String(schedule.next_run_at));
      const at = new Date(due.getTime() + 5_000);
      expect(await schedulerFor(hub.app).tick(at)).toBe(1);
      await until(() => runner.started.length === 1);
      await until(async () => (await history(hub, schedule.id))[0]?.status === 'succeeded');
      const [line] = await history(hub, schedule.id);
      expect(line).toMatchObject({ trigger: 'schedule', status: 'succeeded' });
      expect(line!.session_id).toMatch(/^[0-9A-Z]{26}$/);
      const after = await getSchedule(hub, schedule.id);
      // The next 09:00 in Riyadh after the one that fired.
      expect(after.next_run_at).toBe(new Date(due.getTime() + 24 * 3600_000).toISOString());

      // The same moment again (a second look, or a restart) fires nothing.
      expect(await schedulerFor(hub.app).tick(at)).toBe(0);
      expect(await history(hub, schedule.id)).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('starts a workflow schedule as a workflow run, and settles the line when it ends', async () => {
    const { hub } = await hubWith(answers);
    try {
      const workflow = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows',
          payload: {
            name: 'انتظار قصير',
            nodes: [
              {
                id: 'wait',
                kind: 'delay',
                title: 'wait',
                agent_id: null,
                model: null,
                provider: null,
                reasoning_effort: null,
                skills: [],
                input: '0',
                approval_required: false,
                position: { x: 0, y: 0 },
              },
            ],
            edges: [],
          },
        })
      ).json() as Json;
      const schedule = await create(
        hub,
        promptSchedule({
          target: {
            ...promptSchedule().target,
            kind: 'workflow',
            agent_id: null,
            prompt: null,
            workflow_id: workflow.id,
          },
        }),
      );
      const response = await runNow(hub, schedule.id);
      expect(response.statusCode).toBe(202);
      const ids = response.json() as Json;
      expect(ids.workflow_run_id).toMatch(/^[0-9A-Z]{26}$/);
      expect(ids.session_id).toBeNull();
      await workflowEngineFor(hub.app).settled();
      const run = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/workflow-runs/${ids.workflow_run_id as string}`,
        })
      ).json() as Json;
      expect(run).toMatchObject({
        status: 'succeeded',
        trigger: { kind: 'schedule', id: schedule.id },
      });
      const [line] = await history(hub, schedule.id);
      expect(line).toMatchObject({ status: 'succeeded', workflow_run_id: ids.workflow_run_id });
    } finally {
      await hub.close();
    }
  });
});

describe('schedules: a restart leaves no line open', () => {
  it('settles at boot by what the run says, or as cut short', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'majlis-sched-restart-'));
    cleanup.push(dir);
    const first = await hubWith(waits, { DATA_DIR: dir });
    const schedule = await create(first.hub, promptSchedule());
    const running = (await runNow(first.hub, schedule.id)).json() as Json;
    await until(() => first.runner.started.length === 1);
    // A line with no run at all: written, and the process died before it started.
    const db = requireSqlite(first.hub.app.hub.database);
    const row = db.select().from(schedules).where(eq(schedules.id, schedule.id)).get()!;
    db.insert(scheduleRuns)
      .values({
        id: '01KZZZZZZZZZZZZZZZZZZZZZZY',
        ownerId: row.ownerId,
        workspace: row.workspace,
        scheduleId: row.id,
        scheduledFor: new Date(0),
        status: 'queued',
      })
      .run();
    // The run is still streaming when the process goes.
    db.update(runs)
      .set({ status: 'streaming' })
      .where(eq(runs.id, running.run_id as string))
      .run();
    await first.hub.app.close();

    const second = await hubWith(answers, { DATA_DIR: dir });
    try {
      const lines = await history(second.hub, schedule.id);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatchObject({
          status: 'failed',
          error: 'the hub restarted while this run was going',
        });
      }
    } finally {
      await second.hub.app.close();
    }
  });
});
