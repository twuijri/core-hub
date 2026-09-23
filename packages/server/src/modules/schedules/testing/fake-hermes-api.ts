/**
 * A Hermes `/api/jobs` in memory, behind a `fetch`.
 *
 * It answers the way Hermes's API server does (`gateway/platforms/api_server.py` in
 * Hermes's MIT source): `{jobs}` and `{job}`, `{error}` with a status when it refuses, 404
 * for a job it does not know, 500 for a terminal job asked to run. The schedule grammar is
 * the three forms the hub sends (`hermesScheduleOf`), not all of Hermes's; the real parser
 * is checked in `hermes-jobs.real.test.ts`.
 *
 * Used by the unit tests and by the e2e hub, so both drive the real client.
 */
import type { HermesJob } from '../hermes-jobs.js';

type Json = Record<string, unknown>;

export class FakeHermesApi {
  jobs = new Map<string, HermesJob>();
  calls: string[] = [];
  refuse: string | null = null;
  down = false;
  private counter = 0;

  add(partial: Partial<HermesJob> & { name: string }): HermesJob {
    this.counter += 1;
    const job: HermesJob = {
      id: this.counter.toString(16).padStart(12, '0'),
      prompt: 'check the inbox',
      skills: [],
      schedule: { kind: 'interval', minutes: 30, display: 'every 30m' },
      repeat: { times: null, completed: 0 },
      enabled: true,
      state: 'scheduled',
      next_run_at: '2026-10-01T09:30:00+00:00',
      last_run_at: null,
      last_status: null,
      last_error: null,
      deliver: 'local',
      ...partial,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private parse(schedule: string): HermesJob['schedule'] {
    const every = /^every (\d+)m$/.exec(schedule);
    if (every) return { kind: 'interval', minutes: Number(every[1]) };
    if (/^\d{4}-\d{2}-\d{2}T/.test(schedule)) return { kind: 'once', run_at: schedule };
    if (schedule.split(' ').length === 5) return { kind: 'cron', expr: schedule };
    throw new Error(`Invalid schedule '${schedule}'.`);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    if (this.down) throw new TypeError('fetch failed');
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    if (this.refuse && method !== 'GET') return json(400, { error: this.refuse });
    const match = /^\/api\/jobs(?:\/([a-f0-9]{12}))?(?:\/(pause|resume|run))?$/.exec(url.pathname);
    if (!match) return json(404, { error: 'not found' });
    const [, id, action] = match;
    if (!id) {
      if (method === 'GET') return json(200, { jobs: [...this.jobs.values()] });
      try {
        const schedule = this.parse(String(body.schedule));
        const job = this.add({
          name: String(body.name),
          prompt: String(body.prompt ?? ''),
          schedule,
          // Hermes computes the next time itself; the fake does the two it can do exactly.
          next_run_at: body.paused
            ? null
            : schedule.kind === 'interval'
              ? new Date(Date.now() + Number(schedule.minutes) * 60_000).toISOString()
              : schedule.kind === 'once'
                ? (schedule.run_at ?? null)
                : '2026-10-01T09:30:00+00:00',
          skills: (body.skills as string[] | undefined) ?? [],
          deliver: String(body.deliver ?? 'local'),
          enabled: !body.paused,
          state: body.paused ? 'paused' : 'scheduled',
        });
        return json(200, { job });
      } catch (error) {
        return json(400, { error: (error as Error).message });
      }
    }
    const job = this.jobs.get(id);
    if (!job) return json(404, { error: 'Job not found' });
    if (method === 'DELETE') {
      this.jobs.delete(id);
      return json(200, { ok: true });
    }
    if (action === 'pause')
      Object.assign(job, { enabled: false, state: 'paused', next_run_at: null });
    if (action === 'resume') Object.assign(job, { enabled: true, state: 'scheduled' });
    if (action === 'run') {
      if (job.state === 'completed') {
        return json(500, { error: `Cannot run: job '${job.name}' is completed (terminal).` });
      }
      job.next_run_at = new Date().toISOString();
    }
    if (method === 'PATCH') {
      if (body.schedule) job.schedule = this.parse(String(body.schedule));
      for (const key of ['name', 'prompt', 'skills', 'deliver'] as const) {
        if (body[key] !== undefined) (job as unknown as Json)[key] = body[key];
      }
    }
    return json(200, { job });
  };
}
