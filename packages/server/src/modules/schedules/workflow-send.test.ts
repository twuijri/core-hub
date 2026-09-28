/**
 * The "Send message" step (DECISIONS §124): long text split for Telegram on safe boundaries,
 * each target on its own, never "sent" without the platform's id, Telegram's own reason on a
 * refusal, a failure said in the inbox, nothing sent twice when the step runs again, and a
 * deleted conversation made again, pointed to and said.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { registerWorkflowPorts, workflowEngineFor } from './index.js';
import { splitMessage } from './send.js';
import type { MessagePorts, WorkflowPorts } from './workflow-engine.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012';
const AGENT = '01KAGENTXYZ000000000000000';
const OLD_SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0SA';
const NEW_SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0SB';

describe('splitting a message for Telegram', () => {
  it('keeps every part within 4096 UTF-16 units, on paragraph, line and word boundaries', () => {
    const paragraph = 'هذه فقرة عربية طويلة تشرح ما تم في المهمة وما بقي منها. '.repeat(30).trim();
    const text = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.startsWith('هذه')).toBe(true);
    }
    expect(parts.join('\n\n')).toBe(text);
  });

  it('cuts one very long word where it must, never inside a surrogate pair', () => {
    const emoji = '😀'.repeat(3000); // 6000 UTF-16 units, no spaces
    const parts = splitMessage(emoji);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join('')).toBe(emoji);
    for (const part of parts) expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(splitMessage('  short  ')).toEqual(['short']);
  });
});

const calls: Array<{ url: string; chat: string; text: string }> = [];
const posts: Array<{ sessionId: string | null; text: string }> = [];
const notices: Array<{ title: string; body: string | null }> = [];

function fakeMessages(overrides: Partial<MessagePorts> = {}): MessagePorts {
  return {
    telegramToken: () => TOKEN,
    telegramApi: 'http://telegram.test',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      calls.push({ url: String(url), chat: body.chat_id, text: body.text });
      if (body.chat_id === '-100404') {
        return Response.json(
          { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: { message_id: 700 + calls.length } });
    }) as typeof fetch,
    post: async (_scope, input) => {
      posts.push({ sessionId: input.sessionId, text: input.text });
      if (input.sessionId === OLD_SESSION) {
        return { sessionId: NEW_SESSION, messageId: 'M-new', recreated: true, title: input.title };
      }
      return {
        sessionId: input.sessionId ?? NEW_SESSION,
        messageId: `M-${posts.length}`,
        recreated: false,
        title: input.title,
      };
    },
    ...overrides,
  };
}

let previous: ReturnType<typeof registerWorkflowPorts> | undefined;
function fakePorts(ports: Partial<WorkflowPorts> = {}) {
  previous = registerWorkflowPorts(() => ({
    agentTurn: null,
    notice: (_scope, input) => void notices.push(input),
    messages: fakeMessages(),
    ...ports,
  }));
}
afterEach(() => {
  if (previous !== undefined) registerWorkflowPorts(previous);
  previous = undefined;
  calls.length = 0;
  posts.length = 0;
  notices.length = 0;
});

const send = (targets: Json[], input = 'تقرير: {{input}}') => ({
  id: 'tell',
  kind: 'notify',
  title: 'Send',
  agent_id: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input,
  approval_required: false,
  position: { x: 0, y: 0 },
  send: { targets },
});

async function workflow(hub: Hub, nodes: unknown[]) {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: { name: 'Send', nodes, edges: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as Json).id as string;
}

async function runOnce(hub: Hub, id: string, input = 'تم') {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/workflows/${id}/run`,
    payload: { input },
  });
  expect(res.statusCode, res.body).toBe(202);
  await workflowEngineFor(hub.app).settled();
  const runId = (res.json() as { workflow_run_id: string }).workflow_run_id;
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
  ).json() as Json & { steps: Array<Json>; status: string; id: string };
}

describe('the "Send message" step', () => {
  it('sends to Telegram and a conversation, says what went, and never sends twice on a rerun', async () => {
    fakePorts();
    const hub = await signedInHub();
    try {
      const long = 'سطر طويل من التقرير. '.repeat(300);
      const id = await workflow(hub, [
        send(
          [
            { platform: 'telegram', chat_id: '-1001234567890' },
            { platform: 'core_hub', session_id: NEW_SESSION, title: 'Reports', agent_id: AGENT },
          ],
          `${long}\n\n{{input}}`,
        ),
      ]);
      const run = await runOnce(hub, id);
      expect(run.status).toBe('succeeded');
      const parts = splitMessage(`${long}\n\nتم`);
      expect(parts.length).toBe(2);
      expect(calls.map((call) => [call.url, call.chat, call.text])).toEqual(
        parts.map((part) => [
          `http://telegram.test/bot${TOKEN}/sendMessage`,
          '-1001234567890',
          part,
        ]),
      );
      expect(posts).toEqual([{ sessionId: NEW_SESSION, text: `${long}\n\nتم` }]);
      const output = JSON.parse(String(run.steps[0]!.output)) as Json;
      expect(output).toEqual({
        status: 'sent',
        message_id: '701',
        message_ids: ['701', '702', 'M-1'],
        delivered_to: ['telegram:-1001234567890', `core_hub:${NEW_SESSION}`],
        failures: [],
      });
      expect(notices).toEqual([]);

      // A rerun from the step: every part is already out, nothing is sent again.
      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-runs/${run.id}/rerun`,
        payload: { from_node_id: 'tell' },
      });
      expect(again.statusCode, again.body).toBe(202);
      await workflowEngineFor(hub.app).settled();
      expect(calls).toHaveLength(2);
      expect(posts).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('a refused target is said in Telegram’s words; all refused fails the step and tells the inbox', async () => {
    fakePorts();
    const hub = await signedInHub();
    try {
      const partial = await workflow(hub, [
        send([
          { platform: 'telegram', chat_id: '-100404' },
          { platform: 'core_hub', session_id: NEW_SESSION, title: 'R', agent_id: AGENT },
        ]),
      ]);
      const first = await runOnce(hub, partial);
      expect(first.status).toBe('succeeded');
      expect(JSON.parse(String(first.steps[0]!.output))).toMatchObject({
        status: 'partial',
        delivered_to: [`core_hub:${NEW_SESSION}`],
        failures: [{ target: 'telegram:-100404', reason: 'Bad Request: chat not found' }],
      });
      expect(notices).toEqual([
        { title: 'Send', body: 'telegram:-100404: Bad Request: chat not found' },
      ]);

      notices.length = 0;
      const none = await workflow(hub, [send([{ platform: 'telegram', chat_id: '-100404' }])]);
      const failed = await runOnce(hub, none);
      expect(failed.status).toBe('failed');
      expect(failed.steps[0]).toMatchObject({
        status: 'failed',
        error: 'telegram:-100404: Bad Request: chat not found',
      });
      expect(notices[0]).toMatchObject({ title: 'Send: not sent' });
    } finally {
      await hub.close();
    }
  });

  it('a profile without a bot is a clear reason, not a success', async () => {
    fakePorts({ messages: fakeMessages({ telegramToken: () => null }) });
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [send([{ platform: 'telegram', chat_id: '-1001' }])]);
      const run = await runOnce(hub, id);
      expect(run.status).toBe('failed');
      expect(String(run.steps[0]!.error)).toContain('TELEGRAM_BOT_TOKEN');
      expect(calls).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it('a deleted conversation is made again, the step points to it, and the inbox is told', async () => {
    fakePorts();
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [
        send([
          { platform: 'core_hub', session_id: OLD_SESSION, title: 'Reports', agent_id: AGENT },
        ]),
      ]);
      const run = await runOnce(hub, id);
      expect(run.status).toBe('succeeded');
      expect(JSON.parse(String(run.steps[0]!.output))).toMatchObject({
        status: 'sent',
        delivered_to: [`core_hub:${NEW_SESSION}`],
      });
      expect(notices[0]!.body).toContain('Reports');
      const saved = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflows/${id}` })
      ).json() as { nodes: Array<{ send: { targets: Json[] } }> };
      expect(saved.nodes[0]!.send.targets[0]).toMatchObject({ session_id: NEW_SESSION });
    } finally {
      await hub.close();
    }
  });

  it('is checked when saved, kept when an older app saves without it, and can be tested', async () => {
    fakePorts();
    const hub = await signedInHub();
    try {
      const check = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows/validate',
        payload: {
          nodes: [
            send([
              { platform: 'whatsapp', chat_id: '1' },
              { platform: 'telegram', chat_id: ' ' },
              { platform: 'core_hub' },
            ]),
          ],
          edges: [],
        },
      });
      expect((check.json() as { problems: Json[] }).problems.map((p) => p.code)).toEqual([
        'send_platform_unknown',
        'send_chat_missing',
        'send_conversation_missing',
      ]);

      const targets = [{ platform: 'telegram', chat_id: '-1001' }];
      const id = await workflow(hub, [send(targets)]);
      const { send: _drop, ...older } = send(targets);
      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${id}`,
        payload: { nodes: [{ ...older, title: 'renamed' }], edges: [] },
      });
      expect((saved.json() as { nodes: Json[] }).nodes[0]).toMatchObject({
        title: 'renamed',
        send: { targets },
      });

      const tested = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows/send-test',
        payload: { text: 'تجربة', send: { targets } },
      });
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json()).toMatchObject({ status: 'sent', delivered_to: ['telegram:-1001'] });
      expect(calls.map((call) => call.text)).toEqual(['تجربة']);
    } finally {
      await hub.close();
    }
  });

  it("send-test fills the step's variables like the run does, and refuses while any has no value", async () => {
    fakePorts();
    const hub = await signedInHub();
    try {
      const targets = [{ platform: 'telegram', chat_id: '-1001' }];
      const analysis = { ...send([], 'تحليل: {{input}}'), id: 'analysis', title: 'Analysis' };
      delete (analysis as { send?: unknown }).send;
      const template = 'النتيجة: {{steps.analysis.output}} — {{input}}';
      const id = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          name: 'Send',
          nodes: [analysis, send(targets, template)],
          edges: [{ id: 'e1', from: 'analysis', to: 'tell', route: 'success' }],
        },
      });
      expect(id.statusCode, id.body).toBe(201);
      // The run itself: the variables filled, exactly as before this change.
      const run = await runOnce(hub, (id.json() as Json).id as string, 'تم');
      expect(run.status).toBe('succeeded');
      expect(calls.map((call) => call.text)).toEqual(['النتيجة: تحليل: تم — تم']);
      calls.length = 0;

      const test = (payload: Json) =>
        authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows/send-test',
          payload: { text: template, send: { targets }, ...payload },
        });

      // An older client sends the raw words: refused, naming what is missing — never
      // `{{steps.analysis.output}}` on the phone.
      const raw = await test({});
      expect(raw.statusCode, raw.body).toBe(400);
      expect(raw.json()).toMatchObject({
        code: 'bad_request',
        details: { reason: 'template_unresolved', unresolved: ['steps.analysis.output', 'input'] },
      });
      const partly = await test({ values: { input: 'x' } });
      expect(partly.json()).toMatchObject({ details: { unresolved: ['steps.analysis.output'] } });
      expect(calls).toEqual([]);

      // Typed values.
      const typed = await test({ values: { 'steps.analysis.output': 'عينة', input: 'يدوي' } });
      expect(typed.statusCode, typed.body).toBe(200);
      expect(calls.map((call) => call.text)).toEqual(['النتيجة: عينة — يدوي']);

      // The last run's values, with a typed one over it.
      calls.length = 0;
      const fromRun = await test({ workflow_run_id: run.id });
      expect(fromRun.statusCode, fromRun.body).toBe(200);
      const over = await test({ workflow_run_id: run.id, values: { input: 'بديل' } });
      expect(over.statusCode, over.body).toBe(200);
      expect(calls.map((call) => call.text)).toEqual([
        'النتيجة: تحليل: تم — تم',
        'النتيجة: تحليل: تم — بديل',
      ]);

      // "Test this step" hands back what each variable reads as in that run.
      const step = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows/test-step',
        payload: { node: send(targets, template), workflow_run_id: run.id },
      });
      expect(step.statusCode, step.body).toBe(200);
      expect(step.json()).toMatchObject({
        rendered: 'النتيجة: تحليل: تم — تم',
        values: { 'steps.analysis.output': 'تحليل: تم', input: 'تم' },
      });

      // A run that is not there is a 404, not a guess.
      const ghost = await test({ workflow_run_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' });
      expect(ghost.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  });
});
