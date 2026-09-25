/**
 * "Continue in Core Hub" (contract decision §58): a Telegram conversation Hermes keeps becomes
 * an ordinary hub chat in the same profile, with the transcript as the caller's attachment and
 * a first message for the client to send.
 *
 * The words (pure) first; then the route, through a hub whose Hermes is scripted as in
 * `channel-conversations.test.ts` and whose files are the real `knowledge` store — so the
 * transcript is downloaded back and read, and the first message is sent as a real run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../index.js';
import { attachmentsPort } from '../knowledge/index.js';
import { principalScopeResolver } from '../auth/index.js';
import { TEST_ADMIN_PASSWORD, testHub, type TestHub } from '../../../tests/unit/helpers.js';
import {
  continuationTitle,
  summaryOf,
  transcriptOf,
  type ChannelRead,
} from './channel-continuation.js';
import { registerChannelSource, type HermesMessage } from './channel-conversations.js';
import { createSessionsModule } from './index.js';
import { scriptedChannels } from './testing/scripted-channels.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const CONVERSATION = '20260925_091500_aa11bb22';
const T0 = 1_790_000_000;

const read = (extra: Partial<ChannelRead> = {}): ChannelRead => ({
  conversation: {
    id: CONVERSATION,
    profile: 'default',
    channel: 'telegram',
    title: 'موعد التسليم',
    peer_name: 'أحمد',
    peer_id: '5550001',
    chat_type: 'dm',
    last_message: { role: 'assistant', text: 'يوم الخميس.' },
    preview: 'متى موعد التسليم؟',
    message_count: 2,
    started_at: '2026-09-25T09:15:00Z',
    last_message_at: '2026-09-25T09:20:41Z',
  },
  items: [
    { id: '1', role: 'user', text: 'متى موعد التسليم؟', created_at: '2026-09-25T09:15:00Z' },
    { id: '2', role: 'assistant', text: 'يوم **الخميس**.', created_at: '2026-09-25T09:20:41Z' },
  ],
  has_more: false,
  ...extra,
});

describe('continue in Core Hub: the words', () => {
  it('writes the transcript oldest first, naming who said what', () => {
    const file = transcriptOf(read(), 'en');
    expect(file.name).toBe('telegram-أحمد.md');
    expect(file.text).toBe(
      [
        '# Telegram — أحمد',
        '',
        '2 messages, 2026-09-25 09:15 – 2026-09-25 09:20 UTC · profile default',
        '',
        'موعد التسليم',
        '',
        '**أحمد** — 2026-09-25 09:15 UTC',
        '',
        'متى موعد التسليم؟',
        '',
        '**Agent** — 2026-09-25 09:20 UTC',
        '',
        'يوم **الخميس**.',
        '',
      ].join('\n'),
    );
    expect(transcriptOf(read(), 'ar').text).toContain('# تيليجرام — أحمد');
    expect(transcriptOf(read(), 'ar').text).toContain('**الوكيل** — 2026-09-25 09:20 UTC');
  });

  it("summarises in the person's language, says when only the latest are there, and adds the note", () => {
    expect(summaryOf(read(), 'en', null)).toBe(
      'Let’s continue here a Telegram conversation with “أحمد” (2 messages, 2026-09-25 09:15 – 2026-09-25 09:20 UTC). The full transcript is in the attached file; read it first.',
    );
    const arabic = summaryOf(read({ has_more: true }), 'ar', '  جهّز ردًّا.  ');
    expect(arabic).toBe(
      'نكمل هنا محادثة من تيليجرام مع «أحمد» (2 رسالة، من 2026-09-25 09:15 إلى 2026-09-25 09:20 بتوقيت UTC). نصّها كاملًا في الملف المرفق؛ اقرأه أولًا. فيه آخر 2 رسالة منها فقط.\n\nجهّز ردًّا.',
    );
    expect(continuationTitle(read(), 'ar')).toBe('تيليجرام: أحمد');
    // A platform with no name of its own is still named.
    const other = read();
    other.conversation = { ...other.conversation, channel: 'qqbot', peer_name: null };
    expect(continuationTitle(other, 'en')).toBe('Qqbot: موعد التسليم');
  });
});

describe('continue in Core Hub: the route', () => {
  let hub: TestHub;
  let token = '';
  let previous: ReturnType<typeof registerChannelSource>;
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, language = 'en') =>
    hub.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hub-profile': 'default',
        'accept-language': language,
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  beforeAll(async () => {
    const talk: HermesMessage[] = [
      { id: 1, role: 'user', content: 'متى موعد التسليم؟', timestamp: T0 },
      { id: 2, role: 'tool', content: '{"ok": true}', timestamp: T0 + 1 },
      { id: 3, role: 'assistant', content: 'يوم **الخميس**.', timestamp: T0 + 60 },
    ];
    previous = registerChannelSource(() =>
      scriptedChannels(
        {
          default: {
            sessions: [
              {
                id: CONVERSATION,
                source: 'telegram',
                user_id: '5550001',
                chat_id: '5550001',
                chat_type: 'dm',
                display_name: 'أحمد',
                origin_json: null,
                title: null,
                message_count: 3,
                started_at: T0,
                last_active: T0 + 60,
                preview: 'متى موعد التسليم؟',
              },
            ],
            messages: { [CONVERSATION]: talk },
          },
        },
        { profileOf: () => 'default' },
      ),
    );
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({
        script: [{ type: 'message_delta', text: 'قرأتها.' }, { type: 'completed' }],
      }),
      attachments: attachmentsPort,
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    token = (login.json() as { access_token: string }).access_token;
  });
  afterAll(async () => {
    registerChannelSource(previous);
    await hub.close();
  });

  it('makes a chat in the same profile, keeps the transcript, and answers the first message', async () => {
    const answer = await call(
      'POST',
      `/channel-conversations/${CONVERSATION}/continue`,
      { agent_id: AGENT_ID, note: 'جهّز له ردًّا.' },
      'ar',
    );
    expect(answer.statusCode, answer.body).toBe(201);
    const body = answer.json() as {
      session: Record<string, unknown>;
      first_message: Array<Record<string, unknown>>;
    };
    expect(body.session).toMatchObject({
      profile: 'default',
      agent_id: AGENT_ID,
      source: 'chat',
      title: 'تيليجرام: أحمد',
      message_count: 0,
      active_run_id: null,
    });
    const [text, file] = body.first_message;
    expect(text).toMatchObject({ type: 'text' });
    expect(String(text!.text)).toMatch(/^نكمل هنا محادثة من تيليجرام مع «أحمد» \(2 رسالة/);
    expect(String(text!.text).endsWith('\n\nجهّز له ردًّا.')).toBe(true);
    expect(file).toMatchObject({ type: 'file', name: 'telegram-أحمد.md' });
    expect(String(file!.mime)).toMatch(/^text\/markdown/);

    // The transcript is a file of the caller's, readable back: the channel's words, no tool.
    const bytes = await call('GET', `/attachments/${String(file!.attachment_id)}/content`);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toContain('# تيليجرام — أحمد');
    expect(bytes.body).toContain('متى موعد التسليم؟');
    expect(bytes.body).toContain('يوم **الخميس**.');
    expect(bytes.body).not.toContain('"ok"');

    // Nothing ran: the client sends the first message. Sent as it is, it is a real turn.
    const sent = await call('POST', `/sessions/${String(body.session.id)}/runs`, {
      content: body.first_message,
    });
    expect(sent.statusCode, sent.body).toBe(202);
  });

  it('refuses an unknown conversation or agent before writing anything', async () => {
    const before = ((await call('GET', '/sessions')).json() as { items: unknown[] }).items.length;
    const missing = await call('POST', '/channel-conversations/20260101_000000_deadbeef/continue', {
      agent_id: AGENT_ID,
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { details: Record<string, unknown> }).details).toMatchObject({
      resource: 'channel_conversation',
    });
    const nobody = await call('POST', `/channel-conversations/${CONVERSATION}/continue`, {
      agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
    });
    expect(nobody.statusCode).toBe(404);
    const bad = await call('POST', `/channel-conversations/${CONVERSATION}/continue`, {});
    expect(bad.statusCode).toBe(400);
    const after = ((await call('GET', '/sessions')).json() as { items: unknown[] }).items.length;
    expect(after).toBe(before);
  });
});
