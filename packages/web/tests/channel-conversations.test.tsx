/**
 * Telegram and WhatsApp conversations in the chats list (contract decision §61): Hermes keeps
 * them, the hub reads them read-only, and the web puts each in its channel's group («تيليجرام»،
 * «واتساب») and opens it as a transcript with no composer — only the banner saying where the
 * reply is made.
 *
 * The grouping and the wording are pure (`sessions/groups.ts`, `sessions/channels.ts`); the list
 * and the transcript are asserted by what a person sees and by the requests sent, which are the
 * contract. The hub's half is `modules/sessions/channel-conversations.test.ts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConversation as Conversation } from '../src/sessions/channels.js';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  once() {
    return this;
  }
  connect() {
    this.connected = true;
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {
    this.connected = false;
  }
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, connectNamespace: () => new FakeSocket() };
});

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { SessionList } = await import('../src/sessions/SessionList.js');
const { ChatScreen } = await import('../src/chat/ChatScreen.js');
const { groupSessions } = await import('../src/sessions/groups.js');
const channels = await import('../src/sessions/channels.js');
const { createTranslator } = await import('../src/i18n/index.js');

function conversation(
  id: string,
  channel: string,
  extra: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    profile: 'default',
    channel,
    title: null,
    peer_name: 'أحمد',
    peer_id: '5550001',
    chat_type: 'dm',
    last_message: { role: 'assistant', text: 'يوم **الخميس**.' },
    preview: 'متى موعد التسليم؟',
    message_count: 4,
    started_at: '2026-09-25T09:15:00Z',
    last_message_at: '2026-09-25T09:20:00Z',
    ...extra,
  };
}

const TG = conversation('20260925_091500_aa11bb22', 'telegram');
const WA = conversation('20260925_080000_cc33dd44', 'whatsapp', {
  peer_name: 'مجموعة العائلة',
  chat_type: 'group',
  last_message: { role: 'user', text: 'نسافر الساعة كم؟' },
});
const DISCORD = conversation('20260925_070000_ee55ff66', 'discord', { peer_name: 'dev-room' });

describe('channel conversations, pure', () => {
  it('fill their platform group: Telegram, then WhatsApp, then the others', () => {
    const groups = groupSessions([], [], { conversations: [DISCORD, WA, TG] });
    expect(groups.map((g) => [g.key, g.conversations?.map((c) => c.id) ?? null])).toEqual([
      ['channel:telegram', [TG.id]],
      ['channel:whatsapp', [WA.id]],
      ['channel:discord', [DISCORD.id]],
      ['rest', null],
    ]);
  });

  it('are named as a messaging app names a chat, and searched by name, title and text', () => {
    const t = createTranslator('ar');
    expect(channels.conversationTitle(TG, t)).toBe('أحمد');
    expect(channels.conversationTitle({ ...TG, peer_name: null, title: 'موعد التسليم' }, t)).toBe(
      'موعد التسليم',
    );
    expect(channels.conversationTitle({ ...TG, peer_name: null, peer_id: null }, t)).toBe(
      'محادثة على تيليجرام',
    );
    expect(channels.conversationPreview(TG, t)).toBe('الوكيل: يوم **الخميس**.');
    expect(channels.conversationPreview({ ...TG, last_message: null }, t)).toBe(
      'متى موعد التسليم؟',
    );
    expect(channels.matchesConversation(WA, 'العائلة')).toBe(true);
    expect(channels.matchesConversation(TG, 'الخميس')).toBe(true);
    expect(channels.matchesConversation(TG, 'nothing')).toBe(false);
  });

  it('open at the chat address, marked as a channel conversation, in their profile', () => {
    expect(channels.channelHref(TG.id, 'designer')).toBe(
      `/chat/${TG.id}?source=channel&profile=designer`,
    );
    expect(channels.isChannelAddress(new URLSearchParams('source=channel'))).toBe(true);
    expect(channels.isChannelAddress(new URLSearchParams(''))).toBe(false);
  });
});

// --------------------------------------------------------------------- on screen

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  profile: string | null;
}

function fakeHub(options: { unreachable?: boolean } = {}) {
  const seen: Seen[] = [];
  // The hub's per-person marks and Hermes's store, as the routes change them (§87).
  const hidden = new Set<string>();
  const gone = new Set<string>();
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const profile = new Headers(init?.headers).get('X-Hub-Profile');
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push({ method, path, query: url.searchParams, profile });
    if (path === '/profiles')
      return json({ items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'D' }] });
    const mark = /^\/channel-conversations\/([^/]+)\/hidden$/.exec(path);
    if (mark) {
      if (method === 'PUT') hidden.add(decodeURIComponent(mark[1]!));
      else hidden.delete(decodeURIComponent(mark[1]!));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const one = /^\/channel-conversations\/([^/]+)$/.exec(path);
    if (one && method === 'DELETE') {
      gone.add(decodeURIComponent(one[1]!));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/channel-conversations')
      return json({
        items: [TG, WA]
          .filter((c) => !gone.has(c.id))
          .filter((c) => url.searchParams.get('hidden') === 'include' || !hidden.has(c.id))
          .map((c) => (hidden.has(c.id) ? { ...c, hidden: true } : c)),
        unavailable: options.unreachable
          ? [{ profile: 'default', reason: 'hermes_unreachable', message: 'down' }]
          : [],
      });
    if (path === `/channel-conversations/${TG.id}/messages`)
      return json({
        conversation: TG,
        items: [
          { id: '1', role: 'user', text: 'متى موعد التسليم؟', created_at: TG.started_at },
          { id: '4', role: 'assistant', text: 'يوم **الخميس**.', created_at: TG.last_message_at },
        ],
        has_more: false,
      });
    if (path.startsWith('/channel-conversations/'))
      return json({ error: 'غير موجود', code: 'not_found' }, 404);
    return json({ items: [], next_cursor: null });
  };
  return { seen, fetchImpl };
}

function Providers({
  fetchImpl,
  path,
  role = 'owner',
  children,
}: {
  fetchImpl: typeof fetch;
  path: string;
  role?: 'owner' | 'member';
  children: React.ReactNode;
}) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role },
  });
  return (
    <ThemeProvider>
      <I18nProvider language="ar">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

const groupNamed = async (name: string) => {
  const groups = await screen.findAllByTestId('session-group');
  const found = groups.find(
    (g) => within(g).getByTestId('session-group-toggle').textContent?.includes(name) ?? false,
  );
  if (!found) throw new Error(`no group ${name}`);
  return found;
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('the chats list shows them in their channel group', () => {
  it('lists Telegram under «تيليجرام» and WhatsApp under «واتساب», read from every profile', async () => {
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat">
        <SessionList />
      </Providers>,
    );
    const telegram = await groupNamed('تيليجرام');
    const row = await within(telegram).findByTestId('channel-row');
    expect(row).toHaveTextContent('أحمد');
    expect(row).toHaveTextContent('الوكيل: يوم الخميس.');
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/chat/${TG.id}?source=channel`);
    expect(within(telegram).getByTestId('session-group-toggle')).toHaveTextContent('1');
    expect(within(await groupNamed('واتساب')).getByTestId('channel-row')).toHaveTextContent(
      'مجموعة العائلة',
    );
    // One person with one profile: the list asked for every profile they may enter anyway.
    const asked = hub.seen.find((c) => c.path === '/channel-conversations');
    expect(asked?.query.get('profiles')).toBe('all');
  });

  it('filters them with the chats, and leaves them out of the archive', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat">
        <SessionList />
      </Providers>,
    );
    await screen.findAllByTestId('channel-row');
    await user.type(screen.getByRole('searchbox'), 'العائلة');
    await waitFor(() => expect(screen.getAllByTestId('channel-row')).toHaveLength(1));
    expect(screen.getByTestId('channel-row')).toHaveTextContent('مجموعة العائلة');
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('radio', { name: 'المؤرشفة' }));
    await waitFor(() => expect(screen.queryAllByTestId('channel-row')).toHaveLength(0));
  });

  it('says so when Hermes did not answer', async () => {
    const hub = fakeHub({ unreachable: true });
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat">
        <SessionList />
      </Providers>,
    );
    expect(await screen.findByTestId('channel-unreachable')).toHaveTextContent('Hermes');
  });
});

describe('hiding one, and deleting one from Hermes (§87)', () => {
  const rowOf = async (id: string) =>
    (await screen.findAllByTestId('channel-row')).find((r) => r.dataset.conversationId === id)!;
  /** The row's own "More" menu, opened from the keyboard (see helpers/ui.ts). */
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, id: string) => {
    const more = within(await rowOf(id)).getByTestId('channel-more-button');
    more.focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('channel-more');
  };

  it('hides one from the person’s own list, and brings it back from "Show hidden"', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat">
        <SessionList />
      </Providers>,
    );
    await openMenu(user, TG.id);
    await user.click(await screen.findByRole('menuitem', { name: 'إخفاء من قائمتي' }));
    await waitFor(() =>
      expect(
        hub.seen.some(
          (c) => c.method === 'PUT' && c.path === `/channel-conversations/${TG.id}/hidden`,
        ),
      ).toBe(true),
    );
    // Gone from the list; WhatsApp stays. Hermes was not asked to delete anything.
    await waitFor(() =>
      expect(screen.getAllByTestId('channel-row').map((r) => r.dataset.conversationId)).toEqual([
        WA.id,
      ]),
    );
    expect(hub.seen.some((c) => c.method === 'DELETE')).toBe(false);

    const toggle = screen.getByTestId('channel-show-hidden');
    expect(toggle).toHaveTextContent('إظهار المحادثات المخفية (1)');
    await user.click(toggle);
    const back = await rowOf(TG.id);
    expect(back.dataset.hidden).toBe('true');
    await openMenu(user, TG.id);
    await user.click(await screen.findByRole('menuitem', { name: 'إظهار مرة أخرى' }));
    await waitFor(() =>
      expect(
        hub.seen.some(
          (c) => c.method === 'DELETE' && c.path === `/channel-conversations/${TG.id}/hidden`,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId('channel-show-hidden')).toBeNull());
  });

  it('deletes one from Hermes for an admin, after a confirmation that says it is permanent', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat">
        <SessionList />
      </Providers>,
    );
    await openMenu(user, WA.id);
    await user.click(await screen.findByRole('menuitem', { name: 'حذف من هرمز…' }));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('حذف «مجموعة العائلة» من هرمز؟');
    expect(dialog).toHaveTextContent('نهائيًا');
    expect(dialog).toHaveTextContent('لا يمكن استرجاعها');
    // Nothing is sent before the answer.
    expect(hub.seen.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'حذف نهائي' }));
    await waitFor(() =>
      expect(
        hub.seen.some((c) => c.method === 'DELETE' && c.path === `/channel-conversations/${WA.id}`),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('channel-row').map((r) => r.dataset.conversationId)).toEqual([
        TG.id,
      ]),
    );
  });

  it('offers a member hiding only: deleting from Hermes is an admin’s', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat" role="member">
        <SessionList />
      </Providers>,
    );
    await openMenu(user, TG.id);
    expect(await screen.findByRole('menuitem', { name: 'إخفاء من قائمتي' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'حذف من هرمز…' })).toBeNull();
    await user.keyboard('{Escape}');
    // The right-click offers the same, and no more.
    fireEvent.contextMenu(await rowOf(TG.id));
    const menu = await screen.findByTestId('channel-menu');
    expect(menu).toHaveTextContent('إخفاء من قائمتي');
    expect(menu).not.toHaveTextContent('حذف من هرمز');
  });

  it('puts the same actions in the open conversation’s bar', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path={`/chat/${TG.id}?source=channel`}>
        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatScreen />} />
        </Routes>
      </Providers>,
    );
    const bar = await screen.findByTestId('chat-header');
    expect(screen.getByTestId('topbar-slot')).toContainElement(bar);
    const actions = await within(bar).findByTestId('channel-actions');
    actions.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menuitem', { name: 'إخفاء من قائمتي' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'حذف من هرمز…' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'إخفاء من قائمتي' }));
    await waitFor(() =>
      expect(
        hub.seen.some(
          (c) => c.method === 'PUT' && c.path === `/channel-conversations/${TG.id}/hidden`,
        ),
      ).toBe(true),
    );
  });
});

describe('a channel conversation opens read-only', () => {
  it('shows the transcript and the banner where the composer would be', async () => {
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path={`/chat/${TG.id}?source=channel`}>
        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatScreen />} />
        </Routes>
      </Providers>,
    );
    const screenEl = await screen.findByTestId('channel-screen');
    await within(screenEl).findByText('متى موعد التسليم؟');
    expect(within(screenEl).getByTestId('message-assistant')).toHaveTextContent('يوم الخميس.');
    expect(within(screenEl).getByTestId('message-user')).toHaveTextContent('أحمد');
    expect(screen.getByTestId('channel-readonly')).toHaveTextContent(
      'محادثة من تيليجرام — للقراءة فقط؛ الرد يكون من تيليجرام',
    );
    // Nothing to write with, and the hub's session was never asked for.
    expect(screen.queryByRole('textbox', { name: /.+/ })).toBeNull();
    expect(hub.seen.some((c) => c.path === `/sessions/${TG.id}`)).toBe(false);
  });

  it('says it is not there when the id is not a channel conversation of this profile', async () => {
    const hub = fakeHub();
    render(
      <Providers fetchImpl={hub.fetchImpl} path="/chat/somebody_else?source=channel">
        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatScreen />} />
        </Routes>
      </Providers>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('channel-readonly')).toBeNull();
  });
});
