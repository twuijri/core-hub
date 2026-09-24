/**
 * Archiving a conversation stops what is running in it (owner, 2026-09-24).
 *
 * Archive used to be a flag and nothing more: the agent kept working — and spending — in a
 * conversation the person had put away, and a task whose conversation was archived stayed
 * `running` on the board until its run happened to end. Now archiving one conversation, or
 * several at once from the list, stops each live run the way the chat's own Stop does
 * (`sessions.cancelRun`): a queued run never starts, an active one is interrupted and ends
 * `cancelled`. A task on such a run then moves as a stop from the chat moves it — back to
 * `ready`, still assigned (docs/changes/2026-09-24-twuijri-task-runs.md).
 */
import { describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { taskRunsFor } from '../../src/modules/tasks/index.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';

/** A run that works until somebody stops it. */
const waits: ScriptStep[] = [{ type: 'message_delta', text: 'أعمل…' }, { type: 'await_input' }];

async function hubWith(script: ScriptStep[]) {
  const runner = new FakeAgentRunner({ script });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  const hub = await signedInHub({}, { modules });
  return { hub, runner };
}

async function newSession(hub: Hub): Promise<string> {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: AGENT },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { id: string }).id;
}

async function send(hub: Hub, sessionId: string, text: string): Promise<string> {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/sessions/${sessionId}/runs`,
    payload: { content: [{ type: 'text', text }], when: 'queue' },
  });
  expect(response.statusCode).toBe(202);
  const body = response.json() as { run?: { id: string }; run_id?: string; id?: string };
  return (body.run?.id ?? body.run_id ?? body.id) as string;
}

async function runOf(hub: Hub, sessionId: string, runId: string): Promise<Json> {
  return (
    await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/runs/${runId}`,
    })
  ).json() as Json;
}

/** Wait for something the engine does on its own time. */
async function until(check: () => boolean | Promise<boolean>, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('sessions: archiving stops the work in the conversation', () => {
  it('archiving one conversation interrupts its active run, which ends cancelled', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const id = await newSession(hub);
      const run = await send(hub, id, 'ابدأ');
      await until(() => runner.started.length === 1);

      const archived = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/sessions/${id}`,
        payload: { archived: true },
      });
      expect(archived.statusCode).toBe(200);
      expect((archived.json() as Json).archived).toBe(true);
      expect(runner.interrupted).toContain(run);
      await until(async () => (await runOf(hub, id, run)).status === 'cancelled');
    } finally {
      await hub.close();
    }
  });

  it('bulk archive stops every live run in every chosen conversation, queued ones included', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const first = await newSession(hub);
      const second = await newSession(hub);
      const idle = await newSession(hub);
      const active1 = await send(hub, first, 'الأولى');
      const queued1 = await send(hub, first, 'التالية في الطابور');
      const active2 = await send(hub, second, 'الثانية');
      await until(() => runner.started.length === 2);
      expect((await runOf(hub, first, queued1)).status).toBe('queued');

      const response = await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/sessions',
        payload: { session_ids: [first, second, idle], patch: { archived: true } },
      });
      expect(response.statusCode).toBe(200);
      const results = (response.json() as { results: Array<{ id: string; ok: boolean }> }).results;
      expect(results.every((result) => result.ok)).toBe(true);

      expect(runner.interrupted).toEqual(expect.arrayContaining([active1, active2]));
      await until(async () => (await runOf(hub, first, active1)).status === 'cancelled');
      await until(async () => (await runOf(hub, second, active2)).status === 'cancelled');
      // The queued turn never starts: stopping the active one must not hand the adapter
      // the next in line.
      expect((await runOf(hub, first, queued1)).status).toBe('cancelled');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runner.started).toHaveLength(2);
    } finally {
      await hub.close();
    }
  });

  it('restoring from the archive, or archiving an idle conversation, stops nothing', async () => {
    const { hub, runner } = await hubWith([
      { type: 'message_delta', text: 'تم' },
      { type: 'completed' },
    ]);
    try {
      const id = await newSession(hub);
      const run = await send(hub, id, 'مرحبا');
      await until(async () => (await runOf(hub, id, run)).status === 'succeeded');
      for (const archived of [true, false]) {
        const response = await authed(hub, hub.token, {
          method: 'PATCH',
          url: `/api/v1/sessions/${id}`,
          payload: { archived },
        });
        expect(response.statusCode).toBe(200);
      }
      expect(runner.interrupted).toEqual([]);
      expect((await runOf(hub, id, run)).status).toBe('succeeded');
    } finally {
      await hub.close();
    }
  });

  it('a task whose conversation is archived stops, and goes back to ready still assigned', async () => {
    const { hub, runner } = await hubWith(waits);
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: { title: 'صفحة الإعدادات', status: 'ready', auto_start: false },
      });
      const task = created.json() as { id: string };
      const ids = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/assign`,
          payload: { agent_id: AGENT, start: true },
        })
      ).json() as { run_id: string; session_id: string };
      await until(() => runner.started.length === 1);

      const response = await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/sessions',
        payload: { session_ids: [ids.session_id], patch: { archived: true } },
      });
      expect(response.statusCode).toBe(200);
      await taskRunsFor(hub.app).settled();

      expect(runner.interrupted).toContain(ids.run_id);
      expect((await runOf(hub, ids.session_id, ids.run_id)).status).toBe('cancelled');
      const after = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
      ).json() as Json;
      expect(after).toMatchObject({ status: 'ready', assignee: { id: AGENT } });
    } finally {
      await hub.close();
    }
  });
});
