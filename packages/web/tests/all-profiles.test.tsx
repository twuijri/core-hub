/**
 * Lists across profiles (ADR 0016, owner 2026-09-24).
 *
 * «ايه» — the lists gather every profile the person may enter, each item with a badge of its
 * profile. «كل البروفايلات افتراضيا» — the chats list opens on "All profiles». «نعم» — search
 * always looks in every profile. And the owner's correction: «المفروض ما فيه خيار الكل. خيار
 * الكل كان لتصنيف المحادثات بس» — the top selector is always one concrete profile; "All
 * profiles" is the chats list's own filter, and neither moves the other.
 *
 * What is asserted is what a person sees and what goes on the wire: which profile each
 * request names, and that opening an item from another profile never moves the selector.
 * The hub's half — who may see which profile — is `modules/sessions/sessions-profiles.test.ts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseOption, closeControl, optionLabels } from './helpers/ui.js';

/** Every socket the app opened, with what its handshake would carry. */
const sockets: Array<{ namespace: string; profiles: string | undefined }> = [];
class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  off(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== handler),
    );
    return this;
  }
  once(event: string, handler: (...args: unknown[]) => void) {
    return this.on(event, handler);
  }
  connect() {
    this.connected = true;
    for (const handler of this.handlers.get('connect') ?? []) handler();
    return this;
  }
  /** `subscribe` / `unsubscribe` acknowledge at once, as the hub does. */
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  disconnect() {
    this.connected = false;
  }
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    connectNamespace: (options: { namespace: string; profiles?: string }) => {
      sockets.push({ namespace: options.namespace, profiles: options.profiles });
      return new FakeSocket();
    },
  };
});

const { AuthProvider, ChromeScope, ProfileScope, useAuth } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { SessionList } = await import('../src/sessions/SessionList.js');
const { WorkspaceSwitcher } = await import('../src/shell/WorkspaceSwitcher.js');
const { NewChatScreen } = await import('../src/screens/NewChatScreen.js');
const { ChatScreen } = await import('../src/chat/ChatScreen.js');
const { SearchScreen } = await import('../src/screens/SearchScreen.js');
const { reduce, hydrate, initialChat } = await import('../src/chat/transcript.js');

afterEach(() => {
  cleanup();
  sockets.length = 0;
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

const TWO_PROFILES = [
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'designer', name: 'Designer' },
];
const IN_DEFAULT = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const IN_DESIGNER = '01J8QK3ZR2W7M5N4P6T8V9X0YB';

function session(id: string, profile: string, title: string) {
  return {
    id,
    profile,
    owner_id: 'u',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
    title,
    source: 'chat',
    origin: null,
    channel: null,
    model: null,
    provider: null,
    reasoning_effort: null,
    working_dir: null,
    preview: null,
    pinned: false,
    archived: false,
    category_id: null,
    status: 'idle',
    active_run_id: null,
    parent_session_id: null,
    notify: true,
    message_count: 0,
    usage: null,
    context: null,
    last_message_at: null,
    match: null,
  };
}

const SESSIONS = [
  session(IN_DEFAULT, 'default', 'Launch plan'),
  session(IN_DESIGNER, 'designer', 'Logo ideas'),
];

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  profile: string | null;
}

/** A hub that answers like the real one: `profiles=all` gathers, the header narrows. */
function fakeHub(profiles = TWO_PROFILES) {
  const seen: Seen[] = [];
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    // The part of the path after the API prefix, which the generated client adds.
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const profile = new Headers(init?.headers).get('X-Hub-Profile');
    seen.push({ method, path, query: url.searchParams, profile });
    const visible = SESSIONS.filter((s) => profiles.some((p) => p.slug === s.profile));
    if (path === '/profiles') return json({ items: profiles });
    if (path === '/sessions' && method === 'GET') {
      const all = url.searchParams.get('profiles') === 'all';
      const q = url.searchParams.get('q')?.toLowerCase();
      const items = visible
        .filter((s) => all || s.profile === profile)
        .filter((s) => !q || s.title.toLowerCase().includes(q))
        .map((s) => (q ? { ...s, match: { message_id: null, snippet: s.title } } : s));
      return json({ items, next_cursor: null });
    }
    const one = SESSIONS.find((s) => path.startsWith(`/sessions/${s.id}`));
    if (one) {
      // A session is only found in its own profile, as on the hub.
      if (profile !== one.profile)
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not found', code: 'not_found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (path.endsWith('/messages')) return json({ items: [], has_more: false });
      if (method === 'PATCH') return json(one);
      return json({ ...one, runs: [], pending_approvals: [] });
    }
    return json({ items: [], next_cursor: null });
  };
  return { seen, fetchImpl };
}

function signedIn(profile = 'default') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile,
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return store;
}

function Providers({
  store,
  fetchImpl,
  path,
  children,
}: {
  store: InstanceType<typeof SessionStore>;
  fetchImpl: typeof fetch;
  path: string;
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <I18nProvider language="en">
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

/** The chats list with the top selector beside it, as the chat page frames them. */
function renderList(profiles = TWO_PROFILES) {
  const hub = fakeHub(profiles);
  const store = signedIn();
  render(
    <Providers store={store} fetchImpl={hub.fetchImpl} path="/chat">
      <WorkspaceSwitcher />
      <SessionList />
    </Providers>,
  );
  return { ...hub, store };
}

const listCalls = (seen: Seen[]) =>
  seen.filter((call) => call.path === '/sessions' && call.method === 'GET');

describe('the top selector is the profile the person is in', () => {
  it('is always one concrete profile, and never offers "All"', async () => {
    const user = userEvent.setup();
    renderList();
    const switcher = await screen.findByTestId('workspace-switcher');
    await waitFor(() => expect(switcher).toHaveTextContent('Default'));
    expect(await optionLabels(user, switcher)).toEqual(['Default', 'Designer']);
    await closeControl(user);
  });

  it('does not move the list filter: the list stays on every profile', async () => {
    const user = userEvent.setup();
    const { store } = renderList();
    const switcher = await screen.findByTestId('workspace-switcher');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(2));
    await chooseOption(user, switcher, 'Designer');
    await waitFor(() => expect(store.read()?.profile).toBe('designer'));
    expect(screen.getByTestId('session-profile-filter')).toHaveTextContent('All profiles');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(2));
  });
});

describe('the chats list has its own profile filter', () => {
  it('opens on "All profiles": both profiles listed, each row with its badge', async () => {
    const { seen } = renderList();
    const filter = await screen.findByTestId('session-profile-filter');
    expect(filter).toHaveTextContent('All profiles');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(2));
    expect(listCalls(seen).at(-1)?.query.get('profiles')).toBe('all');
    const badges = screen.getAllByTestId('session-profile').map((b) => b.dataset.profile);
    expect(badges.sort()).toEqual(['default', 'designer']);
    expect(screen.getAllByTestId('session-profile')[0]).toHaveTextContent(/Default|Designer/);
  });

  it('narrows to one profile without moving the top selector, and back to all', async () => {
    const user = userEvent.setup();
    const { seen, store } = renderList();
    const filter = await screen.findByTestId('session-profile-filter');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(2));

    await chooseOption(user, filter, 'Designer');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(1));
    const last = listCalls(seen).at(-1)!;
    expect(last.query.get('profiles')).toBeNull();
    expect(last.profile).toBe('designer');
    // One profile on screen: nothing for a badge to tell apart.
    expect(screen.queryByTestId('session-profile')).toBeNull();
    // The filter is the list's: the person is still in their own profile.
    expect(screen.getByTestId('workspace-switcher')).toHaveTextContent('Default');
    expect(store.read()?.profile).toBe('default');

    await chooseOption(user, filter, 'All profiles');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(2));
  });

  it('opens each row in its own profile, and acts on it there', async () => {
    const user = userEvent.setup();
    const { seen } = renderList();
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(2));
    const row = screen
      .getAllByTestId('session-row')
      .find((r) => r.textContent?.includes('Logo ideas'))!;
    expect(within(row).getByRole('link').getAttribute('href')).toBe(
      `/chat/${IN_DESIGNER}?profile=designer`,
    );
    await user.click(within(row).getByRole('button', { name: 'Pin' }));
    await waitFor(() =>
      expect(seen.some((c) => c.method === 'PATCH' && c.path.endsWith(IN_DESIGNER))).toBe(true),
    );
    const patch = seen.find((c) => c.method === 'PATCH')!;
    expect(patch.profile).toBe('designer');
  });

  it('with one profile there is nothing to gather: no filter, no badges, no profile in links', async () => {
    const user = userEvent.setup();
    renderList([TWO_PROFILES[0]!]);
    const switcher = await screen.findByTestId('workspace-switcher');
    await waitFor(() => expect(screen.getAllByTestId('session-row')).toHaveLength(1));
    expect(switcher).toHaveTextContent('Default');
    expect(screen.queryByTestId('session-profile-filter')).toBeNull();
    expect(screen.queryByTestId('session-profile')).toBeNull();
    expect(within(screen.getByTestId('session-row')).getByRole('link').getAttribute('href')).toBe(
      `/chat/${IN_DEFAULT}`,
    );
    expect(await optionLabels(user, switcher)).toEqual(['Default']);
    await closeControl(user);
  });

  it('hears every profile on the sessions socket, and only there', async () => {
    renderList();
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const bySpace = new Map(sockets.map((s) => [s.namespace, s.profiles]));
    expect(bySpace.get('/rt/sessions')).toBe('all');
    for (const [namespace, profiles] of bySpace)
      if (namespace !== '/rt/sessions') expect(profiles).toBeUndefined();
  });
});

describe('a new chat is made in the top profile', () => {
  it('says which, and follows the top selector — with no second control to disagree', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers store={signedIn()} fetchImpl={hub.fetchImpl} path="/new">
        <Routes>
          <Route path="/new" element={<NewChatScreen />} />
        </Routes>
      </Providers>,
    );
    const where = await screen.findByTestId('new-chat-profile');
    await waitFor(() => expect(where).toHaveTextContent('New chat in Default'));
    expect(within(where).queryByRole('combobox')).toBeNull();
    await chooseOption(user, screen.getAllByTestId('workspace-switcher')[0]!, 'Designer');
    await waitFor(() =>
      expect(screen.getByTestId('new-chat-profile')).toHaveTextContent('New chat in Designer'),
    );
  });
});

describe('an item from another profile opens there, and the selector stays put', () => {
  function Probe() {
    const { profile, homeProfile, client } = useAuth();
    return (
      <>
        <span data-testid="probe">{`${profile}|${homeProfile}`}</span>
        <button type="button" onClick={() => void client.request('get', '/agents')}>
          ask
        </button>
      </>
    );
  }

  it('asks the item’s profile inside the scope; the frame still speaks for the person', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    const store = signedIn();
    render(
      <Providers store={store} fetchImpl={hub.fetchImpl} path="/chat">
        <ProfileScope profile="designer">
          <ChromeScope>
            <WorkspaceSwitcher />
          </ChromeScope>
          <Probe />
        </ProfileScope>
      </Providers>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('designer|default');
    await user.click(screen.getByText('ask'));
    await waitFor(() => expect(hub.seen.some((c) => c.path === '/agents')).toBe(true));
    expect(hub.seen.find((c) => c.path === '/agents')?.profile).toBe('designer');
    await waitFor(() =>
      expect(screen.getByTestId('workspace-switcher')).toHaveTextContent('Default'),
    );
    expect(store.read()?.profile).toBe('default');
  });

  it('opens a designer chat from the address, with its badge, without moving the selector', async () => {
    const hub = fakeHub();
    const store = signedIn();
    render(
      <Providers
        store={store}
        fetchImpl={hub.fetchImpl}
        path={`/chat/${IN_DESIGNER}?profile=designer`}
      >
        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatScreen />} />
        </Routes>
      </Providers>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('chat-profile').dataset.profile).toBe('designer'),
    );
    // The transcript was asked for in the conversation's own profile …
    await waitFor(() =>
      expect(
        hub.seen.some((c) => c.path === `/sessions/${IN_DESIGNER}` && c.profile === 'designer'),
      ).toBe(true),
    );
    expect(
      hub.seen.filter((c) => c.path.startsWith(`/sessions/${IN_DESIGNER}`)),
    ).not.toContainEqual(expect.objectContaining({ profile: 'default' }));
    // … while the top selector stayed on the person's profile, the list on every profile,
    // and the person's own profile did not change.
    await waitFor(() =>
      expect(screen.getAllByTestId('workspace-switcher')[0]).toHaveTextContent('Default'),
    );
    expect(screen.getAllByTestId('session-profile-filter')[0]).toHaveTextContent('All profiles');
    expect(listCalls(hub.seen).at(-1)?.query.get('profiles')).toBe('all');
    expect(store.read()?.profile).toBe('default');
  });
});

describe('search looks in every profile', () => {
  it('asks every profile even when the list is narrowed, and opens each hit in its profile', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    render(
      <Providers store={signedIn()} fetchImpl={hub.fetchImpl} path="/search">
        <Routes>
          <Route path="/search" element={<SearchScreen />} />
        </Routes>
      </Providers>,
    );
    // Narrow the chats list to one profile: search must not follow.
    const filter = (await screen.findAllByTestId('session-profile-filter'))[0]!;
    await chooseOption(user, filter, 'Designer');
    await waitFor(() => expect(filter).toHaveTextContent('Designer'));

    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'o');
    await waitFor(() => expect(screen.getAllByTestId('search-result')).toHaveLength(2));
    const searched = listCalls(hub.seen).filter((c) => c.query.get('q') === 'o');
    expect(searched.every((c) => c.query.get('profiles') === 'all')).toBe(true);
    const hrefs = screen.getAllByTestId('search-result').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/chat/${IN_DEFAULT}?profile=default`);
    expect(hrefs).toContain(`/chat/${IN_DESIGNER}?profile=designer`);
    const badges = screen.getAllByTestId('search-result-profile').map((b) => b.dataset.profile);
    expect(badges.sort()).toEqual(['default', 'designer']);
  });
});

describe('resuming a conversation while the socket hears every profile', () => {
  const env = (profile: string, seq: number) => ({
    event: 'session.updated',
    namespace: '/rt/sessions',
    profile,
    ts: '2026-09-24T00:00:00Z',
    seq,
    payload: { session: { id: 'someone-else' } },
  });

  it('moves the resume cursor only on its own profile’s count', () => {
    const detail = {
      ...session(IN_DESIGNER, 'designer', 'Logo ideas'),
      runs: [],
      pending_approvals: [],
    };
    let state = hydrate(initialChat(), detail as never, []);
    state = reduce(state, env('designer', 7) as never, IN_DESIGNER);
    expect(state.lastSeq).toBe(7);
    // Another profile counts on its own; its higher number must not skip what this missed.
    state = reduce(state, env('default', 900) as never, IN_DESIGNER);
    expect(state.lastSeq).toBe(7);
  });
});
