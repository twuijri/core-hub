/**
 * Several cards at once (contract decision §102): "Select" on the Tasks board ticks cards, and
 * the bar that comes with it sets one priority or says one comment on all of them. The board
 * holds every profile, and a bulk edit is made in one, so the ticked cards go in one request per
 * profile they are in — a Hermes card's change is then made on Hermes first by the hub
 * (`packages/server/src/modules/tasks/hermes-api.test.ts`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseOption } from './helpers/ui.js';

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
    ack?.({ ok: true });
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
const { TasksScreen } = await import('../src/tasks/TasksScreen.js');
const { TASK_STATUSES } = await import('../src/tasks/board.js');

afterEach(cleanup);

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

const A = '01J8QK3ZR2W7M5N4P6T8V9X0TA';
const B = '01J8QK3ZR2W7M5N4P6T8V9X0TB';
const C = '01J8QK3ZR2W7M5N4P6T8V9X0TC';

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

const TASKS = [
  task(A, 'default', 'Release notes'),
  task(B, 'designer', 'New logo', { external: { source: 'hermes', id: 't_00000001' } }),
  task(C, 'default', 'Untouched'),
];

interface Seen {
  method: string;
  path: string;
  profile: string | null;
  body: unknown;
}

function fakeHub(refuse: string[] = []) {
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
    seen.push({ method, path, profile, body });
    if (path === '/profiles')
      return json({
        items: [
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'designer', name: 'Designer' },
        ],
      });
    if (path === '/task-columns') {
      const columns = TASK_STATUSES.map((status) => {
        const items = TASKS.filter((t) => t.status === status);
        return { status, count: items.length, tasks: items };
      });
      return json({ project_id: null, columns, counts: { total: TASKS.length } });
    }
    if (path === '/tasks' && method === 'PATCH') {
      const ids = (body as { task_ids: string[] }).task_ids;
      return json({
        results: ids.map((id) =>
          refuse.includes(id)
            ? { id, ok: false, error: { error: 'conflict', code: 'conflict' } }
            : { id, ok: true, error: null },
        ),
      });
    }
    return json({ items: [] });
  };
  return { seen, fetchImpl };
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
}

const cardOf = (id: string) =>
  screen.getAllByTestId('task-card').find((el) => el.getAttribute('data-task-id') === id)!;
const bulkWrites = (seen: Seen[]) =>
  seen.filter((c) => c.method === 'PATCH' && c.path === '/tasks');

describe('the board edits several cards at once (§102)', () => {
  it('sets one priority on the ticked cards, one request per profile they are in', async () => {
    const user = userEvent.setup();
    const hub = fakeHub();
    mount(<TasksScreen />, hub.fetchImpl);
    await screen.findByText('New logo');
    expect(screen.queryByTestId('task-bulk-bar')).toBeNull();
    await user.click(screen.getByTestId('task-select'));
    const bar = screen.getByTestId('task-bulk-bar');
    expect(within(bar).getByTestId('task-bulk-count')).toHaveTextContent('0 selected');
    // Selecting: the tick stands where the grip was.
    await user.click(within(cardOf(A)).getByTestId('task-tick'));
    await user.click(within(cardOf(B)).getByTestId('task-tick'));
    expect(within(bar).getByTestId('task-bulk-count')).toHaveTextContent('2 selected');

    await chooseOption(user, within(bar).getByTestId('task-bulk-priority'), 'Urgent');
    await waitFor(() => expect(bulkWrites(hub.seen)).toHaveLength(2));
    const byProfile = new Map(bulkWrites(hub.seen).map((c) => [c.profile, c.body]));
    expect(byProfile.get('default')).toEqual({ task_ids: [A], patch: { priority: 'urgent' } });
    expect(byProfile.get('designer')).toEqual({ task_ids: [B], patch: { priority: 'urgent' } });
  });

  it('says one comment on all of them, and tells how many were not changed', async () => {
    const user = userEvent.setup();
    const hub = fakeHub([B]);
    mount(<TasksScreen />, hub.fetchImpl);
    await screen.findByText('New logo');
    await user.click(screen.getByTestId('task-select'));
    await user.click(within(cardOf(A)).getByTestId('task-tick'));
    await user.click(within(cardOf(B)).getByTestId('task-tick'));
    await user.click(screen.getByTestId('task-bulk-comment'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Review before Thursday');
    await user.click(within(dialog).getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(bulkWrites(hub.seen)).toHaveLength(2));
    for (const write of bulkWrites(hub.seen)) {
      expect(write.body).toMatchObject({ patch: { comment: 'Review before Thursday' } });
    }
    // Hermes refused the one on its board: the board says so, and keeps the selection.
    expect(
      await screen.findByText('Not changed: 1 (Hermes refused, or they are gone). Changed: 1.'),
    ).toBeVisible();
    expect(screen.getByTestId('task-bulk-count')).toHaveTextContent('2 selected');

    await user.click(screen.getByTestId('task-bulk-done'));
    expect(screen.queryByTestId('task-bulk-bar')).toBeNull();
    expect(within(cardOf(A)).queryByTestId('task-tick')).toBeNull();
  });
});
