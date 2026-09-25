/**
 * Channel conversations (contract decision §61): what the hub reads of Hermes's Telegram and
 * WhatsApp conversations, against a scripted Hermes that answers as Hermes's server does.
 *
 * The reader: how a Hermes row becomes a `ChannelConversation`, that the hub's own chats (the
 * TUI source) never show, that Hermes is asked again only when its store changed, and why a
 * profile is missing when it is. Then the routes, through a hub: one profile, every profile the
 * caller may enter (`profiles=all`), and one conversation's transcript.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../index.js';
import { listWorkspacesFor, principalScopeResolver } from '../auth/index.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { TEST_ADMIN_PASSWORD, testHub, type TestHub } from '../../../tests/unit/helpers.js';
import {
  ChannelConversations,
  LAST_MESSAGES_PER_CALL,
  MAX_AGE_MS,
  MIN_REFRESH_MS,
  TTL_MS,
  registerChannelSource,
  type HermesMessage,
  type HermesSessionRow,
} from './channel-conversations.js';
import { createSessionsModule } from './index.js';
import { scriptedChannels, type ScriptedProfile } from './testing/scripted-channels.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const T0 = 1_790_000_000; // 2026-09-21T…, epoch seconds as Hermes stores them

function telegram(id: string, at: number, extra: Partial<HermesSessionRow> = {}): HermesSessionRow {
  return {
    id,
    source: 'telegram',
    user_id: '5550001',
    chat_id: '5550001',
    chat_type: 'dm',
    display_name: 'أحمد',
    origin_json: JSON.stringify({ platform: 'telegram', user_name: 'ahmad_k', chat_id: '5550001' }),
    title: null,
    message_count: 4,
    started_at: at - 60,
    last_active: at,
    preview: 'متى موعد التسليم؟',
    ...extra,
  };
}

const talk = (...lines: Array<[string, unknown, number?]>): HermesMessage[] =>
  lines.map(([role, content, at], index) => ({
    id: index + 1,
    role,
    content,
    timestamp: at ?? T0 + index,
  }));

function store(): Record<string, ScriptedProfile> {
  return {
    default: {
      sessions: [
        telegram('20260925_091500_aa11bb22', T0 + 100),
        {
          ...telegram('20260925_080000_cc33dd44', T0 + 50),
          source: 'whatsapp_cloud',
          display_name: null,
          user_id: null,
          chat_id: '966500000000@s.whatsapp.net',
          origin_json: JSON.stringify({ chat_name: 'مجموعة العائلة', chat_type: 'group' }),
          chat_type: null,
          title: 'ترتيبات الرحلة',
        },
        // The hub's own chat, run in Hermes through the TUI: never a channel conversation.
        { ...telegram('20260925_070000_ee55ff66', T0 + 200), source: 'tui' },
      ],
      messages: {
        '20260925_091500_aa11bb22': talk(
          ['user', 'متى موعد التسليم؟'],
          ['assistant', null],
          ['tool', '{"ok": true}'],
          ['assistant', [{ type: 'text', text: 'يوم **الخميس**.' }, { type: 'image_url' }]],
        ),
        '20260925_080000_cc33dd44': talk(['user', 'نسافر الساعة كم؟']),
        '20260925_070000_ee55ff66': talk(['user', 'secret hub chat']),
      },
    },
  };
}

describe('channel conversations: the reader', () => {
  it('maps Hermes rows, keeps channels only, and reads each latest message', async () => {
    const hermes = scriptedChannels(store(), { profileOf: () => 'default' });
    const reader = new ChannelConversations(() => hermes);
    const { items, unavailable } = await reader.list([{ workspace: 'w', profile: 'home' }]);
    expect(unavailable).toEqual([]);
    expect(items.map((c) => c.id)).toEqual([
      '20260925_091500_aa11bb22',
      '20260925_080000_cc33dd44',
    ]);
    expect(items[0]).toEqual({
      id: '20260925_091500_aa11bb22',
      profile: 'home',
      channel: 'telegram',
      title: null,
      peer_name: 'أحمد',
      peer_id: '5550001',
      chat_type: 'dm',
      last_message: { role: 'assistant', text: 'يوم **الخميس**.' },
      preview: 'متى موعد التسليم؟',
      message_count: 4,
      started_at: new Date((T0 + 40) * 1000).toISOString().replace('.000Z', 'Z'),
      last_message_at: new Date((T0 + 100) * 1000).toISOString().replace('.000Z', 'Z'),
    });
    // WhatsApp's cloud API is WhatsApp; a group is named as the channel names it.
    expect(items[1]).toMatchObject({
      channel: 'whatsapp',
      title: 'ترتيبات الرحلة',
      peer_name: 'مجموعة العائلة',
      peer_id: '966500000000@s.whatsapp.net',
      chat_type: 'group',
      last_message: { role: 'user', text: 'نسافر الساعة كم؟' },
    });
    // Asked for channel sources only, and the hub's TUI chat was never read.
    expect(hermes.calls[0]).toContain('sources=telegram%2Cwhatsapp%2Cwhatsapp_cloud');
    expect(hermes.calls.some((c) => c.includes('ee55ff66'))).toBe(false);

    const onlyWhatsApp = await reader.list([{ workspace: 'w', profile: 'home' }], 'whatsapp');
    expect(onlyWhatsApp.items.map((c) => c.channel)).toEqual(['whatsapp']);
  });

  it('asks Hermes again only when its store changed, and never more than every few seconds', async () => {
    let now = 1_000_000;
    const hermes = scriptedChannels(store(), { profileOf: () => 'default' });
    const reader = new ChannelConversations(() => hermes, { now: () => now });
    const scope = [{ workspace: 'w', profile: 'home' }];
    const lists = () => hermes.calls.filter((c) => c.startsWith('/api/sessions?')).length;

    await reader.list(scope);
    expect(lists()).toBe(1);
    now += MIN_REFRESH_MS + TTL_MS; // long past the plain TTL: the stamp is what decides
    await reader.list(scope);
    expect(lists()).toBe(1);

    // A Telegram message arrives: Hermes writes its store.
    hermes.profiles.default!.sessions.push(telegram('20260925_101010_12345678', T0 + 300));
    hermes.touch('default');
    await reader.list(scope);
    expect(lists()).toBe(2);
    hermes.touch('default');
    now += 1_000;
    await reader.list(scope); // changed again, but too soon to ask
    expect(lists()).toBe(2);
    now += MIN_REFRESH_MS;
    const later = await reader.list(scope);
    expect(lists()).toBe(3);
    expect(later.items[0]?.id).toBe('20260925_101010_12345678');

    now += MAX_AGE_MS - 1;
    await reader.list(scope); // unchanged: what was read stands…
    expect(lists()).toBe(3);
    now += 2;
    await reader.list(scope); // …until it is old enough to be asked for once more anyway
    expect(lists()).toBe(4);
  });

  it('keeps what it read for a short while when the store cannot be told apart', async () => {
    let now = 1_000_000;
    const hermes = scriptedChannels(store(), { profileOf: () => 'default', stamps: false });
    const reader = new ChannelConversations(() => hermes, { now: () => now });
    const lists = () => hermes.calls.filter((c) => c.startsWith('/api/sessions?')).length;
    await reader.list([{ workspace: 'w', profile: 'home' }]);
    now += TTL_MS - 1;
    await reader.list([{ workspace: 'w', profile: 'home' }]);
    expect(lists()).toBe(1);
    now += 2;
    await reader.list([{ workspace: 'w', profile: 'home' }]);
    expect(lists()).toBe(2);
  });

  it('reads a bounded number of latest messages per call', async () => {
    const many = Array.from({ length: LAST_MESSAGES_PER_CALL + 5 }, (_, i) =>
      telegram(`20260925_0000${String(i).padStart(2, '0')}_abcdef00`, T0 + i),
    );
    const messages = Object.fromEntries(many.map((row) => [row.id, talk(['user', 'مرحبا'])]));
    const hermes = scriptedChannels(
      { default: { sessions: many, messages } },
      { profileOf: () => 'default' },
    );
    const reader = new ChannelConversations(() => hermes);
    const reads = () => hermes.calls.filter((c) => c.includes('/messages')).length;
    const first = await reader.list([{ workspace: 'w', profile: 'home' }]);
    expect(reads()).toBe(LAST_MESSAGES_PER_CALL);
    // The rest show Hermes's preview meanwhile.
    expect(first.items.filter((c) => c.last_message === null)).toHaveLength(5);
  });

  it('says why a profile is missing, and keeps what it had when Hermes stops answering', async () => {
    expect(
      await new ChannelConversations(() => null).list([{ workspace: 'w', profile: 'p' }]),
    ).toEqual({
      items: [],
      unavailable: [{ profile: null, reason: 'hermes_not_managed', message: null }],
    });

    let now = 1_000_000;
    const hermes = scriptedChannels(store(), {
      profileOf: (workspace) => (workspace === 'w-home' ? 'default' : null),
    });
    const reader = new ChannelConversations(() => hermes, { now: () => now });
    const scopes = [
      { workspace: 'w-home', profile: 'home' },
      { workspace: 'w-new', profile: 'fresh' },
    ];
    const first = await reader.list(scopes);
    expect(first.items).toHaveLength(2);
    expect(first.unavailable).toEqual([
      { profile: 'fresh', reason: 'profile_not_in_hermes', message: null },
    ]);

    hermes.down = true;
    hermes.touch('default');
    now += MIN_REFRESH_MS + 1;
    const stale = await reader.list(scopes);
    expect(stale.items).toHaveLength(2);
    expect(stale.unavailable).toContainEqual({
      profile: 'home',
      reason: 'hermes_unreachable',
      message: 'connect ECONNREFUSED 127.0.0.1',
    });
  });

  it('opens a channel conversation only, oldest first, without tools', async () => {
    const hermes = scriptedChannels(store(), { profileOf: () => 'default' });
    const reader = new ChannelConversations(() => hermes);
    const scope = { workspace: 'w', profile: 'home' };
    const opened = await reader.messages(scope, '20260925_091500_aa11bb22');
    expect(opened.items).toEqual([
      expect.objectContaining({ id: '1', role: 'user', text: 'متى موعد التسليم؟' }),
      expect.objectContaining({ id: '4', role: 'assistant', text: 'يوم **الخميس**.' }),
    ]);
    expect(opened.has_more).toBe(false);
    expect(opened.conversation).toMatchObject({ profile: 'home', peer_name: 'أحمد' });

    const code = async (id: string) =>
      reader.messages(scope, id).then(
        () => 'ok',
        (error: unknown) => (error instanceof HubError ? error.code : String(error)),
      );
    expect(await code('20260925_070000_ee55ff66')).toBe('not_found'); // the hub's own chat
    expect(await code('nope_not_there')).toBe('not_found');
    expect(await code('../etc/passwd')).toBe('not_found');
    hermes.down = true;
    expect(await code('20260925_091500_aa11bb22')).toBe('service_unavailable');
    expect(
      await new ChannelConversations(() => null).messages(scope, 'x').catch((e) => e.code),
    ).toBe('service_unavailable');
  });

  it('says there is more when Hermes returned a full page', async () => {
    const long = talk(
      ...Array.from({ length: 520 }, (_, i): [string, string] => ['user', `m${i}`]),
    );
    const hermes = scriptedChannels(
      {
        default: {
          sessions: [telegram('20260925_091500_aa11bb22', T0)],
          messages: { '20260925_091500_aa11bb22': long },
        },
      },
      { profileOf: () => 'default' },
    );
    const opened = await new ChannelConversations(() => hermes).messages(
      { workspace: 'w', profile: 'home' },
      '20260925_091500_aa11bb22',
    );
    expect(opened.items).toHaveLength(500);
    expect(opened.items.at(-1)?.text).toBe('m519');
    expect(opened.has_more).toBe(true);
  });
});

describe('channel conversations: the routes', () => {
  const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
  let hub: TestHub;
  let owner = '';
  let member = '';
  let previous: ReturnType<typeof registerChannelSource>;

  const get = (token: string, url: string, profile = 'default') =>
    hub.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'x-hub-profile': profile },
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
    const hermesStore = store();
    hermesStore.designer = {
      sessions: [telegram('20260925_120000_99887766', T0 + 500, { display_name: 'سارة' })],
    };
    previous = registerChannelSource((app) =>
      scriptedChannels(hermesStore, {
        // The hub's rule, as the composition root has it: the default workspace is Hermes's
        // `default`, any other its slug.
        profileOf: (workspace) => {
          const row = listWorkspacesFor(requireSqlite(app.hub.database), {
            id: '',
            role: 'owner',
          }).find((each) => each.id === workspace);
          if (!row) return null;
          return row.isDefault ? 'default' : row.slug === 'designer' ? 'designer' : null;
        },
      }),
    );
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    owner = await login('admin', TEST_ADMIN_PASSWORD);
    for (const slug of ['designer', 'empty']) {
      const made = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/profiles',
        headers: { authorization: `Bearer ${owner}`, 'x-hub-profile': 'default' },
        payload: { slug, name: slug },
      });
      expect(made.statusCode).toBe(201);
    }
    const person = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/users',
      headers: { authorization: `Bearer ${owner}`, 'x-hub-profile': 'default' },
      payload: {
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['designer'],
      },
    });
    expect(person.statusCode).toBe(201);
    member = await login('mem', 'mem-password-1');
  });

  afterAll(async () => {
    registerChannelSource(previous);
    await hub.close();
  });

  it('lists the header profile, or every profile the caller may enter', async () => {
    const one = await get(owner, '/channel-conversations');
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      items: [
        { id: '20260925_091500_aa11bb22', profile: 'default', channel: 'telegram' },
        { id: '20260925_080000_cc33dd44', profile: 'default', channel: 'whatsapp' },
      ],
      unavailable: [],
    });

    const all = (await get(owner, '/channel-conversations?profiles=all')).json() as {
      items: Array<{ id: string; profile: string }>;
      unavailable: unknown[];
    };
    expect(all.items.map((c) => [c.profile, c.id])).toEqual([
      ['designer', '20260925_120000_99887766'],
      ['default', '20260925_091500_aa11bb22'],
      ['default', '20260925_080000_cc33dd44'],
    ]);
    expect(all.unavailable).toEqual([
      { profile: 'empty', reason: 'profile_not_in_hermes', message: null },
    ]);

    // A member reads the profiles they were given, whatever they ask for.
    const theirs = (
      await get(member, '/channel-conversations?profiles=all', 'designer')
    ).json() as {
      items: Array<{ profile: string }>;
    };
    expect(theirs.items.map((c) => c.profile)).toEqual(['designer']);
    expect((await get(member, '/channel-conversations', 'default')).statusCode).toBe(404);

    expect((await get(owner, '/channel-conversations?channel=Tele gram')).statusCode).toBe(400);
  });

  it('opens one conversation in its profile, and nothing else', async () => {
    const opened = await get(owner, '/channel-conversations/20260925_091500_aa11bb22/messages');
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      conversation: { id: '20260925_091500_aa11bb22', profile: 'default' },
      items: [{ role: 'user' }, { role: 'assistant' }],
      has_more: false,
    });
    // Another profile's conversation is not in this one.
    expect(
      (await get(owner, '/channel-conversations/20260925_120000_99887766/messages')).statusCode,
    ).toBe(404);
    expect(
      (await get(owner, '/channel-conversations/20260925_120000_99887766/messages', 'designer'))
        .statusCode,
    ).toBe(200);
    const hubChat = await get(owner, '/channel-conversations/20260925_070000_ee55ff66/messages');
    expect(hubChat.statusCode).toBe(404);
    expect(hubChat.json()).toMatchObject({
      code: 'not_found',
      details: { resource: 'channel_conversation' },
    });
  });
});
