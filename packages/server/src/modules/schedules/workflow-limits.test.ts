/**
 * A workflow run's limits (DECISIONS §53): a time budget, a cost budget and a per-step
 * timeout — set on the workflow or on one run, enforced by the engine, and read back on the
 * run with what it cost and which limit stopped it.
 *
 * Time is fake (`vi.useFakeTimers`): a step that would take an hour takes a line. Agent
 * turns are a scripted port that works until it is stopped, and their cost is scripted per
 * turn, so "the run went over $1.00" is decided by numbers the test chose. The approvals
 * are the real ones (the composition root's ports, with only the agent and cost replaced).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { registerWorkflowPorts, workflowEngineFor } from './index.js';
import { COST_POLL_MS, type TurnControl, type WorkflowPorts } from './workflow-engine.js';
import { SchedulesService } from './service.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
type Run = Json & { steps: Json[]; limits: Json; cost: Json | null; stopped_by: string | null };

const AGENT = '01KAGENTXYZ000000000000000';
const FAKE_TIME = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
} as const;

const step = (id: string, kind: string, input: string | null) => ({
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
});
const edge = (from: string, to: string, route = 'success') => ({
  id: `${from}-${to}`,
  from,
  to,
  route,
});
const limits = (fields: Json = {}) => ({
  max_duration_seconds: null,
  max_cost: null,
  step_timeout_seconds: null,
  ...fields,
});
const usd = (amount: string) => ({ amount, currency: 'USD' });

/**
 * The scripted agent: a turn named in `hang` works until a limit stops it; any other ends at
 * once. `costs` is what each turn has cost so far, by its title, read by the engine.
 */
interface Script {
  hang: Set<string>;
  costs: Map<string, number>;
  stopped: string[];
  ran: string[];
}

let previous: ReturnType<typeof registerWorkflowPorts> | undefined;
function scriptedAgent(script: Script) {
  previous = registerWorkflowPorts((app) => {
    const real: WorkflowPorts = previous?.(app) ?? { agentTurn: null, notice: null };
    return {
      ...real,
      agentTurn: async (_scope, input, control?: TurnControl) => {
        script.ran.push(input.title);
        control?.started({ sessionId: 's', runId: input.title });
        if (script.hang.has(input.title)) {
          await new Promise<void>((resolve) =>
            control?.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          script.stopped.push(input.title);
          return {
            sessionId: 's',
            runId: input.title,
            status: 'cancelled',
            output: '',
            error: null,
          };
        }
        return {
          sessionId: 's',
          runId: input.title,
          status: 'succeeded',
          output: `${input.title} done`,
          error: null,
        };
      },
      cost: (_scope, runId) => {
        const micro = script.costs.get(runId);
        return micro === undefined
          ? { microUsd: 0, priced: false }
          : { microUsd: micro, priced: true };
      },
    };
  });
}
const newScript = (): Script => ({ hang: new Set(), costs: new Map(), stopped: [], ran: [] });

afterEach(() => {
  vi.useRealTimers();
  if (previous !== undefined) registerWorkflowPorts(previous);
  previous = undefined;
});

async function workflow(hub: Hub, nodes: unknown[], edges: unknown[], withLimits?: Json) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: { name: 'flow', nodes, edges, ...(withLimits ? { limits: withLimits } : {}) },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json() as Json & { id: string; limits: Json };
}

async function start(hub: Hub, id: string, payload: Json = {}) {
  const started = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/workflows/${id}/run`,
    payload,
  });
  expect(started.statusCode, started.body).toBe(202);
  return (started.json() as Json).workflow_run_id as string;
}

async function read(hub: Hub, runId: string): Promise<Run> {
  const got = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/workflow-runs/${runId}`,
  });
  expect(got.statusCode).toBe(200);
  return got.json() as Run;
}

/** Let fake time pass, then wait for the engine to settle what it did in it. */
async function pass(hub: Hub, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  vi.useRealTimers();
  await workflowEngineFor(hub.app).settled();
}

const stepOf = (run: Run, id: string) => run.steps.find((s) => s.node_id === id);

describe('workflow limits: set and read back', () => {
  it('a workflow keeps its limits, a run shows the ones it ran under, and a run can change them', async () => {
    const hub = await signedInHub();
    try {
      const wf = await workflow(
        hub,
        [step('only', 'notify', 'hi')],
        [],
        limits({ max_duration_seconds: 3600, max_cost: usd('2.50'), step_timeout_seconds: 600 }),
      );
      expect(wf.limits).toEqual({
        max_duration_seconds: 3600,
        max_cost: usd('2.50'),
        step_timeout_seconds: 600,
      });

      // Changed later, the whole object replaced.
      const patched = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${wf.id}`,
        payload: { limits: limits({ max_duration_seconds: 900 }) },
      });
      expect((patched.json() as Json).limits).toEqual(limits({ max_duration_seconds: 900 }));

      // One run: a field given replaces, null lifts, absent keeps; timeout_ms is the old name.
      const runId = await start(hub, wf.id, {
        limits: { max_cost: usd('0.40'), max_duration_seconds: null },
      });
      await workflowEngineFor(hub.app).settled();
      const run = await read(hub, runId);
      expect(run.status).toBe('succeeded');
      expect(run.limits).toEqual(limits({ max_cost: usd('0.40') }));
      expect(run.cost).toBeNull();
      expect(run.stopped_by).toBeNull();

      const legacy = await start(hub, wf.id, { timeout_ms: 1500 });
      await workflowEngineFor(hub.app).settled();
      expect((await read(hub, legacy)).limits).toEqual(limits({ max_duration_seconds: 2 }));

      // A workflow saved with no limits has none.
      const plain = await workflow(hub, [step('only', 'notify', 'hi')], []);
      expect(plain.limits).toEqual(limits());
    } finally {
      await hub.close();
    }
  });

  it('refuses a cost limit in another currency or not above zero', async () => {
    const hub = await signedInHub();
    try {
      for (const max_cost of [{ amount: '5', currency: 'EUR' }, usd('0'), usd('-1.5')]) {
        const created = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows',
          payload: { name: 'flow', nodes: [], edges: [], limits: limits({ max_cost }) },
        });
        expect(created.statusCode).toBe(409);
        expect((created.json() as { details: Json }).details).toMatchObject({
          reason: 'limit_invalid',
          field: 'limits.max_cost',
        });
      }
      const wf = await workflow(hub, [step('only', 'notify', 'hi')], []);
      const refused = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflows/${wf.id}/run`,
        payload: { limits: { max_cost: { amount: '1', currency: 'SAR' } } },
      });
      expect(refused.statusCode).toBe(409);
      // Out of the contract's range: the schema's 400.
      const tooLong = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflows/${wf.id}/run`,
        payload: { limits: { step_timeout_seconds: 0 } },
      });
      expect(tooLong.statusCode).toBe(400);
    } finally {
      await hub.close();
    }
  });
});

describe('workflow limits: enforced', () => {
  it('the time budget stops the run and the step working then, and nothing after it runs', async () => {
    const script = newScript();
    script.hang.add('work');
    scriptedAgent(script);
    const hub = await signedInHub();
    try {
      const wf = await workflow(
        hub,
        [step('work', 'agent', 'long job'), step('after', 'notify', 'done')],
        [edge('work', 'after', 'always')],
        limits({ max_duration_seconds: 60 }),
      );
      vi.useFakeTimers(FAKE_TIME);
      const runId = await start(hub, wf.id);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(script.stopped).toEqual([]);
      await pass(hub, 2_000);

      const run = await read(hub, runId);
      expect(run.status).toBe('failed');
      expect(run.stopped_by).toBe('max_duration');
      expect(run.error).toBe('stopped: the run went over its time limit of 1 min');
      expect(stepOf(run, 'work')).toMatchObject({ status: 'cancelled' });
      expect(stepOf(run, 'after')).toBeUndefined();
      expect(script.stopped).toEqual(['work']);
    } finally {
      await hub.close();
    }
  });

  it('the cost budget stops an agent step that goes over it while it works', async () => {
    const script = newScript();
    script.hang.add('work');
    scriptedAgent(script);
    const hub = await signedInHub();
    try {
      const wf = await workflow(
        hub,
        [step('work', 'agent', 'spend')],
        [],
        limits({ max_cost: usd('1.00') }),
      );
      vi.useFakeTimers(FAKE_TIME);
      const runId = await start(hub, wf.id);
      script.costs.set('work', 400_000);
      await vi.advanceTimersByTimeAsync(COST_POLL_MS * 3);
      expect(script.stopped).toEqual([]);
      // The turn's estimate passes the budget: the next look stops it.
      script.costs.set('work', 1_250_000);
      await pass(hub, COST_POLL_MS);

      const run = await read(hub, runId);
      expect(run.status).toBe('failed');
      expect(run.stopped_by).toBe('max_cost');
      expect(run.cost).toEqual({ amount: '1.250000', currency: 'USD' });
      expect(run.error).toBe(
        'stopped: the run went over its cost limit of $1.00 (it cost about $1.25)',
      );
      expect(stepOf(run, 'work')).toMatchObject({ status: 'cancelled' });
      expect(script.stopped).toEqual(['work']);
    } finally {
      await hub.close();
    }
  });

  it('a budget used up by finished steps stops the run before the next one', async () => {
    const script = newScript();
    script.costs.set('one', 600_000);
    script.costs.set('two', 600_000);
    scriptedAgent(script);
    const hub = await signedInHub();
    try {
      const wf = await workflow(
        hub,
        [step('one', 'agent', 'a'), step('two', 'agent', 'b'), step('three', 'agent', 'c')],
        [edge('one', 'two'), edge('two', 'three')],
        limits({ max_cost: usd('1.00') }),
      );
      const runId = await start(hub, wf.id);
      await workflowEngineFor(hub.app).settled();
      const run = await read(hub, runId);
      expect(script.ran).toEqual(['one', 'two']);
      expect(run.status).toBe('failed');
      expect(run.stopped_by).toBe('max_cost');
      expect(run.cost).toEqual({ amount: '1.200000', currency: 'USD' });
      expect(stepOf(run, 'two')).toMatchObject({ status: 'succeeded' });
      expect(stepOf(run, 'three')).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it('a step past its timeout fails and its failure edge takes it; without one the run stops', async () => {
    const script = newScript();
    script.hang.add('slow');
    scriptedAgent(script);
    const hub = await signedInHub();
    try {
      const handled = await workflow(
        hub,
        [step('slow', 'agent', 'x'), step('fallback', 'notify', 'took too long')],
        [edge('slow', 'fallback', 'failure')],
        limits({ step_timeout_seconds: 30 }),
      );
      vi.useFakeTimers(FAKE_TIME);
      const first = await start(hub, handled.id);
      await pass(hub, 31_000);
      const recovered = await read(hub, first);
      expect(recovered.status).toBe('succeeded');
      expect(recovered.stopped_by).toBeNull();
      expect(stepOf(recovered, 'slow')).toMatchObject({
        status: 'failed',
        error: 'timed out after 30 s',
      });
      expect(stepOf(recovered, 'fallback')).toMatchObject({ status: 'succeeded' });

      const bare = await workflow(
        hub,
        [step('slow', 'agent', 'x')],
        [],
        limits({ step_timeout_seconds: 30 }),
      );
      vi.useFakeTimers(FAKE_TIME);
      const second = await start(hub, bare.id);
      await pass(hub, 31_000);
      const stopped = await read(hub, second);
      expect(stopped.status).toBe('failed');
      expect(stopped.stopped_by).toBe('step_timeout');
      expect(stopped.error).toBe('slow: timed out after 30 s');
      expect(script.stopped).toEqual(['slow', 'slow']);
    } finally {
      await hub.close();
    }
  });

  it('a delay is a step too: the time budget ends it', async () => {
    scriptedAgent(newScript());
    const hub = await signedInHub();
    try {
      const wf = await workflow(
        hub,
        [step('wait', 'delay', '600'), step('after', 'notify', 'done')],
        [edge('wait', 'after')],
        limits({ max_duration_seconds: 120 }),
      );
      vi.useFakeTimers(FAKE_TIME);
      const runId = await start(hub, wf.id);
      await pass(hub, 121_000);
      const run = await read(hub, runId);
      expect(run.stopped_by).toBe('max_duration');
      expect(stepOf(run, 'wait')).toMatchObject({ status: 'cancelled' });
      expect(stepOf(run, 'after')).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  it('time spent waiting for a person counts toward nothing', async () => {
    scriptedAgent(newScript());
    const hub = await signedInHub();
    try {
      const wf = await workflow(
        hub,
        [step('gate', 'approval', 'go?'), step('work', 'agent', 'now')],
        [edge('gate', 'work')],
        limits({ max_duration_seconds: 60 }),
      );
      vi.useFakeTimers(FAKE_TIME);
      const runId = await start(hub, wf.id);
      // An hour of the person thinking about it.
      await pass(hub, 3_600_000);
      expect((await read(hub, runId)).status).toBe('waiting');
      const approvals = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/approvals' });
      const gate = (approvals.json() as { items: Json[] }).items.find(
        (item) => item.kind === 'workflow_step',
      )!;
      const answered = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/approvals/${String(gate.id)}/respond`,
        payload: { decision: 'approve_once', answer: null },
      });
      expect(answered.statusCode).toBe(200);
      await workflowEngineFor(hub.app).settled();
      const run = await read(hub, runId);
      expect(run.status).toBe('succeeded');
      expect(run.stopped_by).toBeNull();
    } finally {
      await hub.close();
    }
  });
});

describe('schedules.previewTrigger', () => {
  const cron = (expression: string) => ({
    kind: 'cron',
    expression,
    every_minutes: null,
    run_at: null,
    timezone: 'Asia/Riyadh',
  });

  it("is the hub's own next-run calculation, each time counted from the one before", () => {
    const service = new SchedulesService(null as never);
    // Monday 2026-09-28 10:30 in Riyadh (UTC+3).
    const now = new Date('2026-09-28T07:30:00Z');
    const iso = (trigger: Json, count = 3) =>
      service.previewTrigger(trigger, count, now).nextRuns.map((at) => at.toISOString());

    // Weekdays at 09:00: today's has passed, so Tuesday, Wednesday, Thursday.
    expect(iso(cron('0 9 * * 1-5'))).toEqual([
      '2026-09-29T06:00:00.000Z',
      '2026-09-30T06:00:00.000Z',
      '2026-10-01T06:00:00.000Z',
    ]);
    // First of the month, five of them.
    const monthly = iso(cron('0 9 1 * *'), 5);
    expect(monthly).toHaveLength(5);
    expect(monthly[0]).toBe('2026-10-01T06:00:00.000Z');
    expect(monthly[4]).toBe('2027-02-01T06:00:00.000Z');
    // Every 15 minutes, from now.
    expect(
      iso({ kind: 'interval', expression: null, every_minutes: 15, run_at: null, timezone: 'UTC' }),
    ).toEqual(['2026-09-28T07:45:00.000Z', '2026-09-28T08:00:00.000Z', '2026-09-28T08:15:00.000Z']);
    // Once: one time if it is ahead, none if it has passed.
    const once = (run_at: string) => ({
      kind: 'once',
      expression: null,
      every_minutes: null,
      run_at,
      timezone: 'UTC',
    });
    expect(iso(once('2026-10-05T12:00:00Z'))).toEqual(['2026-10-05T12:00:00.000Z']);
    expect(iso(once('2026-01-01T00:00:00Z'))).toEqual([]);
    // An impossible date never comes.
    expect(iso(cron('0 0 31 2 *'))).toEqual([]);
  });

  it("answers over HTTP in the trigger's zone, and refuses what saving refuses", async () => {
    const hub = await signedInHub();
    try {
      const preview = (trigger: Json, count?: number) =>
        authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/schedules/preview',
          payload: { trigger, ...(count ? { count } : {}) },
        });
      const weekdays = await preview(cron('0 9 * * 1-5'));
      expect(weekdays.statusCode).toBe(200);
      const body = weekdays.json() as { timezone: string; next_runs: string[] };
      expect(body.timezone).toBe('Asia/Riyadh');
      expect(body.next_runs).toHaveLength(3);
      for (const at of body.next_runs) {
        const local = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Riyadh',
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(at));
        expect(local).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/);
        expect(Date.parse(at)).toBeGreaterThan(Date.now());
      }
      expect([...body.next_runs].sort()).toEqual(body.next_runs);
      expect(((await preview(cron('*/5 * * * *'), 10)).json() as Json).next_runs).toHaveLength(10);

      const bad = await preview(cron('61 * * * *'));
      expect(bad.statusCode).toBe(409);
      expect((bad.json() as { details: Json }).details).toMatchObject({
        reason: 'cron_invalid',
        field: 'trigger.expression',
      });
      const zone = await preview({ ...cron('0 9 * * *'), timezone: 'Mars/Olympus' });
      expect(zone.statusCode).toBe(409);
      expect((zone.json() as { details: Json }).details).toMatchObject({
        reason: 'timezone_unknown',
      });
      expect((await preview(cron('0 9 * * *'), 11)).statusCode).toBe(400);
    } finally {
      await hub.close();
    }
  });
});
