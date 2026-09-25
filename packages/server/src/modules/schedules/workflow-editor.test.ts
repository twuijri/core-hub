/**
 * What the web's workflow editor needs from the hub (DECISIONS §52): a check of a drawing
 * nobody saved, whose findings name the node they are about; every profile's workflows on
 * one page; and, in a run, what each step produced and which way it went — so the canvas
 * can show the output and the edges taken. And an agent step's own model reaches its turn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { registerWorkflowPorts, workflowEngineFor } from './index.js';
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

async function validate(hub: Hub, nodes: unknown[], edges: unknown[] = []) {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows/validate',
    payload: { name: 'draft', nodes, edges },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    valid: boolean;
    problems: Array<Json & { code: string }>;
    warnings: Array<Json & { code: string }>;
  };
}

async function createIn(hub: Hub, profile: string, name: string) {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    profile,
    payload: { name, nodes: [step('a', 'notify', 'hi')], edges: [] },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as Json).id as string;
}

describe('workflows: the editor', () => {
  it('checks a drawing without saving it, and each finding names its node', async () => {
    const hub = await signedInHub();
    try {
      const bad = await validate(
        hub,
        [
          step('ask', 'agent', 'اقرأ {{steps.ghost.output}}', { agent_id: null }),
          step('check', 'condition', 'amount is big'),
          step('wait', 'delay', '99999'),
          step('odd', 'notify', '{{secret.key}}'),
        ],
        [edge('ask', 'nowhere')],
      );
      expect(bad.valid).toBe(false);
      const byCode = (code: string) => bad.problems.find((p) => p.code === code);
      expect(byCode('template_step_unknown')).toMatchObject({
        node_id: 'ask',
        detail: 'steps.ghost.output',
      });
      expect(byCode('condition_unreadable')).toMatchObject({
        node_id: 'check',
        detail: 'condition_operator_missing',
      });
      expect(byCode('delay_out_of_range')).toMatchObject({ node_id: 'wait', detail: '3600' });
      expect(byCode('template_root_unknown')).toMatchObject({ node_id: 'odd' });
      expect(byCode('edge_to_unknown')).toMatchObject({ edge_id: 'ask-nowhere', node_id: null });
      // The English words are the ones saving has always refused with.
      expect(byCode('delay_out_of_range')?.message).toBe(
        'the delay of "wait" must be 0 to 3600 seconds',
      );
      expect(bad.warnings.find((w) => w.code === 'agent_missing')).toMatchObject({
        node_id: 'ask',
      });

      const good = await validate(
        hub,
        [step('ask', 'agent', 'hi'), step('tell', 'notify', '{{steps.ask.output}}')],
        [edge('ask', 'tell')],
      );
      expect(good).toEqual({ valid: true, problems: [], warnings: [] });

      // Nothing was written.
      const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/workflows' });
      expect((list.json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('refuses to save what the check calls a problem, in the same words', async () => {
    const hub = await signedInHub();
    try {
      const nodes = [step('wait', 'delay', '-1')];
      const checked = await validate(hub, nodes);
      const saved = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: { name: 'x', nodes, edges: [] },
      });
      expect(saved.statusCode).toBe(409);
      expect((saved.json() as { details: { problems: string[] } }).details.problems).toEqual(
        checked.problems.map((p) => p.message),
      );
    } finally {
      await hub.close();
    }
  });

  it('lists the workflows of every profile with profiles=all, each with its own profile', async () => {
    const hub = await signedInHub();
    try {
      const made = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: 'designer', name: 'Designer' },
      });
      expect(made.statusCode).toBe(201);
      const home = await createIn(hub, 'default', 'home flow');
      const design = await createIn(hub, 'designer', 'design flow');

      const one = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/workflows' });
      expect((one.json() as { items: Json[] }).items.map((w) => w.id)).toEqual([home]);

      const all = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/workflows?profiles=all',
      });
      expect(all.statusCode).toBe(200);
      const items = (all.json() as { items: Json[] }).items;
      // Newest first across profiles.
      expect(items.map((w) => [w.id, w.profile])).toEqual([
        [design, 'designer'],
        [home, 'default'],
      ]);

      // A member sees only the profiles they were given.
      await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/auth/users',
        payload: {
          username: 'mem',
          password: 'mem-password-1',
          role: 'member',
          profiles: ['designer'],
        },
      });
      const login = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'mem', password: 'mem-password-1' },
      });
      const member = (login.json() as { access_token: string }).access_token;
      const theirs = await authed(hub, member, {
        method: 'GET',
        url: '/api/v1/workflows?profiles=all',
        profile: 'designer',
      });
      expect(theirs.statusCode).toBe(200);
      expect((theirs.json() as { items: Json[] }).items.map((w) => w.id)).toEqual([design]);
    } finally {
      await hub.close();
    }
  });

  it("says what each step produced and which way it went, and passes the step's model", async () => {
    const models: Array<string | null | undefined> = [];
    fakePorts({
      agentTurn: async (_scope, input) => {
        models.push(input.model);
        return { sessionId: 's', runId: 'r', status: 'succeeded', output: 'مرتفع', error: null };
      },
      notice: () => undefined,
    });
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          name: 'flow',
          nodes: [
            step('ask', 'agent', 'قيّم', { model: 'openrouter/some-model' }),
            step('check', 'condition', 'steps.ask.output == "منخفض"'),
            step('yes', 'notify', 'منخفض'),
            step('no', 'notify', 'قيل: {{steps.ask.output}}'),
          ],
          edges: [edge('ask', 'check'), edge('check', 'yes'), edge('check', 'no', 'failure')],
        },
      });
      const id = (created.json() as Json).id as string;
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflows/${id}/run`,
        payload: {},
      });
      await workflowEngineFor(hub.app).settled();
      const runId = (started.json() as Json).workflow_run_id as string;
      const run = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
      ).json() as { status: string; steps: Json[] };

      expect(run.status).toBe('succeeded');
      expect(models).toEqual(['openrouter/some-model']);
      const of = (node: string) => run.steps.find((s) => s.node_id === node);
      expect(of('ask')).toMatchObject({ output: 'مرتفع', route: 'success' });
      // A condition's "no" is a success that follows the failure edges.
      expect(of('check')).toMatchObject({ status: 'succeeded', output: 'false', route: 'failure' });
      expect(of('no')).toMatchObject({ output: 'قيل: مرتفع', route: 'success' });
      expect(of('yes')).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it('a failed step says so in its route, with no output', async () => {
    fakePorts({ notice: null });
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          name: 'flow',
          nodes: [step('tell', 'notify', 'hi'), step('after', 'notify', 'x')],
          edges: [edge('tell', 'after', 'failure')],
        },
      });
      const id = (created.json() as Json).id as string;
      const started = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflows/${id}/run`,
        payload: {},
      });
      await workflowEngineFor(hub.app).settled();
      const runId = (started.json() as Json).workflow_run_id as string;
      const run = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
      ).json() as { steps: Json[] };
      expect(run.steps.find((s) => s.node_id === 'tell')).toMatchObject({
        status: 'failed',
        output: null,
        route: 'failure',
      });
    } finally {
      await hub.close();
    }
  });
});
