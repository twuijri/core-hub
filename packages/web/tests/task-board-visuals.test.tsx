/**
 * The board's visual language (owner's board decision of 2026-09-17, rebuilt in Majlis):
 * a card says its stage with a frame drawn for it *and* the word, a todo card offers the
 * promote button, the Waiting strip opens when it has something, and Done keeps the
 * archive behind a link — read-only — with archiving asked for before it happens.
 *
 * What the frames look like is photographed by the Playwright journey; here, that each
 * card carries the right frame, word and controls, and that the screen asks the hub for
 * the right things.
 */
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { TASK_STATUSES, type TaskStatus } from '../src/tasks/board.js';
import { TaskCard, TasksScreen } from '../src/tasks/TasksScreen.js';
import type { Task } from '../src/tasks/queries.js';

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

let serial = 0;
function task(over: Partial<Task> = {}): Task {
  serial += 1;
  return {
    id: `01J8QK3ZR2W7M5N4P6T8V9X${String(serial).padStart(3, '0')}`,
    project_id: '01J8QK3ZR2W7M5N4P6T8V9X0PJ',
    title: `Task ${serial}`,
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
    profile: 'default',
    session_id: null,
    latest_summary: null,
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A hub that answers the board from `board` and the archive from `archived`. */
function hub(board: Task[], archived: Task[] = []) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const columns = (withArchive: boolean) =>
    TASK_STATUSES.map((status) => {
      const tasks =
        status === 'archived'
          ? withArchive
            ? archived
            : []
          : board.filter((one) => one.status === status);
      return { status, count: tasks.length, tasks };
    });
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/task-columns')) {
      const withArchive = url.includes('include_archived=true');
      const all = columns(withArchive);
      return json({
        project_id: null,
        columns: all,
        counts: { total: all.reduce((sum, c) => sum + c.count, 0) },
      });
    }
    if (url.includes('/move')) return json(board[0]);
    return json({ items: [] });
  };
  return { calls, fetchImpl };
}

function mount(children: ReactNode, fetchImpl: typeof fetch = hub([]).fetchImpl) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>{children}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const noActions = () => ({
  onMove: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onAssign: vi.fn(),
  onStop: vi.fn(),
  onUnassign: vi.fn(),
});

function card(value: Task, actions = noActions()) {
  return (
    <DndContext>
      <SortableContext items={[value.id]}>
        <ul>
          <TaskCard task={value} actions={actions} />
        </ul>
      </SortableContext>
    </DndContext>
  );
}

afterEach(cleanup);

describe('a card tells its stage by a frame and a word', () => {
  const cases: Array<[TaskStatus, string, string]> = [
    ['running', 'Running', 'mj-badge-success'],
    ['blocked', 'Blocked', 'mj-badge-danger'],
    ['scheduled', 'Scheduled', 'mj-badge-warning'],
    ['review', 'Review', 'task-status-review'],
    ['ready', 'Ready', 'mj-badge-info'],
  ];
  for (const [status, word, tone] of cases) {
    it(`${status}: its own frame, its word, its tone`, () => {
      mount(card(task({ status })));
      const node = screen.getByTestId('task-card');
      expect(node).toHaveAttribute('data-frame', status);
      const badge = screen.getByTestId('task-status');
      expect(badge).toHaveTextContent(word);
      expect(badge.className).toContain(tone);
    });
  }

  it('a scheduled card carries a clock beside the word', () => {
    mount(card(task({ status: 'scheduled' })));
    expect(within(screen.getByTestId('task-status')).getByTestId('task-clock')).toBeTruthy();
  });

  it('only a scheduled card has the clock', () => {
    mount(card(task({ status: 'blocked' })));
    expect(screen.queryByTestId('task-clock')).toBeNull();
  });

  it('a running card keeps its live dot inside the word', () => {
    const { container } = mount(card(task({ status: 'running' })));
    expect(container.querySelector('.task-status .task-card-live')).not.toBeNull();
  });

  it('a todo card is plain: no frame and no word, the queue already says it', () => {
    mount(card(task({ status: 'todo' })));
    expect(screen.getByTestId('task-card')).not.toHaveAttribute('data-frame');
    expect(screen.queryByTestId('task-status')).toBeNull();
  });
});

describe('the promote button', () => {
  it('a todo card offers it, and it moves the task to ready', async () => {
    const user = userEvent.setup();
    const actions = noActions();
    mount(card(task({ status: 'todo' }), actions));
    const quick = screen.getByTestId('task-quick');
    expect(quick).toHaveAttribute('data-action', 'promote');
    expect(quick).toHaveTextContent('Ready');
    await user.click(quick);
    expect(actions.onMove).toHaveBeenCalledWith('ready');
  });

  it('no other card in the queue or waiting offers it', () => {
    for (const status of ['ready', 'running', 'blocked', 'scheduled', 'review'] as const) {
      mount(card(task({ status })));
      const quick = screen.queryByTestId('task-quick');
      expect(quick?.getAttribute('data-action') ?? null, status).not.toBe('promote');
      cleanup();
    }
  });
});

describe('the board: the Waiting strip and the archive behind Done', () => {
  it('Waiting is a strip while empty, and opens when clicked', async () => {
    const user = userEvent.setup();
    mount(<TasksScreen />, hub([task({ status: 'todo' })]).fetchImpl);
    const waiting = await screen.findByLabelText('Waiting');
    await waitFor(() => expect(waiting).toHaveAttribute('data-collapsed', 'true'));
    await user.click(screen.getByTestId('column-toggle-waiting'));
    expect(waiting).not.toHaveAttribute('data-collapsed');
  });

  it('Waiting opens by itself when it holds a task', async () => {
    mount(<TasksScreen />, hub([task({ status: 'blocked', blocked_reason: 'key' })]).fetchImpl);
    const waiting = await screen.findByLabelText('Waiting');
    await waitFor(() => expect(within(waiting).getByTestId('task-card')).toBeTruthy());
    expect(waiting).not.toHaveAttribute('data-collapsed');
  });

  it('shows the archive behind a counted link, read-only', async () => {
    const user = userEvent.setup();
    const { calls, fetchImpl } = hub(
      [task({ status: 'done', title: 'Shipped' })],
      [task({ status: 'archived', title: 'Old one' }), task({ status: 'archived' })],
    );
    mount(<TasksScreen />, fetchImpl);
    const toggle = await screen.findByTestId('task-archive-toggle');
    expect(toggle).toHaveTextContent('Show archived (2)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('task-archive')).toBeNull();
    // The archive is its own read, with `include_archived`; the board itself is not.
    expect(calls.some((c) => c.url.includes('include_archived=true'))).toBe(true);

    await user.click(toggle);
    const archive = screen.getByTestId('task-archive');
    expect(within(archive).getAllByTestId('task-card-archived')).toHaveLength(2);
    expect(archive).toHaveTextContent('Old one');
    // Read-only: nothing to drag, no menu, no quick action.
    expect(within(archive).queryByTestId('task-more')).toBeNull();
    expect(within(archive).queryByTestId('task-quick')).toBeNull();
    expect(within(archive).queryByRole('button')).toBeNull();
    expect(toggle).toHaveTextContent('Hide archived (2)');
  });

  it('no archive, no link', async () => {
    mount(<TasksScreen />, hub([task({ status: 'done' })]).fetchImpl);
    await screen.findByText('Task ' + String(serial));
    expect(screen.queryByTestId('task-archive-toggle')).toBeNull();
  });

  it('archiving a done card asks first, and only then moves it', async () => {
    const user = userEvent.setup();
    const { calls, fetchImpl } = hub([task({ status: 'done', title: 'Shipped' })]);
    mount(<TasksScreen />, fetchImpl);
    const quick = await screen.findByTestId('task-quick');
    expect(quick).toHaveAttribute('data-action', 'archive');
    await user.click(quick);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('Archive “Shipped”?');
    expect(calls.some((c) => c.url.includes('/move'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/move'))).toBe(true));
    const moved = calls.find((c) => c.url.includes('/move'))!;
    expect(moved.method).toBe('POST');
    expect(moved.body).toMatchObject({ status: 'archived' });
  });

  it('cancelling the confirmation leaves the card where it is', async () => {
    const user = userEvent.setup();
    const { calls, fetchImpl } = hub([task({ status: 'done', title: 'Shipped' })]);
    mount(<TasksScreen />, fetchImpl);
    await user.click(await screen.findByTestId('task-quick'));
    const dialog = await screen.findByTestId('confirm-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(calls.some((c) => c.url.includes('/move'))).toBe(false);
  });
});
