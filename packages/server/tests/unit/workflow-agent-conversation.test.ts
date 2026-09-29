/**
 * An agent step that talks in one existing conversation (DECISIONS §136), through a **real**
 * session: `schedules` runs the step, `sessions` takes the turn (played by the scripted
 * runner), and the composition root joins them as production does.
 *
 * What a person relies on: every run's prompt and reply land in the same conversation, in
 * order; a missing, deleted or foreign conversation fails the step with a reason and never
 * opens a new one in silence (unless "Create if missing" is on — then it is made once, the
 * step is pointed at it, and the inbox says so); two runs at once take their turns one after
 * another, each reading its own reply; the step's output carries the conversation, the reply
 * and the run; "Test conversation" gives the run's own answer without sending anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { registerWorkflowPorts, workflowEngineFor } from '../../src/modules/schedules/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type FakeRunnerOptions,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';
const OTHER_AGENT = '01KAGENTXYZ000000000000001';
const NOWHERE = '01J8QK3ZR2W7M5N4P6T8V9X0ZZ';

let restore: ReturnType<typeof registerWorkflowPorts> | undefined;
afterEach(() => {
  if (restore !== undefined) registerWorkflowPorts(restore);
  restore = undefined;
});

/** The production ports, with a shorter wait for a busy conversation. */
function shortWait(ms: number) {
  const production = registerWorkflowPorts(null);
  restore = production;
  registerWorkflowPorts((app) => ({ ...production!(app), conversationWaitMs: ms }));
}

async function hubWith(options: FakeRunnerOptions) {
  const runner = new FakeAgentRunner(options);
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT), fakeHermes(OTHER_AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  const hub = await signedInHub({}, { modules });
  return { hub, runner };
}

const agentStep = (conversation: Json | null | undefined, extra: Json = {}) => ({
  id: 'ask',
  kind: 'agent',
  title: 'ask',
  agent_id: AGENT,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input: 'لخّص {{input}}',
  approval_required: false,
  position: { x: 0, y: 0 },
  ...(conversation === undefined ? {} : { conversation }),
  ...extra,
});

/** A notice after the agent step that reads what the step left for later steps. */
const readBack = {
  id: 'tell',
  kind: 'notify',
  title: 'tell',
  agent_id: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input:
    'c={{steps.ask.conversation_id}} m={{steps.ask.message_id}} r={{steps.ask.run_id}} s={{steps.ask.status}}',
  approval_required: false,
  position: { x: 300, y: 0 },
};

async function workflow(hub: Hub, nodes: unknown[], edges: unknown[] = []) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: { name: 'flow', nodes, edges },
  });
  expect(created.statusCode, created.body).toBe(201);
  return (created.json() as Json).id as string;
}

async function start(hub: Hub, id: string, input: string) {
  const started = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/workflows/${id}/run`,
    payload: { input },
  });
  expect(started.statusCode, started.body).toBe(202);
  return (started.json() as Json).workflow_run_id as string;
}

async function runOf(hub: Hub, runId: string) {
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
  ).json() as Json & { steps: Json[] };
}

async function run(hub: Hub, id: string, input: string) {
  const runId = await start(hub, id, input);
  await workflowEngineFor(hub.app).settled();
  return runOf(hub, runId);
}

async function conversation(hub: Hub, title: string, agent = AGENT, profile = 'default') {
  const made = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: agent, title },
    profile,
  });
  expect(made.statusCode, made.body).toBe(201);
  return (made.json() as Json).id as string;
}

async function messages(hub: Hub, sessionId: string) {
  const res = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/sessions/${sessionId}/messages?limit=100`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return ((res.json() as { items: Json[] }).items ?? []).map((message) => ({
    id: message.id as string,
    role: message.role as string,
    run_id: message.run_id as string | null,
    text: ((message.content as Array<{ type: string; text?: string }>) ?? [])
      .map((block) => block.text ?? '')
      .join(''),
  }));
}

async function sessionsTitled(hub: Hub, title: string) {
  const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/sessions?limit=200' });
  return (listed.json() as { items: Json[] }).items.filter((s) => s.title === title);
}

async function workflowNode(hub: Hub, id: string) {
  const got = await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflows/${id}` });
  return ((got.json() as { nodes: Json[] }).nodes ?? []).find((node) => node.id === 'ask')!;
}

async function inbox(hub: Hub) {
  const res = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/notices' });
  return (res.json() as { items: Json[] }).items;
}

const reply = (text: string) => [
  { type: 'message_delta' as const, text },
  { type: 'completed' as const },
];
const stepOf = (result: { steps: Json[] }, id: string) =>
  result.steps.find((step) => step.node_id === id)!;

describe('workflows: an agent step that reuses a conversation (§136)', () => {
  it('sends every run into the same conversation, keeps its history in order, and says where', async () => {
    const { hub, runner } = await hubWith({
      scriptFor: (_request, prompt) => reply(`جواب: ${prompt}`),
    });
    try {
      const chat = await conversation(hub, 'تقارير');
      const id = await workflow(
        hub,
        [agentStep({ mode: 'reuse', session_id: chat }), readBack],
        [{ id: 'e1', from: 'ask', to: 'tell', route: 'success' }],
      );
      const before = await sessionsTitled(hub, 'ask');

      const first = await run(hub, id, 'الأول');
      const second = await run(hub, id, 'الثاني');
      expect(first.status, JSON.stringify(first)).toBe('succeeded');
      expect(second.status).toBe('succeeded');
      expect(runner.started.map((request) => request.sessionId)).toEqual([chat, chat]);
      // No conversation per run: the chat list has no new "ask".
      expect(await sessionsTitled(hub, 'ask')).toHaveLength(before.length);

      const history = await messages(hub, chat);
      expect(history.map((message) => `${message.role}:${message.text}`)).toEqual([
        'user:لخّص الأول',
        'assistant:جواب: لخّص الأول',
        'user:لخّص الثاني',
        'assistant:جواب: لخّص الثاني',
      ]);

      // The step says where it talked and which reply is its own.
      for (const [result, index] of [
        [first, 1],
        [second, 3],
      ] as const) {
        const step = stepOf(result, 'ask');
        expect(step).toMatchObject({
          status: 'succeeded',
          session_id: chat,
          message_id: history[index]!.id,
          output: history[index]!.text,
        });
        expect(step.run_id).toBe(history[index]!.run_id);
        expect(stepOf(result, 'tell').output).toBe(
          `c=${chat} m=${history[index]!.id} r=${step.run_id as string} s=succeeded`,
        );
      }
    } finally {
      await hub.close();
    }
  });

  it('a new conversation per run stays the default, and the step now names it', async () => {
    const { hub } = await hubWith({ script: reply('تم') });
    try {
      const id = await workflow(hub, [agentStep(undefined)]);
      const one = await run(hub, id, 'a');
      const two = await run(hub, id, 'b');
      const first = stepOf(one, 'ask').session_id as string;
      const second = stepOf(two, 'ask').session_id as string;
      expect(first).toMatch(/^[0-9A-Z]{26}$/);
      expect(second).not.toBe(first);
      expect(stepOf(one, 'ask').message_id).toBeTruthy();
    } finally {
      await hub.close();
    }
  });

  it('fails clearly on a missing, a deleted or another profile’s conversation, and never opens one in silence', async () => {
    const { hub, runner } = await hubWith({ script: reply('تم') });
    try {
      const deleted = await conversation(hub, 'قديمة');
      const gone = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/sessions/${deleted}`,
      });
      expect(gone.statusCode).toBeLessThan(300);
      const profile = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: 'other', name: 'Other' },
      });
      expect(profile.statusCode, profile.body).toBe(201);
      const foreign = await conversation(hub, 'غريبة', AGENT, 'other');

      for (const target of [NOWHERE, deleted, foreign]) {
        const id = await workflow(hub, [agentStep({ mode: 'reuse', session_id: target })]);
        const listed = (await sessionsTitled(hub, 'ask')).length;
        const result = await run(hub, id, 'x');
        expect(result.status).toBe('failed');
        expect(stepOf(result, 'ask').error).toContain(
          `the conversation ${target} was not found in this profile`,
        );
        expect(await sessionsTitled(hub, 'ask')).toHaveLength(listed);
      }
      expect(runner.started).toHaveLength(0);
      // The foreign conversation was not touched.
      const theirs = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/sessions/${foreign}/messages`,
        profile: 'other',
      });
      expect((theirs.json() as { items: unknown[] }).items).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it("refuses a conversation of another agent, and a step without an agent uses the conversation's", async () => {
    const { hub, runner } = await hubWith({ script: reply('تم') });
    try {
      const theirs = await conversation(hub, 'وكيل آخر', OTHER_AGENT);
      const mismatch = await workflow(hub, [agentStep({ mode: 'reuse', session_id: theirs })]);
      const refused = await run(hub, mismatch, 'x');
      expect(refused.status).toBe('failed');
      expect(stepOf(refused, 'ask').error).toContain("is not this step's agent");
      expect(runner.started).toHaveLength(0);

      const open = await workflow(hub, [
        agentStep({ mode: 'reuse', session_id: theirs }, { agent_id: null }),
      ]);
      const ok = await run(hub, open, 'y');
      expect(ok.status).toBe('succeeded');
      expect(runner.started.map((request) => request.agentId)).toEqual([OTHER_AGENT]);
    } finally {
      await hub.close();
    }
  });

  it('makes a missing conversation once when asked, points the step at it, and says so', async () => {
    const { hub } = await hubWith({ script: reply('تم') });
    try {
      const id = await workflow(hub, [
        agentStep({
          mode: 'reuse',
          session_id: NOWHERE,
          create_if_missing: true,
          title: 'متابعة {{input}}',
        }),
      ]);
      const first = await run(hub, id, 'ClickUp');
      expect(first.status, JSON.stringify(first)).toBe('succeeded');
      const made = stepOf(first, 'ask').session_id as string;
      expect(made).not.toBe(NOWHERE);
      expect(await sessionsTitled(hub, 'متابعة ClickUp')).toHaveLength(1);
      expect((await workflowNode(hub, id)).conversation).toMatchObject({
        mode: 'reuse',
        session_id: made,
        create_if_missing: true,
      });
      const notices = await inbox(hub);
      expect(
        notices.some(
          (notice) =>
            String(notice.title).includes('a new conversation') &&
            String(notice.body).includes(NOWHERE) &&
            String(notice.body).includes(made),
        ),
      ).toBe(true);

      const second = await run(hub, id, 'ClickUp');
      expect(stepOf(second, 'ask').session_id).toBe(made);
      expect((await messages(hub, made)).filter((m) => m.role === 'user')).toHaveLength(2);
    } finally {
      await hub.close();
    }
  });

  it('takes two runs one after another in the same conversation, each with its own reply', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { hub, runner } = await hubWith({
      scriptFor: (_request, prompt) => reply(`جواب ${prompt}`),
      // The first turn holds until the test lets it go, so the second run has to wait.
      onStart: async (request) => {
        if (runner.started.length === 1 && request.sessionId) await gate;
      },
    });
    try {
      const chat = await conversation(hub, 'مشتركة');
      const id = await workflow(hub, [agentStep({ mode: 'reuse', session_id: chat })]);
      const a = await start(hub, id, 'أ');
      const b = await start(hub, id, 'ب');
      await new Promise((resolve) => setTimeout(resolve, 600));
      // Only the first turn is going; the second has not even written its prompt.
      expect(runner.started).toHaveLength(1);
      expect((await messages(hub, chat)).filter((m) => m.role === 'user')).toHaveLength(1);
      open();
      await workflowEngineFor(hub.app).settled();

      const history = await messages(hub, chat);
      expect(history.map((message) => `${message.role}:${message.text}`)).toEqual([
        'user:لخّص أ',
        'assistant:جواب لخّص أ',
        'user:لخّص ب',
        'assistant:جواب لخّص ب',
      ]);
      const first = await runOf(hub, a);
      const second = await runOf(hub, b);
      expect(stepOf(first, 'ask').output).toBe('جواب لخّص أ');
      expect(stepOf(second, 'ask').output).toBe('جواب لخّص ب');
      expect(stepOf(first, 'ask').run_id).not.toBe(stepOf(second, 'ask').run_id);
    } finally {
      open();
      await hub.close();
    }
  });

  it('fails a run that waited too long for a busy conversation, without writing into it', async () => {
    shortWait(300);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { hub, runner } = await hubWith({
      scriptFor: (_request, prompt) => reply(`جواب ${prompt}`),
      onStart: async () => {
        if (runner.started.length === 1) await gate;
      },
    });
    try {
      const chat = await conversation(hub, 'مشغولة');
      const id = await workflow(hub, [agentStep({ mode: 'reuse', session_id: chat })]);
      const a = await start(hub, id, 'أ');
      const b = await start(hub, id, 'ب');
      // The second run gives up while the first still holds the conversation.
      for (let i = 0; i < 40; i++) {
        if ((await runOf(hub, b)).status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const late = await runOf(hub, b);
      expect(late.status).toBe('failed');
      expect(stepOf(late, 'ask').error).toContain('the conversation was busy');
      open();
      await workflowEngineFor(hub.app).settled();
      expect((await runOf(hub, a)).status).toBe('succeeded');
      expect((await messages(hub, chat)).filter((m) => m.role === 'user')).toHaveLength(1);
    } finally {
      open();
      await hub.close();
    }
  });

  it('"Test conversation" answers as the run would, and sends nothing', async () => {
    const { hub, runner } = await hubWith({ script: reply('تم') });
    try {
      const chat = await conversation(hub, 'فحص');
      const theirs = await conversation(hub, 'وكيل آخر', OTHER_AGENT);
      const check = async (sessionId: string, agentId: string | null = AGENT) => {
        const res = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows/conversation-check',
          payload: { session_id: sessionId, agent_id: agentId },
        });
        return { status: res.statusCode, body: res.json() as Json };
      };
      expect((await check(chat)).body).toMatchObject({
        status: 'ready',
        session_id: chat,
        title: 'فحص',
        agent_id: AGENT,
        active_run_id: null,
      });
      expect((await check(`\u200f ${chat} `)).body).toMatchObject({ status: 'ready' });
      expect((await check(NOWHERE)).body).toMatchObject({ status: 'not_found', title: null });
      expect((await check(theirs)).body).toMatchObject({ status: 'agent_mismatch' });
      expect((await check(theirs, null)).body).toMatchObject({ status: 'ready' });
      const template = await check('{{trigger.body.id}}');
      expect(template.status).toBe(400);
      expect(runner.started).toHaveLength(0);
      expect(await messages(hub, chat)).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it('checks the field when the workflow is saved, and an app that does not know it keeps it', async () => {
    const { hub } = await hubWith({ script: reply('تم') });
    try {
      const refused = async (conversationField: Json, code: string) => {
        const res = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows/validate',
          payload: { nodes: [agentStep(conversationField)], edges: [] },
        });
        const body = res.json() as { problems: Array<{ code: string }> };
        expect(body.problems.map((problem) => problem.code)).toContain(code);
      };
      await refused({ mode: 'sometimes' }, 'conversation_mode_unknown');
      await refused({ mode: 'reuse' }, 'conversation_id_missing');
      await refused({ mode: 'reuse', session_id: 'not an id' }, 'conversation_id_invalid');
      await refused({ mode: 'reuse', session_id: '{{nope.x}}' }, 'template_root_unknown');

      const chat = await conversation(hub, 'محفوظة');
      const id = await workflow(hub, [agentStep({ mode: 'reuse', session_id: chat })]);
      // An older phone saves the step without the field it does not know.
      const older = agentStep(undefined, { title: 'renamed' });
      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${id}`,
        payload: { nodes: [older], edges: [] },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await workflowNode(hub, id)).conversation).toMatchObject({
        mode: 'reuse',
        session_id: chat,
      });
      expect((await workflowNode(hub, id)).title).toBe('renamed');
      // `null` removes it.
      await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${id}`,
        payload: { nodes: [agentStep(null)], edges: [] },
      });
      expect((await workflowNode(hub, id)).conversation ?? null).toBeNull();
    } finally {
      await hub.close();
    }
  });
});
