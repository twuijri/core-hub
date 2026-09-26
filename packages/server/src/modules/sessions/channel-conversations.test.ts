/**
 * Channel conversations (contract decision §61): what the hub reads of Hermes's Telegram and
 * WhatsApp conversations, against a scripted Hermes that answers as Hermes's server does.
 *
 * The reader: how a Hermes row becomes a `ChannelConversation`, that the hub's own chats (the
 * TUI source) never show, that Hermes is asked again only when its store changed, and why a
 * profile is missing when it is. Then the routes, through a hub: one profile, every profile the
 * caller may enter (`profiles=all`), and one conversation's transcript.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
      has_more: false,
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
    // The page before, from where this one stopped (§102).
    expect(opened.next_offset).toBe(500);
    const older = await new ChannelConversations(() => hermes).messages(
      { workspace: 'w', profile: 'home' },
      '20260925_091500_aa11bb22',
      500,
    );
    expect(older.items.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${i}`),
    );
    expect(older.has_more).toBe(false);
    expect(older.next_offset).toBeNull();
    expect(hermes.calls.at(-1)).toContain('order=latest&limit=500&offset=500');
  });

  it('reads past Hermes’s page of 100 when asked for more, and says when there is more (§102)', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      telegram(`20260925_1${String(i).padStart(5, '0')}_aa`, T0 + i),
    );
    const hermes = scriptedChannels(
      { default: { sessions: many } },
      { profileOf: () => 'default' },
    );
    const reader = new ChannelConversations(() => hermes);
    const scopes = [{ workspace: 'w', profile: 'home' }];
    const first = await reader.list(scopes);
    expect(first.items).toHaveLength(100);
    expect(first.has_more).toBe(true);
    // The newest first: the oldest fifty are the ones left out.
    expect(first.items.at(-1)?.id).toBe('20260925_100050_aa');
    const lists = () => hermes.calls.filter((call) => call.startsWith('/api/sessions?'));
    expect(lists()).toHaveLength(1);
    expect(lists()[0]).not.toContain('offset');

    const more = await reader.list(scopes, undefined, 200);
    expect(more.items).toHaveLength(150);
    expect(more.has_more).toBe(false);
    expect(lists().at(-1)).toContain('offset=100');
    // Asked for less again: what was read is enough, and nothing is asked of Hermes.
    const before = lists().length;
    expect((await reader.list(scopes)).items).toHaveLength(100);
    expect(lists()).toHaveLength(before);
  });

  it("shows the person's pictures and drops Hermes's notes about them (§102)", async () => {
    const hermes = scriptedChannels(
      {
        default: {
          sessions: [telegram('20260925_091500_aa11bb22', T0)],
          messages: {
            '20260925_091500_aa11bb22': talk(
              // Handed to a model that sees pictures (`build_native_content_parts`).
              [
                'user',
                'هذه الفاتورة\n\n[Image attached at: /root/.hermes/cache/images/img_a1b2c3d4e5f6.jpg]\n[screenshot]',
              ],
              // Described in words first (`_enrich_message_with_vision`).
              [
                'user',
                "[The user sent an image~ Here's what I can see:\nA receipt [total 40].]\n[If you need a closer look, use vision_analyze with image_url: /data/hermes/cache/images/img_0f0f0f0f0f0f.png ~]\n\nكم المجموع؟",
              ],
              // A picture with no words: Hermes's own caption is not the person's.
              [
                'user',
                'What do you see in this image?\n\n[Image attached at: /x/image_cache/img_999999999999.webp]',
              ],
              ['user', '[User sent an image: /x/cache/images/../../etc/passwd]'],
              ['assistant', 'المجموع ٤٠. [Image attached at: /x/y.png]'],
            ),
          },
          pictures: { 'img_a1b2c3d4e5f6.jpg': '/tmp/img_a1b2c3d4e5f6.jpg' },
        },
      },
      { profileOf: () => 'default' },
    );
    const reader = new ChannelConversations(() => hermes);
    const scope = { workspace: 'w', profile: 'home' };
    const opened = await reader.messages(scope, '20260925_091500_aa11bb22');
    expect(opened.items.map((m) => [m.text, m.attachments])).toEqual([
      ['هذه الفاتورة', [{ id: 'img_a1b2c3d4e5f6.jpg', kind: 'image', available: true }]],
      ['كم المجموع؟', [{ id: 'img_0f0f0f0f0f0f.png', kind: 'image', available: false }]],
      ['', [{ id: 'img_999999999999.webp', kind: 'image', available: false }]],
      // Not a picture's name, so not a picture; the words are left as Hermes kept them.
      ['[User sent an image: /x/cache/images/../../etc/passwd]', []],
      // The agent's words are the agent's: nothing is taken out of them.
      ['المجموع ٤٠. [Image attached at: /x/y.png]', []],
    ]);
    expect(reader.picture(scope, '20260925_091500_aa11bb22', 'img_a1b2c3d4e5f6.jpg')).toBe(
      '/tmp/img_a1b2c3d4e5f6.jpg',
    );
    const code = (name: string) => {
      try {
        reader.picture(scope, '20260925_091500_aa11bb22', name);
        return 'ok';
      } catch (error) {
        return error instanceof HubError ? error.code : String(error);
      }
    };
    expect(code('img_0f0f0f0f0f0f.png')).toBe('not_found'); // Hermes deleted it
    expect(code('..%2Fetc%2Fpasswd')).toBe('not_found');
    expect(code('notes.txt')).toBe('not_found');
  });
});

describe('channel conversations: the routes', () => {
  const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
  let hub: TestHub;
  let owner = '';
  let member = '';
  let previous: ReturnType<typeof registerChannelSource>;
  let hermesStore: Record<string, ScriptedProfile> = {};
  const hermesCalls: string[] = [];

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
    hermesStore = store();
    hermesStore.designer = {
      sessions: [telegram('20260925_120000_99887766', T0 + 500, { display_name: 'سارة' })],
    };
    previous = registerChannelSource((app) => {
      const source = scriptedChannels(hermesStore, {
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
      });
      // Every source made for a request writes what it asked into one list the tests read.
      const ask = source.get.bind(source);
      const remove = source.delete.bind(source);
      source.get = <T>(path: string) => {
        hermesCalls.push(`GET ${path}`);
        return ask<T>(path);
      };
      source.delete = <T>(path: string) => {
        hermesCalls.push(`DELETE ${path}`);
        return remove<T>(path);
      };
      return source;
    });
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

  it('serves a picture from Hermes’s image cache by its name only (§102)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-pictures-'));
    const file = path.join(dir, 'img_a1b2c3d4e5f6.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileSync(file, png);
    hermesStore.default!.pictures = { 'img_a1b2c3d4e5f6.png': file };
    try {
      const url = '/channel-conversations/20260925_091500_aa11bb22/pictures/img_a1b2c3d4e5f6.png';
      const got = await get(owner, url);
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.headers['cache-control']).toBe('private, no-store');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.rawPayload.equals(png)).toBe(true);
      const gone = await get(
        owner,
        '/channel-conversations/20260925_091500_aa11bb22/pictures/img_000000000000.png',
      );
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ details: { resource: 'channel_picture' } });
      // Another profile's cache is not this one's: a member of `designer` asks there.
      expect((await get(member, url, 'designer')).statusCode).toBe(404);
    } finally {
      delete hermesStore.default!.pictures;
      rmSync(dir, { recursive: true, force: true });
    }
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

  // ------------------------------------------------ hide and delete (§88)
  const send = (method: 'PUT' | 'DELETE', token: string, url: string, profile = 'default') =>
    hub.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'x-hub-profile': profile },
    });
  const ids = async (token: string, url: string, profile = 'default') =>
    (
      (await get(token, url, profile)).json() as {
        items: Array<{ id: string; hidden?: boolean }>;
      }
    ).items;

  it('hides one from the caller’s own list only, and shows it again', async () => {
    const DESIGNER = '20260925_120000_99887766';
    expect(
      (await send('PUT', owner, `/channel-conversations/${DESIGNER}/hidden`, 'designer'))
        .statusCode,
    ).toBe(204);
    // Hiding twice is fine.
    expect(
      (await send('PUT', owner, `/channel-conversations/${DESIGNER}/hidden`, 'designer'))
        .statusCode,
    ).toBe(204);
    expect((await ids(owner, '/channel-conversations', 'designer')).map((c) => c.id)).toEqual([]);
    expect(
      (await ids(owner, '/channel-conversations?profiles=all')).map((c) => c.id),
    ).not.toContain(DESIGNER);
    // Asked for, it is there, and says so.
    expect(await ids(owner, '/channel-conversations?hidden=include', 'designer')).toEqual([
      expect.objectContaining({ id: DESIGNER, hidden: true }),
    ]);
    // Someone else's list is theirs: the member still sees it, and Hermes was never told.
    expect((await ids(member, '/channel-conversations', 'designer')).map((c) => c.id)).toEqual([
      DESIGNER,
    ]);
    expect(hermesStore.designer?.sessions.map((row) => row.id)).toEqual([DESIGNER]);
    expect(hermesCalls.some((call) => call.startsWith('DELETE'))).toBe(false);

    expect(
      (await send('DELETE', owner, `/channel-conversations/${DESIGNER}/hidden`, 'designer'))
        .statusCode,
    ).toBe(204);
    const back = await ids(owner, '/channel-conversations', 'designer');
    expect(back.map((c) => c.id)).toEqual([DESIGNER]);
    expect(back[0]?.hidden).toBeUndefined();
    expect(
      (await send('PUT', owner, '/channel-conversations/..%2Fetc/hidden', 'designer')).statusCode,
    ).toBe(400);
  });

  it('deletes one from Hermes for an admin only, through Hermes’s own delete', async () => {
    const WHATSAPP = '20260925_080000_cc33dd44';
    const HUB_CHAT = '20260925_070000_ee55ff66';
    // A member may not; nothing reached Hermes.
    const refused = await send('DELETE', member, `/channel-conversations/${WHATSAPP}`, 'designer');
    expect(refused.statusCode).toBe(403);
    expect(hermesCalls.some((call) => call.startsWith('DELETE'))).toBe(false);

    // The hub's own chat runs in Hermes too: not a channel conversation, never deleted here.
    const hubChat = await send('DELETE', owner, `/channel-conversations/${HUB_CHAT}`);
    expect(hubChat.statusCode).toBe(404);
    expect(hubChat.json()).toMatchObject({ details: { resource: 'channel_conversation' } });
    // Nor a prefix Hermes would resolve to one.
    expect((await send('DELETE', owner, '/channel-conversations/20260925_08')).statusCode).toBe(
      404,
    );
    expect(hermesCalls.some((call) => call.startsWith('DELETE'))).toBe(false);

    // Hidden by the owner first: the mark goes with the conversation.
    await send('PUT', owner, `/channel-conversations/${WHATSAPP}/hidden`);
    const done = await send('DELETE', owner, `/channel-conversations/${WHATSAPP}`);
    expect(done.statusCode).toBe(204);
    expect(hermesCalls.filter((call) => call.startsWith('DELETE'))).toEqual([
      `DELETE /api/sessions/${WHATSAPP}?profile=default`,
    ]);
    expect(hermesStore.default?.sessions.map((row) => row.id)).not.toContain(WHATSAPP);
    // Gone from the list at once (what was read of the profile was dropped), hidden or not.
    expect(
      (await ids(owner, '/channel-conversations?hidden=include')).map((c) => c.id),
    ).not.toContain(WHATSAPP);
    // Deleted twice: it is not there any more.
    expect((await send('DELETE', owner, `/channel-conversations/${WHATSAPP}`)).statusCode).toBe(
      404,
    );
  });
});
