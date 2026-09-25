// The live Performance and Logs endpoints over HTTP: owners and admins only, the filters as
// the contract words them, and the processes the composition root names measured by pid.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerLiveSources } from '../../src/modules/audit/index.js';
import { authed, signedInHub } from './helpers.js';

let hub: Awaited<ReturnType<typeof signedInHub>>;
let memberToken: string;

beforeAll(async () => {
  hub = await signedInHub();
  const password = 'member-password-1';
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/auth/users',
    payload: { username: 'mona', password, role: 'member', profiles: ['default'] },
  });
  expect(created.statusCode).toBe(201);
  const login = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'mona', password },
  });
  memberToken = (login.json() as { access_token: string }).access_token;
});
afterAll(async () => {
  await hub.close();
});

const PERFORMANCE = '/api/v1/audit/performance/live';
const LINES = '/api/v1/audit/logs/lines';

describe('who may look', () => {
  it.each([PERFORMANCE, LINES])('%s: nobody signed out, no member, the owner yes', async (url) => {
    const anonymous = await hub.app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);
    const member = await authed(hub, memberToken, { method: 'GET', url });
    expect(member.statusCode).toBe(403);
    const owner = await authed(hub, hub.token, { method: 'GET', url });
    expect(owner.statusCode).toBe(200);
  });
});

describe('GET /audit/performance/live', () => {
  it('measures the host, the hub, each profile, and each Hermes process by its pid', async () => {
    // A look within two seconds of the last shares its sample; wait for a fresh one.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    // This test process stands in for a Hermes gateway: a pid /proc can read on Linux.
    const previous = registerLiveSources(() => ({
      hermesProcesses: () => [
        { kind: 'gateway', profile: 'default', pid: process.pid, state: 'running' },
      ],
      profileActivity: () => [{ profile: 'default', active_runs: 0, sessions: 0 }],
    }));
    try {
      const res = await authed(hub, hub.token, { method: 'GET', url: PERFORMANCE });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        interval_seconds: number;
        host: { measured_from: string; memory_total_bytes: number; cpu_percent: number | null };
        hub: { pid: number; rss_bytes: number };
        processes: Array<{ pid: number; rss_bytes: number | null; uptime_seconds: number | null }>;
        profiles: Array<{ profile: string; sockets: number }>;
        history: unknown[];
      };
      expect(body.interval_seconds).toBe(5);
      expect(body.hub.pid).toBe(process.pid);
      expect(body.hub.rss_bytes).toBeGreaterThan(0);
      expect(body.host.memory_total_bytes).toBeGreaterThan(0);
      expect(body.history.length).toBeGreaterThanOrEqual(1);
      expect(body.profiles).toEqual([
        { profile: 'default', active_runs: 0, sessions: 0, sockets: 0 },
      ]);
      expect(body.processes).toHaveLength(1);
      if (process.platform === 'linux') {
        expect(body.host.measured_from).toBe('proc');
        expect(body.processes[0]!.rss_bytes).toBeGreaterThan(0);
        expect(body.processes[0]!.uptime_seconds).toBeGreaterThanOrEqual(0);
      } else {
        expect(body.processes[0]!.rss_bytes).toBeNull();
      }
    } finally {
      registerLiveSources(previous);
    }
  });

  it('lists every profile from the real composition, the quiet ones as zeros', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const res = await authed(hub, hub.token, { method: 'GET', url: PERFORMANCE });
    const body = res.json() as { processes: unknown[]; profiles: Array<{ profile: string }> };
    // The test hub runs no Hermes: nothing to list, rather than a made-up row.
    expect(body.processes).toEqual([]);
    expect(body.profiles.map((row) => row.profile)).toContain('default');
  });
});

describe('GET /audit/logs/lines', () => {
  const lines = async (query: string) => {
    const res = await authed(hub, hub.token, { method: 'GET', url: `${LINES}?${query}` });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  it('filters by source, profile, least level and text, and tails after a seq', async () => {
    const ring = hub.app.hub.logs;
    const start = ring.query({}).last_seq;
    ring.push({ level: 'info', source: 'hub', message: 'perf-logs: hub line' });
    ring.push({
      level: 'warn',
      source: 'hermes',
      profile: 'work',
      message: 'perf-logs: work warn',
    });
    ring.push({
      level: 'error',
      source: 'hermes',
      profile: 'home',
      message: 'perf-logs: home error',
    });

    const messages = (body: Record<string, unknown>) =>
      (body.lines as Array<{ message: string }>).map((line) => line.message);

    const work = await lines(`source=hermes&profile=work&after=${start}`);
    expect(work.status).toBe(200);
    expect(messages(work.body)).toEqual(['perf-logs: work warn']);

    const errors = await lines(`source=errors&after=${start}`);
    expect(messages(errors.body)).toEqual(['perf-logs: home error']);

    const warnUp = await lines(`level=warn&q=PERF-LOGS&after=${start}`);
    expect(messages(warnUp.body)).toEqual(['perf-logs: work warn', 'perf-logs: home error']);

    const newest = await lines(`limit=1&q=perf-logs`);
    expect(messages(newest.body)).toEqual(['perf-logs: home error']);

    const tail = await lines(`after=${String(newest.body.last_seq)}&q=perf-logs`);
    expect(messages(tail.body)).toEqual([]);

    const sources = (work.body.sources as Array<{ source: string; profile: string | null }>).map(
      (source) => `${source.source}:${source.profile ?? ''}`,
    );
    expect(sources).toEqual(expect.arrayContaining(['hermes:home', 'hermes:work']));
  });

  it('refuses a limit past what a ring keeps', async () => {
    expect((await lines('limit=5001')).status).toBe(400);
    expect((await lines('source=everything')).status).toBe(400);
  });
});
