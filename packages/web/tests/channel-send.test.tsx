/**
 * Writing into a Telegram conversation from the hub (contract decision §153), on screen: an
 * admin gets a composer where the read-only banner was; what they send shows at once, then
 * says what became of it as the hub announces it (`channel_conversation.updated`), and becomes
 * the hub person's message in the transcript, still under Telegram's label. A refusal is said in
 * plain words and the words stay in the box. Where it cannot be written into, the banner says
 * why; an older hub's conversation reads as before.
 *
 * The hub's half is `packages/server/src/modules/sessions/channel-sends.test.ts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelConversation as Conversation,
  ChannelMessage,
  ChannelOutgoing,
} from '../src/sessions/channels.js';

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on(event: string, handler: Handler) {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return this;
  }
  off(event: string, handler: Handler) {
    handlers.get(event)?.delete(handler);
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
const { ChatScreen } = await import('../src/chat/ChatScreen.js');

const ID = '20261008_091500_aa11bb22';
const TG: Conversation = {
  id: ID,
  profile: 'default',
  channel: 'telegram',
  title: null,
  peer_name: 'أحمد',
  peer_id: '5550001',
  chat_type: 'dm',
  last_message: { role: 'assistant', text: 'يوم الخميس.' },
  preview: 'متى موعد التسليم؟',
  message_count: 2,
  started_at: '2026-10-08T09:15:00Z',
  last_message_at: '2026-10-08T09:16:00Z',
};
const FIRST: ChannelMessage[] = [
  { id: '1', role: 'user', text: 'متى موعد التسليم؟', created_at: TG.started_at, attachments: [] },
  {
    id: '2',
    role: 'assistant',
    text: 'يوم الخميس.',
    created_at: TG.last_message_at,
    attachments: [],
  },
];

function outgoing(extra: Partial<ChannelOutgoing> = {}): ChannelOutgoing {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0QG',
    conversation_id: ID,
    client_message_id: null,
    text: 'أرسل الملف',
    author_name: 'Admin',
    status: 'posted',
    error: null,
    message_id: null,
    session_id: null,
    created_at: '2026-10-08T09:20:00Z',
    updated_at: '2026-10-08T09:20:00Z',
    ...extra,
  };
}

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

/** The hub as the transcript and the send see it, changed by the test as the hub would. */
function fakeHub(conversation: Partial<Conversation>) {
  const state = {
    conversation: { ...TG, ...conversation } as Conversation,
    items: [...FIRST],
    outgoing: [] as ChannelOutgoing[],
    refuse: false,
    posted: [] as Array<Record<string, unknown>>,
  };
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === `/channel-conversations/${ID}/messages` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.posted.push(body);
      if (state.refuse)
        return json(
          {
            error: 'Forbidden: bot was blocked by the user',
            code: 'service_unavailable',
            details: {
              reason: 'channel_send_failed',
              message: 'Forbidden: bot was blocked by the user',
            },
          },
          503,
        );
      const made = outgoing({
        text: String(body.text),
        client_message_id: (body.client_message_id as string | undefined) ?? null,
      });
      state.outgoing = [made];
      return json({ outgoing: made }, 202);
    }
    if (path === `/channel-conversations/${ID}/messages`)
      return json({
        conversation: state.conversation,
        items: state.items,
        has_more: false,
        next_offset: null,
        outgoing: state.outgoing,
        live_updates: true,
      });
    if (path === '/agents') return json({ items: [] });
    if (path === '/profiles')
      return json({ items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'D' }] });
    return json({ items: [], next_cursor: null });
  };
  return { state, fetchImpl };
}

function Screen({
  fetchImpl,
  role = 'owner',
}: {
  fetchImpl: typeof fetch;
  role?: 'owner' | 'member';
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
              <MemoryRouter initialEntries={[`/chat/${ID}?source=channel`]}>
                <Routes>
                  <Route path="/chat/:sessionId?" element={<ChatScreen />} />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

/** The hub announcing a change of the conversation on `/rt/sessions`. */
function announce(payload: Record<string, unknown>) {
  for (const handler of handlers.get('channel_conversation.updated') ?? []) {
    handler({
      event: 'channel_conversation.updated',
      namespace: '/rt/sessions',
      profile: 'default',
      ts: '2026-10-08T09:20:01Z',
      seq: 1,
      payload: { conversation_id: ID, channel: 'telegram', ...payload },
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  handlers.clear();
});
afterEach(cleanup);

describe('an admin writes into a Telegram conversation from the hub (§153)', () => {
  it('sends, shows it at once, follows it, and it becomes the hub person’s message', async () => {
    const user = userEvent.setup();
    const hub = fakeHub({ can_send: true, send_unavailable: null, current_id: null });
    render(<Screen fetchImpl={hub.fetchImpl} />);
    const box = await screen.findByTestId('channel-composer-input');
    expect(screen.queryByTestId('channel-readonly')).toBeNull();
    expect(screen.getByTestId('channel-badge')).toHaveTextContent('تيليجرام');
    expect(screen.getByTestId('channel-send-hint')).toHaveTextContent('من كور هب');
    expect(screen.getByTestId('channel-continue')).toBeInTheDocument();

    await user.type(box, 'أرسل الملف{Enter}');
    await waitFor(() => expect(hub.state.posted).toHaveLength(1));
    expect(hub.state.posted[0]).toMatchObject({ text: 'أرسل الملف' });
    expect(hub.state.posted[0]!.client_message_id).toMatch(/^c-/);
    const mine = await screen.findByTestId('message-hub');
    expect(mine).toHaveTextContent('أرسل الملف');
    await waitFor(() =>
      expect(within(mine).getByTestId('channel-outgoing-status')).toHaveAttribute(
        'data-status',
        'posted',
      ),
    );
    expect(box).toHaveValue('');

    announce({ reason: 'outgoing', outgoing: outgoing({ status: 'answering', session_id: ID }) });
    await waitFor(() =>
      expect(screen.getByTestId('channel-outgoing-status')).toHaveTextContent(
        'الوكيل يرد على تيليجرام',
      ),
    );

    // The turn ended: Hermes's transcript has the message and the reply; the hub is done with it.
    hub.state.items = [
      ...FIRST,
      {
        id: '3',
        role: 'user',
        text: 'أرسل الملف',
        created_at: '2026-10-08T09:20:01Z',
        attachments: [],
        origin: 'hub',
        author_name: 'Admin',
      },
      {
        id: '4',
        role: 'assistant',
        text: 'أرسلته.',
        created_at: '2026-10-08T09:20:05Z',
        attachments: [],
        origin: 'channel',
        author_name: null,
      },
    ];
    hub.state.outgoing = [];
    announce({
      reason: 'outgoing',
      outgoing: outgoing({ status: 'answered', session_id: ID, message_id: '3' }),
    });
    await screen.findByText('أرسلته.');
    const hubMessages = screen.getAllByTestId('message-hub');
    expect(hubMessages).toHaveLength(1);
    expect(hubMessages[0]).toHaveTextContent('Admin · من كور هب');
    expect(hubMessages[0]).toHaveAttribute('data-message-id', '3');
    expect(screen.queryByTestId('channel-outgoing-status')).toBeNull();
    expect(screen.getByTestId('channel-badge')).toHaveTextContent('تيليجرام');
  });

  it('says in plain words when Telegram refuses, and keeps the words', async () => {
    const user = userEvent.setup();
    const hub = fakeHub({ can_send: true, send_unavailable: null, current_id: null });
    hub.state.refuse = true;
    render(<Screen fetchImpl={hub.fetchImpl} />);
    const box = await screen.findByTestId('channel-composer-input');
    await user.type(box, 'لن يصل{Enter}');
    const error = await screen.findByTestId('channel-send-error');
    expect(error).toHaveTextContent(
      'رفض تيليجرام الرسالة، فلم تصل إلى الوكيل: Forbidden: bot was blocked by the user',
    );
    expect(box).toHaveValue('لن يصل');
    expect(screen.queryByTestId('message-hub')).toBeNull();
  });

  it('says why where it cannot be written into, and reads as before on an older hub', async () => {
    const member = fakeHub({ can_send: false, send_unavailable: 'not_admin', current_id: null });
    const { unmount } = render(<Screen fetchImpl={member.fetchImpl} role="member" />);
    expect(await screen.findByTestId('channel-readonly')).toHaveTextContent('للمشرف فقط');
    expect(screen.queryByTestId('channel-composer')).toBeNull();
    expect(screen.getByTestId('channel-continue')).toBeInTheDocument();
    unmount();

    const moved = fakeHub({
      can_send: false,
      send_unavailable: 'not_current',
      current_id: '20261009_000000_bbbbbbbb',
    });
    const second = render(<Screen fetchImpl={moved.fetchImpl} />);
    expect(await screen.findByTestId('channel-readonly')).toHaveTextContent('محادثة أحدث');
    expect(screen.getByTestId('channel-open-current')).toHaveTextContent('افتح المحادثة الحالية');
    second.unmount();

    const older = fakeHub({});
    render(<Screen fetchImpl={older.fetchImpl} />);
    expect(await screen.findByTestId('channel-readonly')).toHaveTextContent('للقراءة فقط');
    expect(screen.queryByTestId('channel-composer')).toBeNull();
  });
});
