/**
 * Writing into a channel conversation from the hub (contract decision §153), without Hermes:
 *
 * - the words the channel and Hermes get, and how a message the hub put in is read back
 *   (`origin: hub`, its author, its words without the prefix);
 * - `ChannelSends`, the hub's record of each message while it follows it: the order (posted on
 *   the channel, then handed to Hermes — and nothing handed when the channel refuses), what
 *   cannot be written into and why, and every step after (Hermes took it, the turn began and
 *   ended, or why not);
 * - the routes through a hub, with the hub's real bridge and its plugin protocol driven over
 *   HTTP as the plugin in Hermes's gateway drives it, and a Telegram Bot API on this machine.
 *
 * The same path against the real Hermes is `channel-sends.real.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../index.js';
import { listWorkspacesFor, principalScopeResolver } from '../auth/index.js';
import { channelBridgeFor } from '../agents/index.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { TEST_ADMIN_PASSWORD, testHub, type TestHub } from '../../../tests/unit/helpers.js';
import {
  ChannelConversations,
  hubAuthorOf,
  hubMessageText,
  registerChannelSource,
  toMessages,
  type HermesMessage,
  type HermesSessionRow,
} from './channel-conversations.js';
import {
  ChannelSends,
  registerChannelSender,
  type ChannelOutgoing,
  type ChannelSender,
} from './channel-sends.js';
import { createSessionsModule } from './index.js';
import { scriptedChannels, type ScriptedProfile } from './testing/scripted-channels.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const T0 = 1_790_000_000;
const CHAT = '20261008_091500_aa11bb22';
const OLD = '20261001_080000_00aa00aa';
const KEY = 'agent:main:telegram:dm:5550001';

function row(id: string, at: number, extra: Partial<HermesSessionRow> = {}): HermesSessionRow {
  return {
    id,
    source: 'telegram',
    session_key: KEY,
    user_id: '5550001',
    chat_id: '5550001',
    chat_type: 'dm',
    display_name: 'أحمد',
    origin_json: JSON.stringify({ platform: 'telegram', chat_id: '5550001' }),
    message_count: 2,
    started_at: at,
    last_active: at + 30,
    ...extra,
  };
}

function profiles(): Record<string, ScriptedProfile> {
  return {
    default: {
      sessions: [
        row(CHAT, T0 + 100),
        // An older conversation of the same chat (a `/new` since): messages go to the newer one.
        row(OLD, T0 - 1000),
        // WhatsApp's cloud API: not written into from the hub yet.
        row('20261008_070000_cc33dd44', T0 + 50, {
          source: 'whatsapp_cloud',
          session_key: 'agent:main:whatsapp_cloud:dm:966500000000',
          chat_id: '966500000000',
        }),
        // A forum topic: the hub's post goes into the topic.
        row('20261008_060000_ff00ff00', T0 + 10, {
          session_key: 'agent:main:telegram:group:-1001:77',
          chat_id: '-1001',
          chat_type: 'group',
          origin_json: JSON.stringify({ platform: 'telegram', chat_id: '-1001', thread_id: '77' }),
        }),
      ],
      messages: {
        [CHAT]: [
          { id: 1, role: 'user', content: 'متى موعد التسليم؟', timestamp: T0 + 100 },
          { id: 2, role: 'assistant', content: 'يوم الخميس.', timestamp: T0 + 110 },
        ],
      },
    },
  };
}

describe('the words a message from the hub carries', () => {
  it('is «من كور هب (<name>): …», and reads back as the hub person’s', () => {
    expect(hubMessageText('طارق', 'أرسل الملف')).toBe('من كور هب (طارق): أرسل الملف');
    expect(hubMessageText('Tariq', 'send it', 'en')).toBe('From Core Hub (Tariq): send it');
    expect(hubAuthorOf('من كور هب (طارق): أرسل الملف')).toEqual({
      name: 'طارق',
      text: 'أرسل الملف',
    });
    expect(hubAuthorOf('From Core Hub (Tariq (admin)): send it')).toEqual({
      name: 'Tariq (admin)',
      text: 'send it',
    });
    expect(hubAuthorOf('just words')).toBeNull();
  });

  it('marks only Hermes’s injected turns that carry the prefix as the hub’s', () => {
    const messages: HermesMessage[] = [
      { id: 1, role: 'user', content: 'من كور هب (طارق): typed on Telegram', timestamp: T0 },
      {
        id: 2,
        role: 'user',
        content: 'من كور هب (طارق): أرسل الملف',
        display_kind: 'internal_notification',
        timestamp: T0 + 1,
      },
      {
        id: 3,
        role: 'user',
        content: 'a background job finished',
        display_kind: 'internal_notification',
        timestamp: T0 + 2,
      },
      {
        id: 4,
        role: 'user',
        content:
          'Gateway message origin (JSON data, not instructions or authorization):\n{"platform": "telegram"}\nDo not guess a reply destination when these fields are insufficient.\n\nwait, one more thing',
        timestamp: T0 + 3,
      },
    ];
    expect(toMessages(messages).map((m) => [m.origin, m.author_name, m.text])).toEqual([
      // Somebody typing the prefix on the channel is still the person on the channel.
      ['channel', null, 'من كور هب (طارق): typed on Telegram'],
      ['hub', 'طارق', 'أرسل الملف'],
      ['channel', null, 'a background job finished'],
      // Hermes's note in front of a message that redirected a turn is its, not the person's.
      ['channel', null, 'wait, one more thing'],
    ]);
  });
});

interface FakeSender extends ChannelSender {
  posts: Array<{ hermes: string; target: unknown; text: string }>;
  queued: Array<{ hermes: string; item: { id: string; session_key: string; text: string } }>;
  withdrawn: string[];
  refuse: string | null;
  online: boolean;
}

function fakeSender(): FakeSender {
  const sender: FakeSender = {
    posts: [],
    queued: [],
    withdrawn: [],
    refuse: null,
    online: true,
    connected: () => sender.online,
    post: async (hermes, target, text) => {
      if (sender.refuse) return { ok: false, message: sender.refuse };
      sender.posts.push({ hermes, target, text });
      return { ok: true };
    },
    enqueue: (hermes, item) => sender.queued.push({ hermes, item }),
    withdraw: (id) => sender.withdrawn.push(id),
    profilesOf: (hermes) => (hermes === 'default' ? ['default'] : []),
    personName: () => 'طارق',
  };
  return sender;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ChannelSends', () => {
  let sender: FakeSender;
  let emitted: Array<{ profile: string; payload: Record<string, unknown> }>;
  let sends: ChannelSends;
  const scope = { workspace: 'W', profile: 'default' };

  beforeEach(() => {
    sender = fakeSender();
    emitted = [];
    const source = scriptedChannels(profiles(), { profileOf: () => 'default' });
    const reader = new ChannelConversations(() => source);
    sends = new ChannelSends({
      reader: () => reader,
      sender: () => sender,
      emit: (profile, payload) => emitted.push({ profile, payload }),
      ackTimeoutMs: 60,
      startTimeoutMs: 60,
    });
  });

  // A test's timers end with it: another test's message must not fail into this one's list.
  afterEach(() => sends.close());

  const statuses = () =>
    emitted
      .map((each) => each.payload.outgoing as ChannelOutgoing | null)
      .filter((each): each is ChannelOutgoing => each !== null)
      .map((each) => (each.error ? `${each.status}:${each.error.reason}` : each.status));
  const admin = { name: 'طارق', admin: true };

  it('posts on the channel first, then hands the same words to Hermes', async () => {
    const outgoing = await sends.send(
      scope,
      CHAT,
      { text: '  أرسل الملف  ', client_message_id: 'c1' },
      admin,
    );
    expect(outgoing).toMatchObject({
      conversation_id: CHAT,
      client_message_id: 'c1',
      text: 'أرسل الملف',
      author_name: 'طارق',
      status: 'posted',
    });
    expect(sender.posts).toEqual([
      {
        hermes: 'default',
        target: { platform: 'telegram', chatId: '5550001', threadId: null },
        text: 'من كور هب (طارق): أرسل الملف',
      },
    ]);
    expect(sender.queued).toEqual([
      {
        hermes: 'default',
        item: { id: outgoing.id, session_key: KEY, text: 'من كور هب (طارق): أرسل الملف' },
      },
    ]);
    expect(emitted[0]).toMatchObject({
      profile: 'default',
      payload: { conversation_id: CHAT, channel: 'telegram', reason: 'outgoing' },
    });
  });

  it('hands nothing to Hermes when the channel refuses, and says so in its words', async () => {
    sender.refuse = 'Forbidden: bot was blocked by the user';
    const refused = await sends
      .send(scope, CHAT, { text: 'hello' }, admin)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HubError);
    expect(refused).toMatchObject({
      code: 'service_unavailable',
      details: { reason: 'channel_send_failed', message: 'Forbidden: bot was blocked by the user' },
    });
    expect(sender.queued).toEqual([]);
    expect(emitted).toEqual([]);
    expect(sends.outgoingFor('default', CHAT, [])).toEqual([]);
  });

  it('refuses before posting what cannot be written into', async () => {
    const reason = (id: string, who = admin) =>
      sends.send(scope, id, { text: 'x' }, who).then(
        () => 'sent',
        (error: HubError) => [error.code, (error.details as { reason: string }).reason],
      );
    expect(await reason(CHAT, { name: 'm', admin: false })).toEqual(['forbidden', 'not_admin']);
    expect(await reason('20261008_070000_cc33dd44')).toEqual([
      'state_invalid',
      'platform_unsupported',
    ]);
    expect(await reason(OLD)).toEqual(['state_invalid', 'not_current']);
    expect(await reason('no_such_conversation')).toEqual(['not_found', undefined]);
    sender.online = false;
    expect(await reason(CHAT)).toEqual(['service_unavailable', 'bridge_offline']);
    expect(sender.posts).toEqual([]);
  });

  it('says beforehand what the caller may do (`can_send`)', () => {
    const route = {
      source: 'telegram',
      sessionKey: KEY,
      chatId: '5550001',
      threadId: null,
      currentId: null,
    };
    expect(sends.checkFor(true)('default', route)).toEqual({
      can_send: true,
      send_unavailable: null,
      current_id: null,
    });
    expect(sends.checkFor(false)('default', route).send_unavailable).toBe('not_admin');
    expect(sends.checkFor(true)('default', { ...route, currentId: CHAT })).toEqual({
      can_send: false,
      send_unavailable: 'not_current',
      current_id: CHAT,
    });
    expect(sends.checkFor(true)('default', { ...route, sessionKey: null }).send_unavailable).toBe(
      'no_route',
    );
    sender.online = false;
    expect(sends.checkFor(true)('default', route).send_unavailable).toBe('bridge_offline');
    expect(sends.live(['default'])).toBe(false);
  });

  it('follows it: taken by Hermes, the turn begins and ends, the transcript has it', async () => {
    const outgoing = await sends.send(scope, CHAT, { text: 'أرسل الملف' }, admin);
    sends.acknowledged('default', outgoing.id, true, null);
    // A turn for somebody else's words in the same chat changes nothing of this message.
    sends.turn('default', {
      event: 'turn_started',
      platform: 'telegram',
      session_id: CHAT,
      text: 'other',
    });
    sends.turn('default', {
      event: 'turn_ended',
      platform: 'telegram',
      session_id: CHAT,
      outcome: 'completed',
    });
    sends.turn('default', {
      event: 'turn_started',
      platform: 'telegram',
      session_id: CHAT,
      text: 'من كور هب (طارق): أرسل الملف',
    });
    sends.turn('default', {
      event: 'turn_ended',
      platform: 'telegram',
      session_id: CHAT,
      outcome: 'completed',
    });
    expect(statuses()).toEqual(['posted', 'delivered', 'answering', 'answered']);
    // Every turn is announced, the hub's message or not.
    expect(emitted.filter((e) => e.payload.reason === 'turn_started')).toHaveLength(2);
    await settle(150); // no timer fires once it is answered
    expect(statuses()).toEqual(['posted', 'delivered', 'answering', 'answered']);
    // Still listed until the transcript has it; then done.
    expect(sends.outgoingFor('default', CHAT, [])).toEqual([
      expect.objectContaining({
        id: outgoing.id,
        status: 'answered',
        session_id: CHAT,
        message_id: null,
      }),
    ]);
    const transcript = toMessages([
      {
        id: 7,
        role: 'user',
        content: 'من كور هب (طارق): أرسل الملف',
        display_kind: 'internal_notification',
        timestamp: Date.now() / 1000,
      },
    ]);
    expect(sends.outgoingFor('default', CHAT, transcript)).toEqual([]);
  });

  it('says why when Hermes does not take it, or takes it and runs no turn', async () => {
    const lost = await sends.send(scope, CHAT, { text: 'one' }, admin);
    await settle(150);
    expect(sender.withdrawn).toEqual([lost.id]);
    const refused = await sends.send(scope, CHAT, { text: 'two' }, admin);
    sends.acknowledged('default', refused.id, false, 'no such conversation');
    const dropped = await sends.send(scope, CHAT, { text: 'three' }, admin);
    sends.acknowledged('default', dropped.id, true, null);
    await settle(150);
    const listed = sends.outgoingFor('default', CHAT, []);
    expect(listed.map((each) => [each.text, each.status, each.error?.reason])).toEqual([
      ['one', 'failed', 'bridge_no_answer'],
      ['two', 'failed', 'not_accepted'],
      ['three', 'failed', 'not_picked_up'],
    ]);
    expect(listed[1]!.error).toEqual({ reason: 'not_accepted', message: 'no such conversation' });
  });

  it('waits, not fails, while the conversation is busy with another turn', async () => {
    sends.turn('default', {
      event: 'turn_started',
      platform: 'telegram',
      session_id: CHAT,
      text: 'long',
    });
    const queued = await sends.send(scope, CHAT, { text: 'after it' }, admin);
    sends.acknowledged('default', queued.id, true, null);
    await settle(200);
    expect(sends.outgoingFor('default', CHAT, [])[0]?.status).toBe('delivered');
    sends.turn('default', { event: 'turn_ended', platform: 'telegram', session_id: CHAT });
    sends.turn('default', {
      event: 'turn_started',
      platform: 'telegram',
      session_id: CHAT,
      text: 'من كور هب (طارق): after it',
    });
    expect(sends.outgoingFor('default', CHAT, [])[0]?.status).toBe('answering');
  });
});

/** Telegram's `sendMessage` on this machine: what the hub posted, or a refusal. */
function fakeTelegram() {
  const posted: Array<Record<string, unknown>> = [];
  const state = { refuse: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (state.refuse) {
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat not found',
          }),
        );
        return;
      }
      posted.push({ url: req.url, ...(JSON.parse(raw) as Record<string, unknown>) });
      res.end(JSON.stringify({ ok: true, result: { message_id: posted.length } }));
    });
  });
  return { server, posted, state };
}

describe('writing from the hub: the routes and the plugin protocol', () => {
  const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-bridge-home-'));
  const telegram = fakeTelegram();
  let hub: TestHub;
  let owner = '';
  let member = '';
  let key = '';
  let previous: ReturnType<typeof registerChannelSource>;
  let previousSender: ReturnType<typeof registerChannelSender> | undefined;
  let store: Record<string, ScriptedProfile>;

  const call = (
    token: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    profile = 'default',
  ) =>
    hub.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'x-hub-profile': profile },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const login = async (username: string, password: string) =>
    (
      (
        await hub.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password },
        })
      ).json() as { access_token: string }
    ).access_token;

  beforeAll(async () => {
    await new Promise<void>((resolve) => telegram.server.listen(0, '127.0.0.1', resolve));
    const port = (telegram.server.address() as AddressInfo).port;
    store = profiles();
    previous = registerChannelSource((app) =>
      scriptedChannels(store, {
        profileOf: (workspace) =>
          listWorkspacesFor(requireSqlite(app.hub.database), { id: '', role: 'owner' }).some(
            (each) => each.id === workspace && each.isDefault,
          )
            ? 'default'
            : null,
      }),
    );
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      {
        HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
        COREHUB_TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
      },
      {
        modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)),
        agents: { channelBridgeRoot: home },
      },
    );
    owner = await login('admin', TEST_ADMIN_PASSWORD);
    const person = await call(owner, 'POST', '/auth/users', {
      username: 'mem',
      password: 'mem-password-1',
      role: 'member',
      profiles: ['default'],
    });
    expect(person.statusCode, person.body).toBe(201);
    member = await login('mem', 'mem-password-1');
    // The plugin, as the hub writes it into the Hermes it runs; Telegram's bot in its `.env`.
    channelBridgeFor(hub.app).syncAll();
    const { appendFileSync } = await import('node:fs');
    appendFileSync(path.join(home, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n');
    key = (
      JSON.parse(
        readFileSync(path.join(home, 'plugins', 'corehub-bridge', 'hub.json'), 'utf8'),
      ) as {
        key: string;
      }
    ).key;
  });

  afterAll(async () => {
    registerChannelSource(previous);
    if (previousSender !== undefined) registerChannelSender(previousSender);
    await hub.close();
    telegram.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  const plugin = (method: 'GET' | 'POST', url: string, payload?: unknown, bearer = key) =>
    hub.app.inject({
      method,
      url: `/api/v1/hub-mcp/channel-bridge${url}`,
      headers: { authorization: `Bearer ${bearer}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  it('refuses the plugin’s calls without its key', async () => {
    for (const [method, url, payload] of [
      ['GET', '/outbox?wait=0', undefined],
      ['POST', '/outbox/01J8QK3ZR2W7M5N4P6T8V9X0QG/ack', { accepted: true }],
      ['POST', '/events', { event: 'turn_started', platform: 'telegram', session_id: CHAT }],
    ] as const) {
      expect((await plugin(method, url, payload, 'hub_bridge_nope')).statusCode).toBe(401);
      expect((await plugin(method, url, payload, owner)).statusCode).toBe(401);
    }
  });

  it('says the bridge is offline until the gateway’s plugin polls, and who may write', async () => {
    const before = (await call(owner, 'GET', '/channel-conversations')).json() as {
      items: Array<{ id: string; can_send: boolean; send_unavailable: string | null }>;
      live_updates: boolean;
    };
    expect(before.live_updates).toBe(false);
    expect(before.items.find((c) => c.id === CHAT)).toMatchObject({
      can_send: false,
      send_unavailable: 'bridge_offline',
    });
    expect((await plugin('GET', '/outbox?wait=0')).json()).toEqual({ items: [] });
    const after = (await call(owner, 'GET', '/channel-conversations')).json() as {
      items: Array<{
        id: string;
        can_send: boolean;
        send_unavailable: string | null;
        current_id: string | null;
      }>;
      live_updates: boolean;
    };
    expect(after.live_updates).toBe(true);
    const of = (id: string) => after.items.find((c) => c.id === id);
    expect(of(CHAT)).toMatchObject({ can_send: true, send_unavailable: null, current_id: null });
    expect(of(OLD)).toMatchObject({
      can_send: false,
      send_unavailable: 'not_current',
      current_id: CHAT,
    });
    expect(of('20261008_070000_cc33dd44')).toMatchObject({
      send_unavailable: 'platform_unsupported',
    });
    const asMember = (await call(member, 'GET', '/channel-conversations')).json() as {
      items: Array<{ id: string; can_send: boolean; send_unavailable: string | null }>;
    };
    expect(asMember.items.find((c) => c.id === CHAT)).toMatchObject({
      can_send: false,
      send_unavailable: 'not_admin',
    });
    const refused = await call(member, 'POST', `/channel-conversations/${CHAT}/messages`, {
      text: 'hi',
    });
    expect(refused.statusCode).toBe(403);
    expect(telegram.posted).toEqual([]);
  });

  it('posts on Telegram, hands the plugin the item, and follows the turn it reports', async () => {
    await plugin('GET', '/outbox?wait=0');
    // Telegram refuses: nothing for the plugin.
    telegram.state.refuse = true;
    const refused = await call(owner, 'POST', `/channel-conversations/${CHAT}/messages`, {
      text: 'لن يصل',
    });
    telegram.state.refuse = false;
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({
      details: { reason: 'channel_send_failed', message: 'Bad Request: chat not found' },
    });
    expect((await plugin('GET', '/outbox?wait=0')).json()).toEqual({ items: [] });

    // The plugin is waiting when the message is written: it is answered at once.
    const waiting = plugin('GET', '/outbox?wait=5');
    const sent = await call(owner, 'POST', `/channel-conversations/${CHAT}/messages`, {
      text: 'أرسل الملف',
      client_message_id: 'c-9',
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const outgoing = (sent.json() as { outgoing: ChannelOutgoing }).outgoing;
    expect(outgoing).toMatchObject({
      status: 'posted',
      author_name: 'Admin',
      client_message_id: 'c-9',
    });
    expect(telegram.posted).toEqual([
      expect.objectContaining({
        url: '/bot123:abc/sendMessage',
        chat_id: '5550001',
        text: 'من كور هب (Admin): أرسل الملف',
      }),
    ]);
    const items = (await waiting).json() as {
      items: Array<{ id: string; session_key: string; text: string }>;
    };
    expect(items).toEqual({
      items: [{ id: outgoing.id, session_key: KEY, text: 'من كور هب (Admin): أرسل الملف' }],
    });

    expect(
      (await plugin('POST', `/outbox/${outgoing.id}/ack`, { accepted: true, reason: null }))
        .statusCode,
    ).toBe(204);
    // Answered once only.
    expect(
      (await plugin('POST', `/outbox/${outgoing.id}/ack`, { accepted: true })).statusCode,
    ).toBe(404);
    const report = (event: Record<string, unknown>) => plugin('POST', '/events', event);
    expect(
      (
        await report({
          event: 'turn_started',
          platform: 'telegram',
          session_id: CHAT,
          sender_id: '5550001',
          text: 'من كور هب (Admin): أرسل الملف',
          outcome: null,
        })
      ).statusCode,
    ).toBe(204);
    const during = (await call(owner, 'GET', `/channel-conversations/${CHAT}/messages`)).json() as {
      outgoing: ChannelOutgoing[];
      live_updates: boolean;
    };
    expect(during.live_updates).toBe(true);
    expect(during.outgoing).toEqual([
      expect.objectContaining({ id: outgoing.id, status: 'answering', session_id: CHAT }),
    ]);

    // Hermes stores the turn as its plugin's, then the agent's reply.
    store.default!.messages![CHAT]!.push(
      {
        id: 3,
        role: 'user',
        content: 'من كور هب (Admin): أرسل الملف',
        display_kind: 'internal_notification',
        timestamp: Date.now() / 1000,
      },
      { id: 4, role: 'assistant', content: 'أرسلته.', timestamp: Date.now() / 1000 + 1 },
    );
    await report({
      event: 'turn_ended',
      platform: 'telegram',
      session_id: CHAT,
      outcome: 'completed',
    });
    const done = (await call(owner, 'GET', `/channel-conversations/${CHAT}/messages`)).json() as {
      conversation: { id: string; channel: string };
      items: Array<{
        id: string;
        role: string;
        text: string;
        origin: string;
        author_name: string | null;
      }>;
      outgoing: ChannelOutgoing[];
    };
    expect(done.conversation).toMatchObject({ id: CHAT, channel: 'telegram' });
    expect(done.items.slice(-2).map((m) => [m.role, m.origin, m.author_name, m.text])).toEqual([
      ['user', 'hub', 'Admin', 'أرسل الملف'],
      ['assistant', 'channel', null, 'أرسلته.'],
    ]);
    expect(done.outgoing).toEqual([]);
  });

  it('posts into the forum topic the conversation is in', async () => {
    await plugin('GET', '/outbox?wait=0');
    telegram.posted.length = 0;
    const sent = await call(
      owner,
      'POST',
      '/channel-conversations/20261008_060000_ff00ff00/messages',
      {
        text: 'to the topic',
      },
    );
    expect(sent.statusCode, sent.body).toBe(202);
    expect(telegram.posted).toEqual([
      expect.objectContaining({
        chat_id: '-1001',
        message_thread_id: 77,
        text: 'من كور هب (Admin): to the topic',
      }),
    ]);
  });

  it('answers 409 for an older conversation of the chat, naming the current one', async () => {
    await plugin('GET', '/outbox?wait=0');
    const old = await call(owner, 'POST', `/channel-conversations/${OLD}/messages`, { text: 'x' });
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ details: { reason: 'not_current', current_id: CHAT } });
    const empty = await call(owner, 'POST', `/channel-conversations/${CHAT}/messages`, {
      text: '',
    });
    expect(empty.statusCode).toBe(400);
  });

  it('refuses with hermes_not_managed where the hub has no bridge', async () => {
    previousSender = registerChannelSender(() => null);
    try {
      const sent = await call(owner, 'POST', `/channel-conversations/${CHAT}/messages`, {
        text: 'x',
      });
      expect(sent.statusCode).toBe(503);
      expect(sent.json()).toMatchObject({ details: { reason: 'hermes_not_managed' } });
      const listed = (await call(owner, 'GET', '/channel-conversations')).json() as {
        items: Array<{ id: string; send_unavailable: string | null }>;
      };
      expect(listed.items.find((c) => c.id === CHAT)?.send_unavailable).toBe('hermes_not_managed');
    } finally {
      registerChannelSender(previousSender);
      previousSender = undefined;
    }
  });
});
