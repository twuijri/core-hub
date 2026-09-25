/**
 * Subagents over the real routes (contract decision §56): a scripted run whose agent delegates
 * to two subagents. The conversation lists them live, one is stopped, the other is steered, read
 * and then finishes; the trajectory draws them in their own lane; the Background panel lists
 * the run and the subagents and stops one — every answer in the contract's shape.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { principalScopeResolver } from '../auth/index.js';
import { signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function schemaErrors(name: string, data: unknown): string[] {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document?.components ?? {},
  });
  return validate(data)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

async function hub(support: 'full' | 'observe' = 'full') {
  const runner = new FakeAgentRunner({
    subagents: support,
    script: [
      { type: 'tool_started', ref: 'd1', name: 'delegate_task', input: { tasks: 2 } },
      {
        type: 'subagent',
        signal: {
          phase: 'started',
          id: 'sa-0-aa',
          depth: 0,
          goal: 'راجع الاختبارات',
          model: 'm1',
          toolCount: 0,
          acceptingSteer: support === 'full',
        },
      },
      {
        type: 'subagent',
        signal: {
          phase: 'started',
          id: 'sa-1-bb',
          depth: 0,
          goal: 'اكتب الملخص',
          model: 'm1',
          toolCount: 0,
          acceptingSteer: support === 'full',
        },
      },
      {
        type: 'subagent',
        signal: {
          phase: 'tool',
          id: 'sa-0-aa',
          toolName: 'read_file',
          toolPreview: 'tests/a.test.ts',
          toolCount: 1,
        },
      },
      {
        type: 'subagent',
        signal: { phase: 'started', id: 'sa-2-cc', parentId: 'sa-1-bb', depth: 1, goal: 'ابحث' },
      },
      { type: 'tool_completed', ref: 'd1', output: 'delegated' },
      { type: 'message_delta', text: 'وزّعت العمل.' },
      { type: 'completed' },
    ],
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([{ ...fakeHermes(AGENT_ID), subagents: support }]),
    runner,
    // The signed-in person, as in the hub: their runs are the Background panel's.
    scopes: principalScopeResolver,
  });
  const h = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  token = h.token;
  return { h, runner };
}

/** The signed-in owner's token: the Background panel is a person's, so every call signs in. */
let token = '';
const headers = (profile = 'default') => ({
  'x-hub-profile': profile,
  authorization: `Bearer ${token}`,
});

async function call(app: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: headers(),
    payload: payload as never,
  });
}

async function startRun(h: TestHub): Promise<string> {
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: headers(),
    payload: { agent_id: AGENT_ID },
  });
  const id = (created.json() as { id: string }).id;
  await h.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${id}/runs`,
    headers: headers(),
    payload: { content: [{ type: 'text', text: 'قسّم العمل على وكلاء' }] },
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const doc = (await call(h.app, 'GET', `/sessions/${id}`)).json() as { runs?: unknown[] };
    const list = (await call(h.app, 'GET', `/sessions/${id}/subagents`)).json() as {
      items: unknown[];
    };
    if (list.items.length === 3 && (doc.runs ?? []).length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return id;
}

type Item = { id: string; status: string; kind?: string; stoppable?: boolean };

describe('sessions subagents (§56)', () => {
  it('lists, stops, steers, reads and finishes subagents, and draws them in the trajectory', async () => {
    const { h, runner } = await hub();
    try {
      const id = await startRun(h);
      const listed = (await call(h.app, 'GET', `/sessions/${id}/subagents`)).json() as {
        support: string;
        items: Array<
          Item & {
            tool_count: number | null;
            last_tool: string | null;
            depth: number;
            parent_id: string | null;
            run_id: string | null;
            tools: unknown[];
          }
        >;
      };
      expect(schemaErrors('SubagentList', listed)).toEqual([]);
      expect(listed.support).toBe('full');
      // They outlive the turn that started them: still running after the run ended.
      expect(listed.items.map((s) => [s.id, s.status, s.depth, s.parent_id])).toEqual([
        ['sa-0-aa', 'running', 0, null],
        ['sa-1-bb', 'running', 0, null],
        ['sa-2-cc', 'running', 1, 'sa-1-bb'],
      ]);
      expect(listed.items[0]).toMatchObject({ tool_count: 1, last_tool: 'read_file' });
      expect(listed.items[0]!.tools).toEqual([
        { name: 'read_file', preview: 'tests/a.test.ts', at: expect.any(String) },
      ]);
      expect(listed.items[0]!.run_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

      // Stop one: the agent is asked, confirms, and it moves to the finished ones.
      const stopped = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-0-aa/interrupt`);
      expect(stopped.statusCode).toBe(200);
      expect(schemaErrors('Subagent', stopped.json())).toEqual([]);
      expect(stopped.json()).toMatchObject({ id: 'sa-0-aa', status: 'interrupted' });
      const again = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-0-aa/interrupt`);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        code: 'state_invalid',
        details: { reason: 'finished' },
      });

      // Steer and read the one still running; a finished one takes no guidance.
      const steered = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-1-bb/steer`, {
        text: 'اختصر',
      });
      expect(steered.json()).toEqual({ status: 'queued' });
      expect(schemaErrors('SubagentSteerResult', steered.json())).toEqual([]);
      const late = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-0-aa/steer`, {
        text: 'x',
      });
      expect(late.statusCode).toBe(409);
      const empty = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-1-bb/steer`, {
        text: '  ',
      });
      expect(empty.statusCode).toBe(400);
      const tail = await call(h.app, 'GET', `/sessions/${id}/subagents/sa-1-bb/tail`);
      expect(tail.json()).toEqual({ available: true, text: 'tail of sa-1-bb', truncated: false });
      expect(schemaErrors('SubagentTail', tail.json())).toEqual([]);
      expect((await call(h.app, 'GET', `/sessions/${id}/subagents/nope/tail`)).statusCode).toBe(
        404,
      );
      expect(runner.subagentCalls.map((c) => [c.verb, c.id])).toEqual([
        ['interrupt', 'sa-0-aa'],
        ['steer', 'sa-1-bb'],
        ['tail', 'sa-1-bb'],
      ]);

      // The Background panel: the run finished, two subagents run, one finished.
      const background = (await call(h.app, 'GET', '/background?profiles=all')).json() as {
        running: Item[];
        finished: Item[];
      };
      expect(schemaErrors('BackgroundList', background)).toEqual([]);
      expect(background.running.map((i) => [i.kind, i.id, i.stoppable])).toEqual([
        ['subagent', `subagent:${id}:sa-1-bb`, true],
        ['subagent', `subagent:${id}:sa-2-cc`, true],
      ]);
      expect(background.finished.map((i) => [i.kind, i.status])).toEqual(
        expect.arrayContaining([
          ['subagent', 'cancelled'],
          ['chat_run', 'succeeded'],
        ]),
      );

      // Stop from the panel, then the agent finishes the last one on its own.
      const panelStop = await h.app.inject({
        method: 'POST',
        url: `/api/v1/background/${encodeURIComponent(`subagent:${id}:sa-2-cc`)}/stop`,
        headers: headers(),
      });
      expect(panelStop.statusCode).toBe(200);
      expect(schemaErrors('BackgroundItem', panelStop.json())).toEqual([]);
      expect(panelStop.json()).toMatchObject({ kind: 'subagent', status: 'cancelled' });
      const runItem = background.finished.find((i) => i.kind === 'chat_run')!;
      const finishedRun = await h.app.inject({
        method: 'POST',
        url: `/api/v1/background/${encodeURIComponent(runItem.id)}/stop`,
        headers: headers(),
      });
      expect(finishedRun.statusCode).toBe(409);
      const unknown = await h.app.inject({
        method: 'POST',
        url: `/api/v1/background/${encodeURIComponent('job:01J8QK3ZR2W7M5N4P6T8V9X0ZZ')}/stop`,
        headers: headers(),
      });
      expect(unknown.statusCode).toBe(404);

      runner.report(id, {
        phase: 'completed',
        id: 'sa-1-bb',
        status: 'completed',
        summary: 'الملخص جاهز',
        toolCount: 2,
      });
      const done = (await call(h.app, 'GET', `/sessions/${id}/subagents`)).json() as {
        items: Array<Item & { summary: string | null; finished_at: string | null }>;
      };
      expect(done.items.every((s) => s.status !== 'running')).toBe(true);
      expect(done.items.find((s) => s.id === 'sa-1-bb')).toMatchObject({
        status: 'completed',
        summary: 'الملخص جاهز',
        finished_at: expect.any(String),
      });

      const trajectory = (await call(h.app, 'GET', `/sessions/${id}/trajectory`)).json() as {
        steps: Array<{ kind: string; lane: string; subagent?: { id: string } }>;
      };
      expect(schemaErrors('Trajectory', trajectory)).toEqual([]);
      const lane = trajectory.steps.filter((s) => s.lane === 'subagents');
      expect(lane.map((s) => [s.kind, s.subagent?.id])).toEqual([
        ['subagent', 'sa-0-aa'],
        ['subagent', 'sa-1-bb'],
        ['subagent', 'sa-2-cc'],
      ]);

      // Another profile's person does not reach this conversation's subagents.
      const elsewhere = await h.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${id}/subagents`,
        headers: headers('other'),
      });
      expect([403, 404]).toContain(elsewhere.statusCode);
    } finally {
      await h.close();
    }
  });

  it('refuses to stop or steer where the agent only lets them be watched', async () => {
    const { h } = await hub('observe');
    try {
      const id = await startRun(h);
      const listed = (await call(h.app, 'GET', `/sessions/${id}/subagents`)).json() as {
        support: string;
      };
      expect(listed.support).toBe('observe');
      const stop = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-0-aa/interrupt`);
      expect(stop.statusCode).toBe(409);
      expect(stop.json()).toMatchObject({ details: { reason: 'unsupported' } });
      const steer = await call(h.app, 'POST', `/sessions/${id}/subagents/sa-0-aa/steer`, {
        text: 'x',
      });
      expect(steer.statusCode).toBe(409);
      const tail = await call(h.app, 'GET', `/sessions/${id}/subagents/sa-0-aa/tail`);
      expect(tail.json()).toEqual({ available: false, text: '', truncated: false });
      const background = (await call(h.app, 'GET', '/background')).json() as { running: Item[] };
      expect(background.running.every((i) => i.stoppable === false)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('answers none, and an empty list, for a conversation whose agent never delegated', async () => {
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
      scopes: principalScopeResolver,
    });
    const h = await signedInHub(
      {},
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    token = h.token;
    try {
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: headers(),
        payload: { agent_id: AGENT_ID },
      });
      const id = (created.json() as { id: string }).id;
      const listed = await call(h.app, 'GET', `/sessions/${id}/subagents`);
      expect(listed.json()).toEqual({ support: 'none', items: [] });
      expect(
        (await call(h.app, 'GET', '/sessions/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/subagents')).statusCode,
      ).toBe(404);
    } finally {
      await h.close();
    }
  });
});
