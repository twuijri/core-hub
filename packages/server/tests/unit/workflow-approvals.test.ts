/**
 * A workflow step that waits for a person — across three modules: `schedules` pauses the
 * run, `sessions` owns the approval (listed with every other one, answered by the same
 * `respondApproval`), `notify` puts it in the inbox. The composition root joins them.
 *
 * What a person sees: the run waits, the approval is in `/approvals` and in the inbox,
 * approving continues the run from that step, denying fails the step with the reason given,
 * and none of it is lost when the hub restarts in between.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workflowEngineFor } from '../../src/modules/schedules/index.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;

const node = (id: string, kind: string, input: string | null, extra: Json = {}) => ({
  id,
  kind,
  title: id,
  agent_id: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input,
  approval_required: false,
  position: { x: 0, y: 0 },
  ...extra,
});
const edge = (from: string, to: string, route = 'success') => ({ id: `${from}-${to}`, from, to, route });

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function workflow(hub: Hub, nodes: unknown[], edges: unknown[]) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: { name: 'نشر الإصدار', nodes, edges },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as Json).id as string;
}

async function start(hub: Hub, id: string) {
  const started = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/workflows/${id}/run`,
    payload: { input: 'v2.4' },
  });
  expect(started.statusCode).toBe(202);
  await workflowEngineFor(hub.app).settled();
  return (started.json() as Json).workflow_run_id as string;
}

async function getRun(hub: Hub, runId: string) {
  await workflowEngineFor(hub.app).settled();
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
  ).json() as Json & { steps: Json[] };
}

async function pending(hub: Hub) {
  const got = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/approvals' });
  expect(got.statusCode).toBe(200);
  return (got.json() as { items: Json[] }).items;
}

const respond = (hub: Hub, id: string, payload: Json) =>
  authed(hub, hub.token, { method: 'POST', url: `/api/v1/approvals/${id}/respond`, payload });

const stepOf = (run: { steps: Json[] }, id: string) => run.steps.find((s) => s.node_id === id);

/** A gate between two notices: "ready", then a person's yes, then "published". */
const gated = [
  node('ready', 'notify', 'جاهز {{input}}'),
  node('gate', 'approval', 'انشر {{input}}؟'),
  node('publish', 'notify', 'نُشر {{input}}'),
];
const line = [edge('ready', 'gate'), edge('gate', 'publish')];

describe('workflows: an approval step', () => {
  it('pauses the run and raises an approval, in /approvals and in the inbox', async () => {
    const hub = await signedInHub();
    try {
      const runId = await start(hub, await workflow(hub, gated, line));
      const run = await getRun(hub, runId);
      expect(run.status).toBe('waiting');
      expect(stepOf(run, 'ready')).toMatchObject({ status: 'succeeded' });
      const gate = stepOf(run, 'gate')!;
      expect(gate).toMatchObject({ status: 'waiting_approval' });
      expect(gate.approval_id).toMatch(/^[0-9A-Z]{26}$/);
      expect(stepOf(run, 'publish')).toBeUndefined();

      const [approval] = await pending(hub);
      expect(approval).toMatchObject({
        id: gate.approval_id,
        kind: 'workflow_step',
        status: 'pending',
        workflow_run_id: runId,
        node_id: 'gate',
        session_id: null,
        run_id: null,
        title: 'gate',
        description: 'انشر v2.4؟',
        agent: { name: 'نشر الإصدار' },
      });

      const notices = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/notices' })
      ).json() as { items: Json[] };
      const notice = notices.items.find((item) => item.kind === 'approval_requested');
      expect(notice).toMatchObject({ resource: { kind: 'workflow_run', id: runId } });
    } finally {
      await hub.close();
    }
  });

  it('continues from the step when approved', async () => {
    const hub = await signedInHub();
    try {
      const runId = await start(hub, await workflow(hub, gated, line));
      const [approval] = await pending(hub);
      const answered = await respond(hub, approval!.id as string, {
        decision: 'approve_once',
        answer: null,
      });
      expect(answered.statusCode).toBe(200);
      expect(answered.json()).toMatchObject({ status: 'approved', response: { decision: 'approve_once' } });

      const run = await getRun(hub, runId);
      expect(run.status).toBe('succeeded');
      expect(stepOf(run, 'gate')).toMatchObject({ status: 'succeeded' });
      expect(stepOf(run, 'publish')).toMatchObject({ status: 'succeeded' });
      // "ready" ran once: the run went on from the gate, not from the start.
      expect(run.steps.filter((s) => s.node_id === 'ready')).toHaveLength(1);
      expect(await pending(hub)).toHaveLength(0);

      // One answer only.
      const again = await respond(hub, approval!.id as string, { decision: 'deny', answer: 'x' });
      expect(again.statusCode).toBe(409);
    } finally {
      await hub.close();
    }
  });

  it('fails the step with the reason when denied, and the run follows its failure edge or fails', async () => {
    const hub = await signedInHub();
    try {
      const runId = await start(hub, await workflow(hub, gated, line));
      const [approval] = await pending(hub);
      const denied = await respond(hub, approval!.id as string, {
        decision: 'deny',
        answer: 'الاختبارات لم تكتمل',
      });
      expect(denied.statusCode).toBe(200);
      expect(denied.json()).toMatchObject({ status: 'denied' });
      const run = await getRun(hub, runId);
      expect(run.status).toBe('failed');
      expect(stepOf(run, 'gate')).toMatchObject({
        status: 'failed',
        error: 'denied by Admin: الاختبارات لم تكتمل',
      });
      expect(String(run.error)).toContain('الاختبارات لم تكتمل');
      expect(stepOf(run, 'publish')).toBeUndefined();

      // With a failure edge, a "no" is a route, not the end.
      const routed = await start(
        hub,
        await workflow(
          hub,
          [...gated, node('told', 'notify', 'رُفض')],
          [...line, edge('gate', 'told', 'failure')],
        ),
      );
      const [second] = await pending(hub);
      await respond(hub, second!.id as string, { decision: 'deny', answer: null });
      const after = await getRun(hub, routed);
      expect(after.status).toBe('succeeded');
      expect(stepOf(after, 'told')).toMatchObject({ status: 'succeeded' });
      expect(stepOf(after, 'publish')).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it('waits before a step that asks for approval, then does its work', async () => {
    const hub = await signedInHub();
    try {
      const runId = await start(
        hub,
        await workflow(hub, [node('tell', 'notify', 'تم {{input}}', { approval_required: true })], []),
      );
      expect((await getRun(hub, runId)).status).toBe('waiting');
      const [approval] = await pending(hub);
      await respond(hub, approval!.id as string, { decision: 'approve_once', answer: null });
      const run = await getRun(hub, runId);
      expect(run.status).toBe('succeeded');
      const notices = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/notices' })
      ).json() as { items: Json[] };
      expect(notices.items.some((item) => item.body === 'تم v2.4')).toBe(true);
    } finally {
      await hub.close();
    }
  });

  it('closes the approval when the run is cancelled', async () => {
    const hub = await signedInHub();
    try {
      const runId = await start(hub, await workflow(hub, gated, line));
      const [approval] = await pending(hub);
      const cancelled = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-runs/${runId}/cancel`,
      });
      expect(cancelled.statusCode).toBe(200);
      expect(await pending(hub)).toHaveLength(0);
      const late = await respond(hub, approval!.id as string, {
        decision: 'approve_once',
        answer: null,
      });
      expect(late.statusCode).toBe(409);
      const run = await getRun(hub, runId);
      expect(run.status).toBe('cancelled');
      expect(stepOf(run, 'gate')).toMatchObject({ status: 'cancelled' });
    } finally {
      await hub.close();
    }
  });
});

describe('workflows: an approval outlives a restart', () => {
  it('is still pending after a restart, and approving then continues the run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'majlis-gate-restart-'));
    cleanup.push(dir);
    const first = await signedInHub({ DATA_DIR: dir });
    const runId = await start(first, await workflow(first, gated, line));
    const [before] = await pending(first);
    expect(before).toMatchObject({ status: 'pending' });
    await first.app.close();

    const second = await signedInHub({ DATA_DIR: dir });
    try {
      // The restart failed nothing: the run still waits, the approval is still open.
      expect((await getRun(second, runId)).status).toBe('waiting');
      const [after] = await pending(second);
      expect(after).toMatchObject({ id: before!.id, status: 'pending', workflow_run_id: runId });

      await respond(second, after!.id as string, { decision: 'approve_once', answer: 'تمام' });
      const run = await getRun(second, runId);
      expect(run.status).toBe('succeeded');
      expect(stepOf(run, 'publish')).toMatchObject({ status: 'succeeded' });
      expect(run.steps.filter((s) => s.node_id === 'ready')).toHaveLength(1);
    } finally {
      await second.app.close();
    }
  });
});
