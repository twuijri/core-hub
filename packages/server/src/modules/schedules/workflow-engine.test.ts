/**
 * A workflow actually running: steps done by the engine and steps done by an agent, the
 * routes between them, and what a person sees afterwards.
 *
 * Agent turns are a fake port here (the real one — a session run — is exercised by the web
 * journey against the scripted runner). Notices go through the real inbox in the first
 * test, so "the workflow told me" is checked where a person would read it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { registerWorkflowPorts, workflowEngineFor } from './index.js';
import { SchedulesService } from './service.js';
import { eq } from 'drizzle-orm';
import { requireSqlite } from '../../lib/db.js';
import { workflows } from './schema.js';
import type { WorkflowPorts } from './workflow-engine.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;

const AGENT = '01KAGENTXYZ000000000000000';

const step = (id: string, kind: string, input: string | null, extra: Json = {}) => ({
  id,
  kind,
  title: id,
  agent_id: kind === 'agent' ? AGENT : null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input,
  approval_required: false,
  position: { x: 0, y: 0 },
  ...extra,
});
const edge = (from: string, to: string, route = 'success') => ({
  id: `${from}-${to}`,
  from,
  to,
  route,
});

let previous: ReturnType<typeof registerWorkflowPorts> | undefined;
function fakePorts(ports: Partial<WorkflowPorts>) {
  previous = registerWorkflowPorts(() => ({ agentTurn: null, notice: null, ...ports }));
}
afterEach(() => {
  if (previous !== undefined) registerWorkflowPorts(previous);
  previous = undefined;
});

async function workflow(hub: Hub, nodes: unknown[], edges: unknown[]) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: { name: 'flow', nodes, edges },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as Json).id as string;
}

async function run(hub: Hub, id: string, payload: Json = {}) {
  const started = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/workflows/${id}/run`,
    payload,
  });
  expect(started.statusCode).toBe(202);
  await workflowEngineFor(hub.app).settled();
  const runId = (started.json() as Json).workflow_run_id as string;
  const got = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/workflow-runs/${runId}`,
  });
  return got.json() as Json & { steps: Json[] };
}

const stepOf = (result: { steps: Json[] }, id: string) =>
  result.steps.find((s) => s.node_id === id);

describe('workflows: running', () => {
  it('takes the branch a condition chooses, and writes the notice to the inbox', async () => {
    const hub = await signedInHub();
    try {
      const id = await workflow(
        hub,
        [
          step('check', 'condition', 'input == "urgent"'),
          step('loud', 'notify', 'عاجل: {{input}}'),
          step('quiet', 'notify', 'ليس عاجلًا'),
        ],
        [edge('check', 'loud', 'success'), edge('check', 'quiet', 'failure')],
      );
      const result = await run(hub, id, { input: 'urgent' });
      expect(result.status).toBe('succeeded');
      expect(stepOf(result, 'loud')?.status).toBe('succeeded');
      expect(stepOf(result, 'quiet')).toBeUndefined();

      const notices = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/notify/notices',
      });
      const items = (notices.json() as { items: Json[] }).items;
      expect(items.some((n) => n.body === 'عاجل: urgent' && n.kind === 'system')).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it('hands an agent the rendered prompt, and the next step reads what it said', async () => {
    const prompts: string[] = [];
    const notices: string[] = [];
    fakePorts({
      agentTurn: async (_scope, input) => {
        prompts.push(input.prompt);
        return {
          sessionId: 's',
          runId: 'r',
          status: 'succeeded',
          output: 'ثلاث رسائل',
          error: null,
        };
      },
      notice: (_scope, input) => notices.push(input.body ?? ''),
    });
    const hub = await signedInHub();
    try {
      const id = await workflow(
        hub,
        [
          step('ask', 'agent', 'لخّص: {{input}}'),
          step('tell', 'notify', 'الملخّص: {{steps.ask.output}}'),
        ],
        [edge('ask', 'tell')],
      );
      const result = await run(hub, id, { input: 'بريد اليوم' });
      expect(result.status).toBe('succeeded');
      expect(prompts).toEqual(['لخّص: بريد اليوم']);
      expect(notices).toEqual(['الملخّص: ثلاث رسائل']);
    } finally {
      await hub.close();
    }
  });

  it("fails the run with the step's own words when nothing handles the failure", async () => {
    fakePorts({
      agentTurn: async () => ({
        sessionId: 's',
        runId: 'r',
        status: 'failed',
        output: '',
        error: 'provider timed out',
      }),
    });
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [step('ask', 'agent', 'hello')], []);
      const result = await run(hub, id);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('ask: provider timed out');
    } finally {
      await hub.close();
    }
  });

  it('follows a failure edge instead, and the run succeeds', async () => {
    const notices: string[] = [];
    fakePorts({
      agentTurn: async () => ({
        sessionId: 's',
        runId: 'r',
        status: 'failed',
        output: '',
        error: 'no',
      }),
      notice: (_scope, input) => notices.push(input.body ?? ''),
    });
    const hub = await signedInHub();
    try {
      const id = await workflow(
        hub,
        [step('ask', 'agent', 'hello'), step('sorry', 'notify', 'the agent could not answer')],
        [edge('ask', 'sorry', 'failure')],
      );
      const result = await run(hub, id);
      expect(result.status).toBe('succeeded');
      expect(notices).toEqual(['the agent could not answer']);
    } finally {
      await hub.close();
    }
  });

  it('stops a waiting run at once when it is cancelled', async () => {
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [step('wait', 'delay', '600')], []);
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflows/${id}/run`,
        payload: {},
      });
      const runId = (started.json() as Json).workflow_run_id as string;
      const cancelled = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-runs/${runId}/cancel`,
      });
      expect(cancelled.statusCode).toBe(200);
      const t0 = Date.now();
      await workflowEngineFor(hub.app).settled();
      expect(Date.now() - t0).toBeLessThan(2000);
      const got = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
      ).json() as Json & { steps: Json[] };
      expect(got.status).toBe('cancelled');
      expect(stepOf(got, 'wait')?.status).toBe('cancelled');
    } finally {
      await hub.close();
    }
  });

  it('reruns from a node, reusing what the earlier steps said', async () => {
    let calls = 0;
    const notices: string[] = [];
    fakePorts({
      agentTurn: async () => {
        calls += 1;
        return {
          sessionId: 's',
          runId: 'r',
          status: 'succeeded',
          output: 'first answer',
          error: null,
        };
      },
      notice: (_scope, input) => notices.push(input.body ?? ''),
    });
    const hub = await signedInHub();
    try {
      const id = await workflow(
        hub,
        [step('ask', 'agent', 'hi'), step('tell', 'notify', 'said: {{steps.ask.output}}')],
        [edge('ask', 'tell')],
      );
      const first = await run(hub, id);
      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-runs/${first.id as string}/rerun`,
        payload: { from_node_id: 'tell' },
      });
      expect(again.statusCode).toBe(202);
      await workflowEngineFor(hub.app).settled();
      expect(calls).toBe(1);
      expect(notices).toEqual(['said: first answer', 'said: first answer']);
    } finally {
      await hub.close();
    }
  });

  it('fails a step that needs a person when the hub has nobody to ask, saying so', async () => {
    // Ports with no approvals: a hub composed without sessions. (The approval itself, raised,
    // answered and surviving a restart, is `tests/unit/workflow-approvals.test.ts`.)
    fakePorts({});
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [step('gate', 'approval', null)], []);
      const result = await run(hub, id);
      expect(result.status).toBe('failed');
      expect(String(result.error)).toContain('this hub cannot ask anyone for approval');
    } finally {
      await hub.close();
    }
  });

  it('fails the runs a restart cut short, instead of leaving them running', async () => {
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [step('wait', 'delay', '5')], []);
      const db = requireSqlite(hub.app.hub.database);
      const row = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
      const scope = { workspace: row.workspace, profile: 'default', userId: hub.userId };
      const service = new SchedulesService(db);
      // A run row left "running" by a process that is gone.
      const orphan = service.createWorkflowRun(scope, service.workflow(scope, id), {
        input: {},
        triggerKind: 'manual',
      });
      expect(service.failInterruptedRuns()).toBe(1);
      const got = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${orphan.id}` })
      ).json() as Json;
      expect(got).toMatchObject({
        status: 'failed',
        error: 'the hub restarted while this run was going',
      });
    } finally {
      await hub.close();
    }
  });
});

describe('workflows: refused when saved, not at 3 a.m.', () => {
  it('refuses a condition it cannot read', async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          name: 'bad',
          nodes: [step('c', 'condition', 'amount > 1 and b < 2')],
          edges: [],
        },
      });
      expect(created.statusCode).toBe(409);
    } finally {
      await hub.close();
    }
  });

  it('refuses a template that names a step that is not there', async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: { name: 'bad', nodes: [step('n', 'notify', '{{steps.ghost.output}}')], edges: [] },
      });
      expect(created.statusCode).toBe(409);
      expect(JSON.stringify(created.json())).toContain('ghost');
    } finally {
      await hub.close();
    }
  });
});
