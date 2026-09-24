/**
 * Tasks and Schedules across profiles (ADR 0016 stage 2, DECISIONS §30).
 *
 * The owner: «الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون تصنيف» — both pages show
 * every profile the person may enter, with no profile filter; each card and schedule says
 * which profile it is from. The top selector (the profile the person is in) decides only
 * where a **new** task or schedule is made; anything done to an existing one is sent in the
 * item's own profile, and opening a task's conversation opens it there without moving the
 * selector.
 *
 * Asserted here: what a person sees, and which profile each request names. Who may see which
 * profile is the hub's half: `packages/server/tests/unit/lists-across-profiles.test.ts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openControl } from './helpers/ui.js';

/** Every socket the app opened, with what its handshake would carry. */
const sockets: Array<{ namespace: string; profiles: string | undefined; socket: FakeSocket }> = [];
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
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true });
    return this;
  }
  /** What the hub would push. */
  deliver(event: string, envelope: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(envelope);
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
      const socket = new FakeSocket();
      sockets.push({ namespace: options.namespace, profiles: options.profiles, socket });
      return socket;
    },
  };
});

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { TasksScreen } = await import('../src/tasks/TasksScreen.js');
const { SchedulesScreen } = await import('../src/schedules/SchedulesScreen.js');
const { TASK_STATUSES } = await import('../src/tasks/board.js');

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
const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const DESIGNER_AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AD';
const IN_DEFAULT = '01J8QK3ZR2W7M5N4P6T8V9X0TA';
const IN_DESIGNER = '01J8QK3ZR2W7M5N4P6T8V9X0TB';
const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0SS';

function task(id: string, profile: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    project_id: '01J8QK3ZR2W7M5N4P6T8V9X0PJ',
    title,
    description: null,
    status: 'todo',
    priority: 'normal',
    tags: [],
    assignee: null,
    position: 'n',
    blocked_reason: null,
    subtask_counts: { total: 0, done: 0 },
    depends_on: [],
    due_at: null,
    external: null,
    profile,
    session_id: null,
    latest_summary: null,
    ...over,
  };
}

function schedule(id: string, profile: string, name: string) {
  return {
    id,
    profile,
    name,
    enabled: true,
    state: 'scheduled',
    next_run_at: null,
    trigger: {
      kind: 'interval',
      expression: null,
      every_minutes: 60,
      run_at: null,
      timezone: 'UTC',
    },
    delivery: { kind: 'none', channel: null, address: null },
    last_error: null,
    external: null,
  };
}

const SCHEDULES = [
  schedule('01J8QK3ZR2W7M5N4P6T8V9X0S3', 'designer', 'Logo review'),
  schedule('01J8QK3ZR2W7M5N4P6T8V9X0S2', 'default', 'Morning brief'),
  schedule('01J8QK3ZR2W7M5N4P6T8V9X0S1', 'default', 'Weekly digest'),
];

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  profile: string | null;
  body: unknown;
}

/** A hub that answers like the real one: every profile on both pages, each item its own. */
function fakeHub(tasks: Array<ReturnType<typeof task>>, schedulePage = 50) {
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
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const profile = new Headers(init?.headers).get('X-Hub-Profile');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method, path, query: url.searchParams, profile, body });
    if (path === '/profiles') return json({ items: TWO_PROFILES });
    if (path === '/agents') {
      // Each profile's agents: the designer's agent is not among the default's, and the
      // default's list names the shared id differently — a client guessing from here is wrong.
      return json({
        items:
          profile === 'designer'
            ? [agentRow(DESIGNER_AGENT, 'Designer bot')]
            : [agentRow(AGENT, 'A guess from Default')],
      });
    }
    if (path === '/task-columns') {
      const archived = url.searchParams.get('include_archived') === 'true';
      const columns = TASK_STATUSES.map((status) => {
        const items =
          archived && status !== 'archived' ? [] : tasks.filter((t) => t.status === status);
        return { status, count: items.length, tasks: items };
      });
      return json({ project_id: null, columns, counts: { total: tasks.length } });
    }
    if (path === '/schedules' && method === 'GET') {
      const after = url.searchParams.get('cursor');
      const start = after ? SCHEDULES.findIndex((s) => s.id === after) + 1 : 0;
      const items = SCHEDULES.slice(start, start + schedulePage);
      const more = start + schedulePage < SCHEDULES.length;
      return json({ items, next_cursor: more ? items.at(-1)!.id : null });
    }
    if (path.endsWith('/assign')) {
      return json({ task_id: IN_DESIGNER, job_id: null, run_id: null, session_id: null });
    }
    return json({ items: [] });
  };
  return { seen, fetchImpl };
}

function agentRow(id: string, name: string) {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    status: 'available',
    enabled: true,
  };
}

function mount(children: ReactNode, fetchImpl: typeof fetch) {
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
              <MemoryRouter initialEntries={['/tasks']}>{children}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return store;
}

const cardOf = (id: string) =>
  screen.getAllByTestId('task-card').find((el) => el.getAttribute('data-task-id') === id)!;

describe('the Tasks board shows every profile, with no profile filter', () => {
  const tasks = [
    task(IN_DEFAULT, 'default', 'Release notes', {
      assignee: { kind: 'agent', id: AGENT, name: 'Codex' },
    }),
    task(IN_DESIGNER, 'designer', 'New logo', {
      status: 'running',
      session_id: SESSION,
      assignee: { kind: 'agent', id: DESIGNER_AGENT, name: 'Designer bot' },
    }),
  ];

  it('asks for every profile, offers no profile filter, and badges each card with its own', async () => {
    const { seen, fetchImpl } = fakeHub(tasks);
    mount(<TasksScreen />, fetchImpl);
    await screen.findByText('New logo');
    const boardCalls = seen.filter((c) => c.path === '/task-columns');
    expect(boardCalls.length).toBeGreaterThan(0);
    for (const call of boardCalls) {
      expect(call.query.get('profiles')).toBe('all');
      expect(call.query.get('profile')).toBeNull();
    }
    expect(screen.queryByTestId('profile-filter')).toBeNull();
    await waitFor(() =>
      expect(within(cardOf(IN_DESIGNER)).getByTestId('task-profile')).toHaveAttribute(
        'data-profile',
        'designer',
      ),
    );
    expect(within(cardOf(IN_DEFAULT)).getByTestId('task-profile')).toHaveAttribute(
      'data-profile',
      'default',
    );
  });

  it('shows the agent’s name the hub gave, not a guess from this profile’s agents', async () => {
    const { fetchImpl } = fakeHub(tasks);
    mount(<TasksScreen />, fetchImpl);
    await screen.findByText('Release notes');
    // Let the default profile's agents arrive: they must not rename the card.
    await new Promise((r) => setTimeout(r, 50));
    expect(within(cardOf(IN_DEFAULT)).getByTestId('task-agent')).toHaveTextContent('Codex');
    expect(within(cardOf(IN_DESIGNER)).getByTestId('task-agent')).toHaveTextContent('Designer bot');
  });

  it('opens a task’s conversation in the task’s own profile, without moving the selector', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub(tasks);
    const store = mount(<TasksScreen />, fetchImpl);
    const link = await within(await waitFor(() => cardOf(IN_DESIGNER))).findByTestId(
      'task-session',
    );
    await waitFor(() => expect(link).toHaveAttribute('href', `/chat/${SESSION}?profile=designer`));
    await user.click(link);
    expect(store.read()?.profile).toBe('default');
  });

  it('assigns a card in its own profile, offering that profile’s agents', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub([
      task(IN_DESIGNER, 'designer', 'New logo'),
      task(IN_DEFAULT, 'default', 'Release notes'),
    ]);
    mount(<TasksScreen />, fetchImpl);
    await screen.findByText('New logo');
    await openControl(user, within(cardOf(IN_DESIGNER)).getByTestId('task-more'));
    await user.click(await screen.findByRole('menuitem', { name: 'Assign to an agent…' }));
    const dialog = await screen.findByTestId('task-assign-dialog');
    await waitFor(() =>
      expect(within(dialog).getByTestId('task-assign-agent')).toHaveTextContent('Designer bot'),
    );
    await user.click(within(dialog).getByTestId('task-assign-only'));
    await waitFor(() => expect(seen.some((c) => c.path.endsWith('/assign'))).toBe(true));
    const assign = seen.find((c) => c.path.endsWith('/assign'))!;
    expect(assign.path).toBe(`/tasks/${IN_DESIGNER}/assign`);
    expect(assign.profile).toBe('designer');
    expect(assign.body).toMatchObject({ agent_id: DESIGNER_AGENT, start: false });
  });

  it('makes a new task in the profile the person is in, and says which', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub(tasks);
    mount(<TasksScreen />, fetchImpl);
    const input = await screen.findByTestId('new-task-input');
    await waitFor(() => expect(input).toHaveAttribute('placeholder', 'New task in Default'));
    await user.type(input, 'Write the brief{Enter}');
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/tasks' && c.method === 'POST')).toBe(true),
    );
    const created = seen.find((c) => c.path === '/tasks' && c.method === 'POST')!;
    expect(created.profile).toBe('default');
    expect(created.body).toMatchObject({ title: 'Write the brief' });
  });

  it('hears every profile on the tasks socket', async () => {
    const { fetchImpl } = fakeHub(tasks);
    mount(<TasksScreen />, fetchImpl);
    await screen.findByText('New logo');
    await waitFor(() => expect(sockets.some((s) => s.namespace === '/rt/tasks')).toBe(true));
    expect(sockets.find((s) => s.namespace === '/rt/tasks')!.profiles).toBe('all');
  });
});

describe('the Schedules page shows every profile, with no profile filter', () => {
  it('reads every page of every profile, badges each schedule, and offers no filter', async () => {
    const { seen, fetchImpl } = fakeHub([], 2);
    mount(<SchedulesScreen />, fetchImpl);
    await screen.findByText('Weekly digest');
    const reads = seen.filter((c) => c.path === '/schedules' && c.method === 'GET');
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.query.get('profiles')).toBe('all');
      expect(read.query.get('profile')).toBeNull();
    }
    expect(reads[1]!.query.get('cursor')).toBe(SCHEDULES[1]!.id);
    expect(screen.queryByTestId('schedule-filter')).toBeNull();
    const cards = screen.getAllByTestId('schedule-card');
    expect(cards).toHaveLength(3);
    await waitFor(() =>
      expect(
        cards.map((card) => within(card).getByTestId('schedule-profile').dataset.profile),
      ).toEqual(['designer', 'default', 'default']),
    );
  });

  it('makes a new schedule in the profile the person is in, with no second picker', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub([]);
    mount(<SchedulesScreen />, fetchImpl);
    await screen.findByText('Logo review');
    expect(screen.queryByTestId('schedule-workspace')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('schedule-new-profile')).toHaveTextContent(
        'New schedules are made in Default.',
      ),
    );
    await user.type(screen.getByTestId('schedule-name'), 'Daily');
    await user.click(screen.getByTestId('schedule-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === '/schedules' && c.method === 'POST')).toBe(true),
    );
    expect(seen.find((c) => c.path === '/schedules' && c.method === 'POST')!.profile).toBe(
      'default',
    );
  });

  it('acts on a schedule in its own profile', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub([]);
    mount(<SchedulesScreen />, fetchImpl);
    await screen.findByText('Logo review');
    const card = screen
      .getAllByTestId('schedule-card')
      .find((el) => el.textContent?.includes('Logo review'))!;
    await user.click(within(card).getByRole('switch'));
    await waitFor(() => expect(seen.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = seen.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe(`/schedules/${SCHEDULES[0]!.id}`);
    expect(patch.profile).toBe('designer');
  });

  it('hears every profile on the schedules socket, and redraws on an event from any', async () => {
    const { seen, fetchImpl } = fakeHub([]);
    mount(<SchedulesScreen />, fetchImpl);
    await screen.findByText('Logo review');
    await waitFor(() => expect(sockets.some((s) => s.namespace === '/rt/schedules')).toBe(true));
    const entry = sockets.find((s) => s.namespace === '/rt/schedules')!;
    expect(entry.profiles).toBe('all');
    const before = seen.filter((c) => c.path === '/schedules' && c.method === 'GET').length;
    entry.socket.deliver('schedule.created', {
      event: 'schedule.created',
      namespace: '/rt/schedules',
      profile: 'designer',
      ts: '2026-09-24T00:00:00Z',
      seq: 1,
      payload: { schedule: SCHEDULES[0] },
    });
    await waitFor(() =>
      expect(seen.filter((c) => c.path === '/schedules' && c.method === 'GET').length).toBe(
        before + 1,
      ),
    );
  });
});
