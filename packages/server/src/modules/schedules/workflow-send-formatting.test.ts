/**
 * Telegram formatting of a "Send message" step (DECISIONS §137), end to end through the hub,
 * against a fake Telegram that checks `parse_mode` and parses the markup as Telegram does
 * (`testing/fake-telegram.ts`): plain sends no `parse_mode`; HTML and MarkdownV2 arrive
 * formatted; a refusal of the markup fails the step in words that name the mode, with no
 * message id; a long formatted message goes in parts that are each valid; a rerun sends only
 * the parts that did not go; an older workflow stays plain; "Send test message" uses the
 * step's formatting; the formatting is kept when an older app saves the step without it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authed, capturingLogger, signedInHub } from '../../../tests/unit/helpers.js';
import { registerWorkflowPorts, workflowEngineFor } from './index.js';
import { fakeTelegram, type FakeTelegram } from './testing/fake-telegram.js';
import type { MessagePorts } from './workflow-engine.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZformat012';
const CHAT = '-1001234567890';

let previous: ReturnType<typeof registerWorkflowPorts> | undefined;
const notices: Array<{ title: string; body: string | null }> = [];

/** The hub's ports with the fake Telegram; `wrap` may stand in front of it (a failing part). */
function withTelegram(telegram: FakeTelegram, wrap?: (inner: typeof fetch) => typeof fetch) {
  const messages: MessagePorts = {
    telegramToken: () => TOKEN,
    telegramApi: 'http://telegram.test',
    fetch: wrap ? wrap(telegram.fetch) : telegram.fetch,
    post: async () => ({ sessionId: 'x', messageId: 'M', recreated: false, title: null }),
  };
  previous = registerWorkflowPorts(() => ({
    agentTurn: null,
    notice: (_scope, input) => void notices.push(input),
    messages,
  }));
}
afterEach(() => {
  if (previous !== undefined) registerWorkflowPorts(previous);
  previous = undefined;
  notices.length = 0;
});

const step = (target: Json, input: string) => ({
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
  send: { targets: [target] },
});

async function workflow(hub: Hub, nodes: unknown[]) {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: { name: 'Formatting', nodes, edges: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as Json).id as string;
}

async function run(hub: Hub, id: string, input = 'تم') {
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

const outputOf = (done: { steps: Array<Json> }) =>
  JSON.parse(String(done.steps[0]!.output)) as Json;

describe('Telegram formatting of a Send message step', () => {
  it('plain sends no parse_mode at all, and the tags arrive as written', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [
        step(
          { platform: 'telegram', chat_id: CHAT, formatting: 'plain' },
          '<b>اختبار</b> {{input}}',
        ),
      ]);
      const done = await run(hub, id);
      expect(done.status).toBe('succeeded');
      expect(telegram.requests).toHaveLength(1);
      expect(telegram.requests[0]!.body).not.toHaveProperty('parse_mode');
      expect(telegram.sent[0]).toMatchObject({ plain: '<b>اختبار</b> تم', entities: [] });
      expect(outputOf(done)).toMatchObject({
        status: 'sent',
        formatting: 'plain',
        parse_mode: null,
        chat_id: CHAT,
        parts_count: 1,
        message_ids: ['9000'],
      });
    } finally {
      await hub.close();
    }
  });

  it('an older step without the field stays plain: no parse_mode, nothing rewritten', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [
        step({ platform: 'telegram', chat_id: CHAT }, '*نجمة* {{input}}'),
      ]);
      const done = await run(hub, id);
      expect(done.status).toBe('succeeded');
      expect(telegram.requests[0]!.body).not.toHaveProperty('parse_mode');
      expect(telegram.sent[0]!.plain).toBe('*نجمة* تم');
      expect(outputOf(done)).toMatchObject({ formatting: 'plain', parse_mode: null });
      const saved = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflows/${id}` })
      ).json() as { nodes: Array<{ send: { targets: Json[] } }> };
      expect(saved.nodes[0]!.send.targets[0]).not.toHaveProperty('formatting');
    } finally {
      await hub.close();
    }
  });

  it('HTML arrives bold with its link, after the variables are filled', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [
        step(
          { platform: 'telegram', chat_id: CHAT, formatting: 'html' },
          '<b>{{input}}</b> — <a href="https://example.com/r?a=1&amp;b=2">التقرير</a>',
        ),
      ]);
      const done = await run(hub, id, 'اكتمل');
      expect(done.status).toBe('succeeded');
      expect(telegram.requests[0]!.body).toMatchObject({ parse_mode: 'HTML' });
      expect(telegram.sent[0]).toMatchObject({
        parse_mode: 'HTML',
        plain: 'اكتمل — التقرير',
        entities: [
          { type: 'bold', offset: 0, length: 5 },
          { type: 'text_link', offset: 8, length: 7, url: 'https://example.com/r?a=1&b=2' },
        ],
      });
      expect(outputOf(done)).toMatchObject({
        status: 'sent',
        formatting: 'html',
        parse_mode: 'HTML',
        chat_id: CHAT,
        parts_count: 1,
        message_id: '9000',
        message_ids: ['9000'],
        targets: [
          {
            target: `telegram:${CHAT}`,
            platform: 'telegram',
            formatting: 'html',
            parse_mode: 'HTML',
            status: 'sent',
            parts_count: 1,
            message_ids: ['9000'],
          },
        ],
      });
    } finally {
      await hub.close();
    }
  });

  it('MarkdownV2 arrives formatted, never as the legacy Markdown', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [
        step(
          { platform: 'telegram', chat_id: CHAT, formatting: 'markdown_v2' },
          '*عريض* و _مائل_ و [رابط](https://example.com) انتهى\\.',
        ),
      ]);
      const done = await run(hub, id);
      expect(done.status).toBe('succeeded');
      expect(telegram.requests[0]!.body).toMatchObject({ parse_mode: 'MarkdownV2' });
      expect(telegram.sent[0]).toMatchObject({
        plain: 'عريض و مائل و رابط انتهى.',
        entities: [
          { type: 'bold', offset: 0, length: 4 },
          { type: 'italic', offset: 7, length: 4 },
          { type: 'text_link', offset: 14, length: 4, url: 'https://example.com' },
        ],
      });
      expect(outputOf(done)).toMatchObject({ formatting: 'markdown_v2', parse_mode: 'MarkdownV2' });
    } finally {
      await hub.close();
    }
  });

  it('markup Telegram refuses fails the step in words naming the mode, with no message id', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      const id = await workflow(hub, [
        step({ platform: 'telegram', chat_id: CHAT, formatting: 'html' }, '<b>لم يغلق {{input}}'),
      ]);
      const done = await run(hub, id);
      expect(done.status).toBe('failed');
      const reason =
        'Telegram HTML formatting failed: can\'t parse entities: Can\'t find end tag corresponding to start tag "b"';
      expect(done.steps[0]).toMatchObject({
        status: 'failed',
        error: `telegram:${CHAT}: ${reason}`,
      });
      expect(outputOf(done)).toMatchObject({
        status: 'failed',
        message_id: null,
        message_ids: [],
        formatting: 'html',
        parse_mode: 'HTML',
        failures: [{ target: `telegram:${CHAT}`, reason }],
        targets: [{ status: 'failed', message_ids: [], reason }],
      });
      // Never sent again as plain text behind the person's back.
      expect(telegram.requests).toHaveLength(1);
      expect(telegram.sent).toEqual([]);
      expect(notices[0]).toMatchObject({ title: 'Send: not sent' });

      const md = await workflow(hub, [
        step({ platform: 'telegram', chat_id: CHAT, formatting: 'markdown_v2' }, 'نقطة غير مهربة.'),
      ]);
      const mdDone = await run(hub, md);
      expect(String(mdDone.steps[0]!.error)).toContain(
        "Telegram MarkdownV2 formatting failed: can't parse entities: Character '.' is reserved",
      );
    } finally {
      await hub.close();
    }
  });

  it('a long HTML message goes in valid parts, bold closed and reopened; a rerun sends only what did not go', async () => {
    const telegram = fakeTelegram();
    // The second part is refused once (Telegram busy), then taken.
    let refusedOnce = false;
    withTelegram(
      telegram,
      (inner) =>
        (async (url, init) => {
          if (telegram.sent.length === 1 && !refusedOnce) {
            refusedOnce = true;
            return Response.json(
              { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1' },
              { status: 429 },
            );
          }
          return inner(url, init);
        }) as typeof fetch,
    );
    const hub = await signedInHub();
    try {
      const long = 'تقرير مفصل عن المهمة '.repeat(300).trim(); // ~6300 counted
      const id = await workflow(hub, [
        step(
          { platform: 'telegram', chat_id: CHAT, formatting: 'html' },
          `<b>${long}</b> {{input}}`,
        ),
      ]);
      const first = await run(hub, id);
      expect(first.status).toBe('failed');
      expect(String(first.steps[0]!.error)).toContain('part 2 of 2: Too Many Requests');
      expect(outputOf(first)).toMatchObject({
        status: 'failed',
        message_id: null,
        parts_count: 2,
        targets: [{ status: 'failed', message_ids: ['9000'], parts_count: 2 }],
      });
      expect(telegram.sent).toHaveLength(1);

      const again = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/workflow-runs/${first.id}/rerun`,
        payload: { from_node_id: 'tell' },
      });
      expect(again.statusCode, again.body).toBe(202);
      await workflowEngineFor(hub.app).settled();
      const rerun = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/workflow-runs/${(again.json() as { workflow_run_id: string }).workflow_run_id}`,
        })
      ).json() as Json & { steps: Json[]; status: string };
      expect(rerun.status).toBe('succeeded');
      // Part 1 was not sent twice.
      expect(telegram.sent).toHaveLength(2);
      expect(outputOf(rerun)).toMatchObject({
        status: 'sent',
        parts_count: 2,
        message_ids: ['9000', '9001'],
      });
      const [one, two] = telegram.sent;
      expect(one!.text.startsWith('<b>')).toBe(true);
      expect(one!.text.endsWith('</b>')).toBe(true);
      expect(two!.text.startsWith('<b>')).toBe(true);
      for (const part of telegram.sent) {
        expect(part.parse_mode).toBe('HTML');
        expect(part.plain.length).toBeLessThanOrEqual(4096);
        expect(part.entities[0]).toMatchObject({ type: 'bold', offset: 0 });
      }
      expect(`${one!.plain} ${two!.plain}`).toBe(`${long} تم`);
    } finally {
      await hub.close();
    }
  });

  it('refuses a formatting it does not know when saved and when tested, and keeps it when an older app saves', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      for (const bad of ['HTML', 'Markdown', 'markdown', '']) {
        const check = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows/validate',
          payload: {
            nodes: [step({ platform: 'telegram', chat_id: CHAT, formatting: bad }, 'x')],
            edges: [],
          },
        });
        expect((check.json() as { problems: Json[] }).problems.map((p) => p.code)).toEqual([
          'send_formatting_unknown',
        ]);
        const tested = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows/send-test',
          payload: {
            text: 'x',
            send: { targets: [{ platform: 'telegram', chat_id: CHAT, formatting: bad }] },
          },
        });
        expect(tested.statusCode).toBe(400);
        expect(tested.json()).toMatchObject({
          details: { reason: 'send_invalid', problems: [{ code: 'send_formatting_unknown' }] },
        });
      }
      expect(telegram.requests).toEqual([]);

      const id = await workflow(hub, [
        step({ platform: 'telegram', chat_id: CHAT, formatting: 'html' }, '<b>x</b>'),
      ]);
      // An older phone rebuilds the target from the chat id, without the field.
      const older = step({ platform: 'telegram', chat_id: '-1009' }, '<b>y</b>');
      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${id}`,
        payload: { nodes: [older], edges: [] },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((saved.json() as { nodes: Array<{ send: Json }> }).nodes[0]!.send).toEqual({
        targets: [{ platform: 'telegram', chat_id: '-1009', formatting: 'html' }],
      });
      // `null` says plain on purpose.
      const plain = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/workflows/${id}`,
        payload: {
          nodes: [step({ platform: 'telegram', chat_id: '-1009', formatting: null }, 'y')],
          edges: [],
        },
      });
      expect((plain.json() as { nodes: Array<{ send: Json }> }).nodes[0]!.send).toEqual({
        targets: [{ platform: 'telegram', chat_id: '-1009', formatting: null }],
      });
    } finally {
      await hub.close();
    }
  });

  it('Send test message uses the chosen formatting, and the log says it without the token', async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const captured = capturingLogger();
    const hub = await signedInHub({}, { logger: captured.logger });
    try {
      const test = (formatting: string | undefined, text: string) =>
        authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/workflows/send-test',
          payload: {
            text,
            send: {
              targets: [
                { platform: 'telegram', chat_id: CHAT, ...(formatting ? { formatting } : {}) },
              ],
            },
            node_id: 'notify_1',
          },
        });
      const html = await test('html', '<b>اختبار</b>');
      expect(html.statusCode, html.body).toBe(200);
      expect(html.json()).toMatchObject({
        status: 'sent',
        formatting: 'html',
        parse_mode: 'HTML',
        parts_count: 1,
      });
      expect(telegram.sent[0]).toMatchObject({
        parse_mode: 'HTML',
        plain: 'اختبار',
        entities: [{ type: 'bold', offset: 0, length: 6 }],
      });

      const plain = await test('plain', '<b>اختبار</b>');
      expect(plain.json()).toMatchObject({ status: 'sent', formatting: 'plain', parse_mode: null });
      expect(telegram.requests[1]!.body).not.toHaveProperty('parse_mode');
      expect(telegram.sent[1]).toMatchObject({ plain: '<b>اختبار</b>', entities: [] });

      const absent = await test(undefined, 'بلا تنسيق');
      expect(absent.json()).toMatchObject({ formatting: 'plain', parse_mode: null });
      expect(telegram.requests[2]!.body).not.toHaveProperty('parse_mode');

      const broken = await test('html', '<i>مائل');
      expect(broken.json()).toMatchObject({
        status: 'failed',
        message_id: null,
        failures: [
          {
            reason: expect.stringMatching(/^Telegram HTML formatting failed: can't parse entities/),
          },
        ],
      });

      expect(captured.lines).toContainEqual(
        expect.objectContaining({
          msg: 'workflow send test',
          chat_id: CHAT,
          formatting: 'html',
          parse_mode: 'HTML',
          parts_count: 1,
          status: 'sent',
        }),
      );
      expect(captured.lines).toContainEqual(
        expect.objectContaining({
          msg: 'workflow send test failed',
          formatting: 'html',
          error: expect.stringContaining('Telegram HTML formatting failed'),
        }),
      );
      expect(JSON.stringify(captured.lines)).not.toContain(TOKEN.split(':')[1]!);
    } finally {
      await hub.close();
    }
  });

  it("a failure alert is always plain: the hub's own words may hold markup characters", async () => {
    const telegram = fakeTelegram();
    withTelegram(telegram);
    const hub = await signedInHub();
    try {
      const res = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/workflows',
        payload: {
          name: 'Alert <x>',
          nodes: [step({ platform: 'telegram', chat_id: '-100404', formatting: 'html' }, 'x')],
          edges: [],
          on_failure: {
            inbox: false,
            send: { targets: [{ platform: 'telegram', chat_id: CHAT, formatting: 'html' }] },
          },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const done = await run(hub, (res.json() as Json).id as string);
      expect(done.status).toBe('failed');
      await workflowEngineFor(hub.app).settled();
      const alert = telegram.requests.find((each) => each.body.chat_id === CHAT)!;
      expect(alert.body).not.toHaveProperty('parse_mode');
      expect(String(alert.body.text)).toContain('Alert <x>');
    } finally {
      await hub.close();
    }
  });
});
