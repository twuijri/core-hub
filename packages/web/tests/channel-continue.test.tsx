/**
 * "Continue in Core Hub" (contract decision §58): from a Telegram conversation's read-only view,
 * a person carries it into a new hub chat in the same profile. Asserted by what they see and by
 * the requests sent: the profile's Hermes is the agent, the note goes with the request, the app
 * opens the new chat, and the chat sends the first message the hub answered — once it is
 * listening — as its first run.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A socket that connects at once and says yes to every subscription. */
class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, fn: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  off(event: string, fn: (...args: unknown[]) => void) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((each) => each !== fn),
    );
    return this;
  }
  once() {
    return this;
  }
  connect() {
    this.connected = true;
    queueMicrotask(() => {
      for (const fn of this.listeners.get('connect') ?? []) fn();
    });
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

const CONVERSATION = '20260925_091500_aa11bb22';
const NEW_CHAT = '01J8QK3ZR2W7M5N4P6T8V9X0YC';
const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AH';
const DIRECT = '01J8QK3ZR2W7M5N4P6T8V9X0AD';
const TRANSCRIPT = '01J8QK3ZR2W7M5N4P6T8V9X0AT';

const FIRST_MESSAGE = [
  {
    type: 'text',
    text: 'نكمل هنا محادثة من تيليجرام مع «أحمد» (2 رسالة). نصّها كاملًا في الملف المرفق؛ اقرأه أولًا.\n\nجهّز له ردًّا.',
  },
  {
    type: 'file',
    attachment_id: TRANSCRIPT,
    name: 'telegram-أحمد.md',
    mime: 'text/markdown',
    size_bytes: 300,
  },
];

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
  profile: string | null;
  body: Record<string, unknown> | null;
}

const agent = (id: string, slug: string, name: string) => ({
  id,
  slug,
  name,
  enabled: true,
  status: 'available',
  capabilities: [],
});

function fakeHub(options: { agents?: unknown[] } = {}) {
  const seen: Seen[] = [];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const conversation = {
    id: CONVERSATION,
    profile: 'default',
    channel: 'telegram',
    title: null,
    peer_name: 'أحمد',
    peer_id: '5550001',
    chat_type: 'dm',
    last_message: { role: 'assistant', text: 'يوم الخميس.' },
    preview: 'متى موعد التسليم؟',
    message_count: 2,
    started_at: '2026-09-25T09:15:00Z',
    last_message_at: '2026-09-25T09:20:00Z',
  };
  const session = {
    id: NEW_CHAT,
    profile: 'default',
    agent_id: HERMES,
    title: 'تيليجرام: أحمد',
    source: 'chat',
    status: 'idle',
    active_run_id: null,
    message_count: 0,
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const profile = new Headers(init?.headers).get('X-Hub-Profile');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    seen.push({ method, path, profile, body });
    if (path === '/profiles')
      return json({ items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'D' }] });
    if (path === '/agents')
      return json({
        items: options.agents ?? [
          agent(DIRECT, 'direct', 'Direct'),
          agent(HERMES, 'hermes', 'Hermes'),
        ],
      });
    if (path === `/channel-conversations/${CONVERSATION}/messages`)
      return json({
        conversation,
        items: [
          { id: '1', role: 'user', text: 'متى موعد التسليم؟', created_at: conversation.started_at },
        ],
        has_more: false,
      });
    if (path === `/channel-conversations/${CONVERSATION}/continue`)
      return json({ session, first_message: FIRST_MESSAGE }, 201);
    if (path === `/sessions/${NEW_CHAT}` && method === 'GET')
      return json({ ...session, runs: [], pending_approvals: [] });
    if (path === `/sessions/${NEW_CHAT}/runs` && method === 'POST')
      return json(
        { run_id: '01J8QK3ZR2W7M5N4P6T8V9X0RN', job_id: '01J8QK3ZR2W7M5N4P6T8V9X0JB' },
        202,
      );
    return json({ items: [], next_cursor: null });
  };
  return { seen, fetchImpl };
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function mount(fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  render(
    <ThemeProvider>
      <I18nProvider language="ar">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={[`/chat/${CONVERSATION}?source=channel`]}>
                <Routes>
                  <Route
                    path="/chat/:sessionId?"
                    element={
                      <>
                        <ChatScreen />
                        <Where />
                      </>
                    }
                  />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('continue a channel conversation in Core Hub', () => {
  it("makes a chat with the profile's Hermes, opens it, and sends the first message there", async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    mount(hub.fetchImpl);
    await screen.findByTestId('channel-readonly');
    await user.click(await screen.findByTestId('channel-continue'));
    const dialog = await screen.findByTestId('channel-continue-dialog');
    expect(dialog).toHaveTextContent('المحادثة في تيليجرام تبقى كما هي.');
    await user.type(within(dialog).getByTestId('channel-continue-note'), 'جهّز له ردًّا.');
    await user.click(within(dialog).getByTestId('channel-continue-go'));

    await waitFor(() =>
      expect(
        hub.seen.find((call) => call.path === `/channel-conversations/${CONVERSATION}/continue`),
      ).toMatchObject({
        method: 'POST',
        profile: 'default',
        body: { agent_id: HERMES, note: 'جهّز له ردًّا.' },
      }),
    );
    // The new chat opens, and sends what the hub answered as its first run.
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toMatch(new RegExp(`^/chat/${NEW_CHAT}`)),
    );
    await waitFor(
      () =>
        expect(
          hub.seen.find(
            (call) => call.method === 'POST' && call.path === `/sessions/${NEW_CHAT}/runs`,
          )?.body,
        ).toMatchObject({ content: FIRST_MESSAGE }),
      { timeout: 3000 },
    );
  });

  it('says so when no agent in the profile can take it', async () => {
    const user = userEvent.setup();
    const hub = fakeHub({ agents: [] });
    mount(hub.fetchImpl);
    await user.click(await screen.findByTestId('channel-continue'));
    const dialog = await screen.findByTestId('channel-continue-dialog');
    await waitFor(() =>
      expect(dialog).toHaveTextContent('لا وكيل في هذا البروفايل يستطيع تولّيها'),
    );
    expect(within(dialog).getByTestId('channel-continue-go')).toBeDisabled();
  });
});
