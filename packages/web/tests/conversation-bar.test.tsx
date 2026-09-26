/**
 * The conversation's controls are pinned in the one top bar (owner, 2026-09-26: «هذا السطر ما
 * سويناه انه ثابت؟ … لازم تكون كل هذي الأشياء ثابتة», then «بيطلع فوق كأنه شريطين»).
 *
 * - The agent, the folder, Files and the Chat | Trajectory switch are in the app's top bar, not
 *   in the scrolling page, so they stay while the messages scroll — and there is no second bar.
 * - The folder is an icon: a generated folder is "Automatic folder", never its raw ULID; the
 *   whole path and "fixed once the chat has run" are in its popover.
 * - The person's profile chip is already in the bar: the conversation's is added only when it
 *   is another profile.
 * - A narrow bar keeps the agent and moves the rest into one "More" panel.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
const { ChatScreen } = await import('../src/chat/ChatScreen.js');
const { barLayout, BAR_INLINE_MIN } = await import('../src/chat/ConversationBar.js');

const SESSION = '01M3DDZQMF3ZYF19CFCSY692SS';
const GENERATED = '01M3DDZQMF3ZYF19CFCSY692NF';
const ROOT = '/data/workspaces/default';
const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

const session = {
  id: SESSION,
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
  agent_id: HERMES,
  title: 'Launch plan',
  source: 'chat',
  origin: null,
  channel: null,
  model: null,
  provider: null,
  reasoning_effort: null,
  working_dir: `${ROOT}/${GENERATED}`,
  preview: null,
  pinned: false,
  archived: false,
  category_id: null,
  status: 'idle',
  active_run_id: null,
  parent_session_id: null,
  notify: true,
  message_count: 1,
  usage: null,
  context: null,
  last_message_at: '2026-09-26T00:00:00Z',
  match: null,
};

const message = {
  id: '01M3DDZQMF3ZYF19CFCSY692M1',
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
  session_id: SESSION,
  room_id: null,
  seq: 1,
  author: { kind: 'user', id: 'u', name: 'Admin', avatar: null },
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
  reasoning: null,
  tool_calls: [],
  run_id: null,
  status: 'complete',
  mentions: [],
  handoff: null,
  usage: null,
  reply_to_message_id: null,
};

const hermes = {
  id: HERMES,
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'hermes',
  name: 'Hermes',
  vendor: null,
  kind: 'hermes',
  adapter: 'hermes',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['streaming'],
  sections: [],
  default_model: null,
  runtime: { error: null },
  install: {
    source: 'bundled',
    version: '1.0.0',
    error: null,
    update_available: false,
    latest_version: null,
  },
};

const PROFILES = [
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'designer', name: 'Designer' },
];

const fetchImpl: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  if (path === '/profiles') return json({ items: PROFILES });
  // The Trajectory view itself is `trajectory.test.tsx`'s; here it only has to be switched to.
  if (path.endsWith('/trajectory'))
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'unavailable', code: 'service_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  if (path === '/agents') return json({ items: [hermes] });
  if (path === '/sessions/working-dirs') return json({ root: ROOT, items: [] });
  if (path === `/sessions/${SESSION}/messages`) return json({ items: [message], has_more: false });
  if (path === `/sessions/${SESSION}/files`)
    return json({ working_dir: session.working_dir, truncated: false, items: [] });
  if (path === `/sessions/${SESSION}` && method === 'GET')
    return json({ ...session, runs: [], pending_approvals: [] });
  return json({ items: [], next_cursor: null });
};

function mount() {
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
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={[`/chat/${SESSION}`]}>
                <Routes>
                  <Route path="/chat/:sessionId?" element={<ChatScreen />} />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('the conversation bar', () => {
  it('lays out inline on a wide bar and as "More" on a narrow one', () => {
    expect(barLayout(0)).toBe('inline');
    expect(barLayout(BAR_INLINE_MIN)).toBe('inline');
    expect(barLayout(1200)).toBe('inline');
    expect(barLayout(BAR_INLINE_MIN - 1)).toBe('menu');
    expect(barLayout(375)).toBe('menu');
  });

  it('is in the pinned top bar with the title, not in the scrolling page', async () => {
    mount();
    const bar = await screen.findByTestId('chat-header');
    const top = screen.getByTestId('topbar-slot').closest('header');
    expect(top).toContainElement(bar);
    expect(screen.getByRole('main')).not.toContainElement(bar);
    // Everything the row held, in the one bar.
    await waitFor(() => expect(within(bar).getByTestId('session-agent')).toBeTruthy());
    expect(within(bar).getByTestId('working-dir-button')).toBeTruthy();
    expect(within(bar).getByTestId('chat-files')).toBeTruthy();
    expect(within(bar).getByTestId('chat-tabs')).toBeTruthy();
    // The agent is its mark and ▾; its name is the label, not a word in the bar.
    expect(within(bar).getByTestId('session-agent')).toHaveAccessibleName(/Hermes/);
  });

  it('shows the folder as an icon, never the raw ULID, with the path and the lock in its popover', async () => {
    const user = userEvent.setup();
    mount();
    const button = await screen.findByTestId('working-dir-button');
    await waitFor(() => expect(button).toHaveAccessibleName('Folder: Automatic folder'));
    expect(screen.getByTestId('chat-header')).not.toHaveTextContent(GENERATED);
    await user.click(button);
    const sheet = await screen.findByTestId('working-dir-sheet');
    expect(within(sheet).getByTestId('working-dir-path')).toHaveTextContent(`${ROOT}/${GENERATED}`);
    expect(within(sheet).getByTestId('working-dir-locked')).toHaveTextContent(
      'The folder is fixed once the chat has run.',
    );
    // Fixed: nothing to choose from.
    expect(within(sheet).queryByTestId('working-dir-new')).toBeNull();
  });

  it('does not repeat the profile chip the bar already has', async () => {
    mount();
    await screen.findByTestId('session-agent');
    expect(screen.queryByTestId('chat-profile')).toBeNull();
  });

  it('keeps the agent on a narrow bar and moves the rest into "More"', async () => {
    const user = userEvent.setup();
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.tagName === 'HEADER'
        ? ({ width: 375, height: 52, top: 0, left: 0, right: 375, bottom: 52 } as DOMRect)
        : real.call(this);
    });
    mount();
    const bar = await screen.findByTestId('chat-header');
    await waitFor(() => expect(bar.dataset.layout).toBe('menu'));
    await waitFor(() => expect(within(bar).getByTestId('session-agent')).toBeTruthy());
    expect(within(bar).queryByTestId('working-dir-button')).toBeNull();
    expect(screen.queryByTestId('chat-tabs')).toBeNull();
    await user.click(within(bar).getByTestId('chat-more-button'));
    const more = await screen.findByTestId('chat-more');
    expect(within(more).getByTestId('working-dir-current')).toHaveTextContent('Automatic folder');
    expect(within(more).getByTestId('chat-files')).toHaveTextContent('Files');
    await user.click(within(more).getByTestId('chat-tabs-trajectory'));
    await waitFor(() => expect(screen.getByTestId('chat-screen').dataset.view).toBe('trajectory'));
  });
});
