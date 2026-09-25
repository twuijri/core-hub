import { describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import {
  authed,
  drainJobs,
  expectModuleRegistered,
  fakeInstaller,
  signedInHub,
} from '../../../tests/unit/helpers.js';
import { REALTIME_NAMESPACES, SOCKET_PATH } from '../../lib/module.js';
import { auditModule } from './index.js';
import { serializeJob } from './service.js';

const row = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0JB',
  ownerId: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  workspace: '01J8QK3ZR2W7M5N4P6T8V9X0PF',
  kind: 'agents.install',
  status: 'running' as const,
  progress: 40,
  progressMessage: 'downloading',
  entityKind: 'agent',
  entityId: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
  input: {},
  result: null,
  errorCode: null,
  errorMessage: null,
  attempts: 1,
  parentJobId: null,
  startedAt: new Date(1000),
  finishedAt: null,
  cancelRequestedAt: null,
  heartbeatAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(1000),
};

describe('module: audit', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(auditModule);
  });
});

describe('audit: the job a client reads', () => {
  it('sends the contract vocabulary, not the table’s', () => {
    const job = serializeJob(row, 'work');
    expect(job).toMatchObject({
      profile: 'work',
      // `<module>.<verb>` in the column, the verb on the wire.
      kind: 'install',
      status: 'running',
      progress: { percent: 40, message: 'downloading' },
      resource: { kind: 'agent', id: row.entityId },
      error: null,
    });
  });

  it('reports the internal `cancelling` state as `running`', () => {
    expect(serializeJob({ ...row, status: 'cancelling' }, 'work')).toMatchObject({
      status: 'running',
    });
  });

  it('reports "no measurable progress" as null, not as -1', () => {
    expect(serializeJob({ ...row, progress: -1 }, 'work')).toMatchObject({
      progress: { percent: null },
    });
  });

  it('carries the error envelope of a failed job', () => {
    const job = serializeJob(
      { ...row, status: 'failed', errorCode: 'internal', errorMessage: 'npm ERR! 404' },
      'work',
    );
    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'internal', error: 'npm ERR! 404' },
    });
  });
});

describe('audit: the jobs kernel over HTTP', () => {
  it('lists, reads and refuses to cancel a job that already finished', async () => {
    const hub = await signedInHub({}, { agents: { installer: fakeInstaller() } });
    try {
      const agents = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const codex = agents.find((agent) => agent.slug === 'codex')!;

      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${codex.id}/install`,
      });
      const jobId = (accepted.json() as { job_id: string }).job_id;
      await drainJobs(hub.app);

      const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/jobs' });
      expect(listed.statusCode).toBe(200);
      const items = (listed.json() as { items: { id: string; kind: string }[] }).items;
      expect(items.map((job) => job.id)).toContain(jobId);
      expect(items[0]).toMatchObject({ kind: 'install', profile: 'default' });

      const filtered = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/jobs?kind=install&status=succeeded',
      });
      expect((filtered.json() as { items: unknown[] }).items).toHaveLength(1);

      const cancelled = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/jobs/${jobId}/cancel`,
      });
      expect(cancelled.statusCode).toBe(409);
      expect(cancelled.json()).toMatchObject({ code: 'conflict' });
    } finally {
      await hub.close();
    }
  });

  it('answers 404 for a job of another workspace or an unknown id', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/jobs/01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found', details: { resource: 'job' } });
    } finally {
      await hub.close();
    }
  });

  it('needs a token', async () => {
    const hub = await signedInHub();
    try {
      const response = await hub.app.inject({ method: 'GET', url: '/api/v1/jobs' });
      expect(response.statusCode).toBe(401);
    } finally {
      await hub.close();
    }
  });
});

describe('audit: /rt/jobs', () => {
  it('streams a job from queued to completed, and the agent that changed', async () => {
    const hub = await signedInHub({}, { agents: { installer: fakeInstaller() } });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl =
      typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    let socket: Socket | undefined;
    try {
      socket = connect(`${baseUrl}${REALTIME_NAMESPACES.jobs}`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        auth: { token: hub.token, profile: 'default' },
      });
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', () => resolve());
        socket!.once('connect_error', reject);
      });

      const seen: { event: string; envelope: Record<string, unknown> }[] = [];
      for (const event of [
        'job.queued',
        'job.started',
        'job.progress',
        'job.completed',
        'agent.updated',
      ]) {
        socket.on(event, (envelope: Record<string, unknown>) => seen.push({ event, envelope }));
      }

      const agents = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const codex = agents.find((agent) => agent.slug === 'codex')!;
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${codex.id}/install`,
      });
      await drainJobs(hub.app);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const names = seen.map((item) => item.event);
      expect(names).toContain('job.queued');
      expect(names).toContain('job.completed');
      expect(names).toContain('agent.updated');
      // Order matters to a client that renders a progress row.
      expect(names.indexOf('job.queued')).toBeLessThan(names.indexOf('job.completed'));

      const completed = seen.find((item) => item.event === 'job.completed')!.envelope;
      expect(completed).toMatchObject({
        event: 'job.completed',
        namespace: '/rt/jobs',
        profile: 'default',
        payload: { job: { kind: 'install', status: 'succeeded' } },
      });
      expect(typeof completed.seq).toBe('number');
      expect(completed.ts).toMatch(/Z$/);
    } finally {
      socket?.disconnect();
      await hub.close();
    }
  });
});

describe('audit: the report route', () => {
  it('answers the usage report for the workspace the header names', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/audit/reports/usage?days=7',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        kind: string;
        period: { from: string; to: string };
        data: Record<string, unknown>;
      };
      expect(body.kind).toBe('usage');
      expect(body.period.from < body.period.to).toBe(true);
      // A hub that has run nothing reports zeros, not an absence.
      expect(body.data.totals).toMatchObject({ input_tokens: 0, runs: 0 });
    } finally {
      await hub.close();
    }
  });

  it('falls back to the caller’s own workspace when no header names one', async () => {
    // `X-Hub-Profile` is optional on this operation, and the hub resolves the caller's
    // default workspace when it is absent — so a usage report is still one workspace's
    // own, never every workspace added together.
    const hub = await signedInHub();
    try {
      const response = await hub.app.inject({
        method: 'GET',
        url: '/api/v1/audit/reports/usage',
        headers: { authorization: `Bearer ${hub.token}` },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { kind: string }).kind).toBe('usage');
    } finally {
      await hub.close();
    }
  });

  it('gives the hub-wide reports without a workspace at all', async () => {
    const hub = await signedInHub();
    try {
      for (const kind of ['logs', 'performance']) {
        const response = await hub.app.inject({
          method: 'GET',
          url: `/api/v1/audit/reports/${kind}`,
          headers: { authorization: `Bearer ${hub.token}` },
        });
        expect(response.statusCode, kind).toBe(200);
      }
    } finally {
      await hub.close();
    }
  });

  it('answers the skills report now that skill use is recorded (decision §50)', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/audit/reports/skills?days=7',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { kind: string; data: Record<string, unknown> };
      expect(body.kind).toBe('skills');
      expect(body.data.totals).toMatchObject({ uses: 0, distinct_skills: 0, top_skill: null });
      expect(body.data.by_day).toHaveLength(7);
      expect(typeof body.data.counting_since).toBe('string');
    } finally {
      await hub.close();
    }
  });
});
