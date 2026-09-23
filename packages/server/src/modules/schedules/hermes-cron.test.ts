/**
 * Hermes's cron on the Schedules page, through the routes a person uses.
 *
 * The Hermes here is a small in-memory `/api/jobs` behind a `fetch`, so the real client
 * (`hermes-jobs.ts`) is exercised too. It answers the way Hermes's API server does
 * (`gateway/platforms/api_server.py`): `{jobs}` / `{job}`, `{error}` with a status on
 * refusal, 404 for a job it does not know.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { createHermesJobs } from './hermes-jobs.js';
import { FakeHermesApi } from './testing/fake-hermes-api.js';
import { registerHermesCron } from './index.js';

type Json = Record<string, unknown>;

const HERMES_AGENT = '01KHERMESAGENT000000000000';
let hermes: FakeHermesApi;
let previous: ReturnType<typeof registerHermesCron> = null;

beforeEach(() => {
  hermes = new FakeHermesApi();
  previous = registerHermesCron(() => ({
    jobs: () =>
      createHermesJobs({
        baseUrl: 'http://hermes.test:8642',
        apiKey: () => 'k',
        fetch: hermes.fetch,
      }),
    agentId: () => HERMES_AGENT,
    timezone: () => 'Asia/Riyadh',
    throttleMs: 0,
  }));
});
afterEach(() => {
  registerHermesCron(previous);
});

async function list(hub: Awaited<ReturnType<typeof signedInHub>>) {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/schedules' });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Json[] }).items;
}

const forHermes = (extra: Json = {}) => ({
  name: 'Morning inbox',
  trigger: { kind: 'interval', expression: null, every_minutes: 45, run_at: null, timezone: 'UTC' },
  target: {
    kind: 'agent_prompt',
    agent_id: HERMES_AGENT,
    prompt: 'Summarise my inbox and send it to me on Telegram',
    model: null,
    provider: null,
    skills: [],
    workflow_id: null,
    input: null,
  },
  delivery: { kind: 'none', room_id: null, channel: null, address: null },
  ...extra,
});

describe("schedules: Hermes's cron reflected", () => {
  it('shows jobs Hermes made itself, with what Hermes says about them', async () => {
    hermes.add({
      name: 'Daily brief',
      schedule: { kind: 'cron', expr: '0 7 * * *' },
      last_run_at: '2026-09-23T07:00:05+03:00',
      last_status: 'ok',
      deliver: 'telegram:12345',
    });
    const hub = await signedInHub();
    try {
      const [item] = await list(hub);
      expect(item).toMatchObject({
        name: 'Daily brief',
        trigger: { kind: 'cron', expression: '0 7 * * *', timezone: 'Asia/Riyadh' },
        target: { agent_id: HERMES_AGENT, prompt: 'check the inbox' },
        delivery: { kind: 'channel', channel: 'telegram', address: '12345' },
        state: 'scheduled',
        next_run_at: '2026-10-01T09:30:00.000Z',
        last_status: 'succeeded',
        external: { source: 'hermes', id: '000000000001' },
      });
      // The run Hermes reported is in the history.
      const runs = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/schedules/${item!.id as string}/runs`,
      });
      expect((runs.json() as { items: Json[] }).items).toMatchObject([{ status: 'succeeded' }]);
    } finally {
      await hub.close();
    }
  });

  it('lets Hermes win, and drops a job Hermes no longer lists', async () => {
    const job = hermes.add({ name: 'Before' });
    const hub = await signedInHub();
    try {
      await list(hub);
      job.name = 'After, renamed in Hermes';
      job.enabled = false;
      job.state = 'paused';
      expect(await list(hub)).toMatchObject([
        { name: 'After, renamed in Hermes', enabled: false, state: 'paused' },
      ]);
      hermes.jobs.delete(job.id);
      expect(await list(hub)).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('creates a schedule for Hermes in Hermes, which is what fires it', async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: forHermes(),
      });
      expect(created.statusCode).toBe(201);
      const schedule = created.json() as Json;
      const external = schedule.external as Json;
      expect(external.source).toBe('hermes');
      const job = hermes.jobs.get(external.id as string)!;
      expect(job.schedule).toEqual({ kind: 'interval', minutes: 45 });
      expect(job.prompt).toBe('Summarise my inbox and send it to me on Telegram');
      expect(job.deliver).toBe('local');
      // Listing finds the same job, not a second reflection of it.
      expect(await list(hub)).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it("makes nothing when Hermes refuses, and says so in Hermes's words", async () => {
    hermes.refuse = 'Prompt must be ≤ 5000 characters';
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: forHermes(),
      });
      expect(created.statusCode).toBe(409);
      expect((created.json() as Json).details).toMatchObject({
        reason: 'hermes_refused',
        message: 'Prompt must be ≤ 5000 characters',
      });
      hermes.refuse = null;
      expect(await list(hub)).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('says plainly when Hermes is not answering', async () => {
    hermes.down = true;
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: forHermes(),
      });
      expect(created.statusCode).toBe(422);
      expect((created.json() as Json).details).toMatchObject({ reason: 'hermes_unreachable' });
      // And the list still answers, with whatever it had.
      expect(await list(hub)).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("refuses a cron in another zone than Hermes's, naming Hermes's", async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: forHermes({
          trigger: {
            kind: 'cron',
            expression: '0 9 * * *',
            every_minutes: null,
            run_at: null,
            timezone: 'Europe/London',
          },
        }),
      });
      expect(created.statusCode).toBe(409);
      expect((created.json() as Json).details).toMatchObject({
        reason: 'hermes_timezone',
        timezone: 'Asia/Riyadh',
      });
      expect(hermes.jobs.size).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it('edits, pauses and deletes on Hermes first', async () => {
    const job = hermes.add({ name: 'Weekly' });
    const hub = await signedInHub();
    try {
      const [item] = await list(hub);
      const id = item!.id as string;
      const renamed = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/schedules/${id}`,
        payload: { name: 'Weekly review', enabled: false },
      });
      expect(renamed.statusCode).toBe(200);
      expect(job.name).toBe('Weekly review');
      expect(job.state).toBe('paused');
      expect((renamed.json() as Json).state).toBe('paused');

      const deleted = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/schedules/${id}`,
      });
      expect(deleted.statusCode).toBe(204);
      expect(hermes.jobs.size).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it('an edit Hermes refuses changes nothing on either side', async () => {
    const job = hermes.add({ name: 'Keep me' });
    const hub = await signedInHub();
    try {
      const id = (await list(hub))[0]!.id as string;
      hermes.refuse = "Invalid schedule 'every banana'.";
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/schedules/${id}`,
        payload: { name: 'Renamed' },
      });
      expect(edited.statusCode).toBe(409);
      hermes.refuse = null;
      expect(job.name).toBe('Keep me');
      expect((await list(hub))[0]!.name).toBe('Keep me');
    } finally {
      await hub.close();
    }
  });

  it('fires a Hermes schedule now, and the run settles when Hermes reports it', async () => {
    const job = hermes.add({ name: 'Now please' });
    const hub = await signedInHub();
    try {
      const id = (await list(hub))[0]!.id as string;
      const fired = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/schedules/${id}/run`,
      });
      expect(fired.statusCode).toBe(202);
      const runId = (fired.json() as Json).schedule_run_id as string;
      expect(hermes.calls).toContain(`POST /api/jobs/${job.id}/run`);

      const queued = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/schedules/${id}/runs/${runId}`,
      });
      expect((queued.json() as Json).status).toBe('queued');

      job.last_run_at = new Date(Date.now() + 1000).toISOString();
      job.last_status = 'error';
      job.last_error = 'provider timed out';
      await list(hub);
      const settled = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/schedules/${id}/runs/${runId}`,
      });
      expect(settled.json()).toMatchObject({ status: 'failed', error: 'provider timed out' });
    } finally {
      await hub.close();
    }
  });

  it("leaves the hub's own schedules as they were", async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: forHermes({
          target: { ...forHermes().target, agent_id: '01KAGENTXYZ000000000000000' },
        }),
      });
      expect(created.statusCode).toBe(201);
      expect((created.json() as Json).external).toBeNull();
      const fired = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/schedules/${(created.json() as Json).id as string}/run`,
      });
      expect(fired.statusCode).toBe(501);
      expect(hermes.calls.filter((call) => !call.startsWith('GET'))).toEqual([]);
    } finally {
      await hub.close();
    }
  });
});
