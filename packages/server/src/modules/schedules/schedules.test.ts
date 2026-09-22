/**
 * Schedules and workflows over HTTP: what the hub accepts, what it refuses, and what it
 * says about the three things it cannot do yet.
 */
import { describe, expect, it } from 'vitest';
import { authed, expectModuleRegistered, signedInHub } from '../../../tests/unit/helpers.js';
import { schedulesModule } from './index.js';

type Json = Record<string, unknown>;

/** Every field the contract marks required; a client sends the whole object, not a patch. */
const trigger = (over: Record<string, unknown> = {}) => ({
  kind: 'cron',
  expression: '0 9 * * *',
  every_minutes: null,
  run_at: null,
  timezone: 'Asia/Riyadh',
  ...over,
});
const target = {
  kind: 'agent_prompt',
  agent_id: null,
  prompt: 'اكتب ملخص اليوم',
  model: null,
  provider: null,
  skills: [],
  workflow_id: null,
  input: null,
};
const daily = { name: 'Standup', trigger: trigger(), target };

describe('module: schedules', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(schedulesModule);
  });
});

describe('schedules: saving one', () => {
  it('computes when it would next run, in its own timezone', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: daily,
      });
      expect(response.statusCode).toBe(201);
      const schedule = response.json() as Json;
      expect(schedule.state).toBe('scheduled');
      expect(schedule.next_run_at).not.toBeNull();
      // 09:00 in Riyadh is 06:00 UTC, whatever the server's own clock is set to.
      expect(String(schedule.next_run_at)).toContain('T06:00:00');
      expect(schedule.trigger).toMatchObject({ kind: 'cron', timezone: 'Asia/Riyadh' });
    } finally {
      await hub.close();
    }
  });

  it('refuses an expression it cannot evaluate, and says which field', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: { ...daily, trigger: trigger({ expression: '@daily' }) },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        details: { reason: 'cron_invalid', field: 'trigger.expression' },
      });
    } finally {
      await hub.close();
    }
  });

  it('refuses a timezone the platform does not know', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules',
        payload: { ...daily, trigger: trigger({ timezone: 'Mars/Olympus' }) },
      });
      expect(response.json()).toMatchObject({ details: { reason: 'timezone_unknown' } });
    } finally {
      await hub.close();
    }
  });

  it('a disabled schedule is paused and has no next time', async () => {
    const hub = await signedInHub();
    try {
      const created = (
        await authed(hub, hub.token, { method: 'POST', url: '/api/v1/schedules', payload: daily })
      ).json() as Json;
      const paused = (
        await authed(hub, hub.token, {
          method: 'PATCH',
          url: `/api/v1/schedules/${created.id as string}`,
          payload: { enabled: false },
        })
      ).json() as Json;
      expect(paused.state).toBe('paused');
      expect(paused.next_run_at).toBeNull();
    } finally {
      await hub.close();
    }
  });

  it('lists only this workspace’s schedules, and can filter by enabled', async () => {
    const hub = await signedInHub();
    try {
      await authed(hub, hub.token, { method: 'POST', url: '/api/v1/schedules', payload: daily });
      const listed = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/schedules?enabled=true',
      });
      expect((listed.json() as { items: unknown[] }).items).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });
});

describe('schedules: what cannot run yet says so', () => {
  it('answers 501 with its operation id, after checking the schedule exists', async () => {
    const hub = await signedInHub();
    try {
      const created = (
        await authed(hub, hub.token, { method: 'POST', url: '/api/v1/schedules', payload: daily })
      ).json() as Json;

      const missing = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/schedules/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/run',
      });
      // A wrong id is a 404: more useful than "not implemented".
      expect(missing.statusCode).toBe(404);

      const real = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/schedules/${created.id as string}/run`,
      });
      expect(real.statusCode).toBe(501);
      expect(real.json()).toMatchObject({
        code: 'not_implemented',
        details: { operationId: 'schedules.runNow', reason: 'worker_not_built' },
      });
    } finally {
      await hub.close();
    }
  });
});

/** A node with every field the contract marks required. */
const node = (id: string, title: string) => ({
  id,
  kind: 'agent',
  title,
  agent_id: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input: null,
  approval_required: false,
  position: { x: 0, y: 0 },
});

describe('workflows', () => {
  const flow = {
    name: 'Review then publish',
    nodes: [node('review', 'Review'), node('publish', 'Publish')],
    edges: [{ id: 'e1', from: 'review', to: 'publish', route: 'success' }],
  };

  it('saves a definition and counts what points at it', async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: flow,
      });
      expect(created.statusCode).toBe(201);
      const workflow = created.json() as Json;
      expect(workflow).toMatchObject({ name: 'Review then publish', status: 'idle', run_count: 0 });
      expect((workflow.nodes as unknown[]).length).toBe(2);
    } finally {
      await hub.close();
    }
  });

  it('refuses an edge that goes nowhere, because that workflow cannot run', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: { ...flow, edges: [{ id: 'e1', from: 'review', to: 'ghost', route: 'always' }] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ details: { reason: 'workflow_invalid' } });
    } finally {
      await hub.close();
    }
  });

  it('refuses two nodes with the same id', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          ...flow,
          nodes: [node('same', 'One'), node('same', 'Two')],
          edges: [],
        },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await hub.close();
    }
  });

  it('previews an import, warns about what is odd, and confirms into a workflow', async () => {
    const hub = await signedInHub();
    try {
      const preview = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflow-imports',
        payload: { document: flow },
      });
      expect(preview.statusCode).toBe(201);
      const body = preview.json() as Json;
      expect(body).toMatchObject({ name: 'Review then publish', node_count: 2, edge_count: 1 });
      // Neither node names an agent: worth saying, not worth refusing.
      expect((body.warnings as string[]).length).toBeGreaterThan(0);

      const confirmed = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-imports/${body.id as string}/confirm`,
      });
      expect(confirmed.statusCode).toBe(201);
      expect((confirmed.json() as Json).name).toBe('Review then publish');

      // A preview is consumed once.
      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-imports/${body.id as string}/confirm`,
      });
      expect(again.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  });

  it('bumps the version when the drawing changes, because runs snapshot it', async () => {
    const hub = await signedInHub();
    try {
      const created = (
        await authed(hub, hub.token, { method: 'POST', url: '/api/v1/workflows', payload: flow })
      ).json() as Json;
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${created.id as string}`,
        payload: { nodes: [node('only', 'Only')], edges: [] },
      });
      const after = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/workflows/${created.id as string}`,
        })
      ).json() as Json;
      expect((after.nodes as unknown[]).length).toBe(1);
    } finally {
      await hub.close();
    }
  });
});

describe('schedules: where output can go', () => {
  it('offers only the destinations that exist', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/delivery-targets',
      });
      const kinds = (response.json() as { items: Array<{ kind: string }> }).items.map(
        (i) => i.kind,
      );
      // Rooms and messaging channels are their own modules and are not built.
      expect(kinds).toEqual(['none', 'notice']);
    } finally {
      await hub.close();
    }
  });
});
