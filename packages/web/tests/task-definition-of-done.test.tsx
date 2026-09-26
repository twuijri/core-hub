/**
 * A task's definition of done and its constraints (contract decision §103) on the web: written
 * in the details dialog, ticked there by the reviewer while the task is in review, counted on
 * the board card — and never offered on a Hermes card, which shows Hermes's own history
 * instead (§102).
 *
 * The hub's half — that the lists reach the agent's prompt and a new run clears the ticks — is
 * `packages/server/tests/unit/task-definition-of-done.test.ts`.
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
import { TaskDialog } from '../src/tasks/TaskDialog.js';
import { TaskCard, type CardActions } from '../src/tasks/TasksScreen.js';
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

const TASK = '01J8QK3ZR2W7M5N4P6T8V9X0TK';

function hubTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK,
    project_id: '01J8QK3ZR2W7M5N4P6T8V9X0PJ',
    title: 'صفحة الإعدادات',
    description: null,
    status: 'review',
    priority: 'normal',
    tags: [],
    assignee: null,
    position: 'n',
    blocked_reason: null,
    subtask_counts: { total: 0, done: 0 },
    depends_on: [],
    due_at: null,
    external: null,
    profile: 'design',
    session_id: null,
    latest_summary: null,
    definition_of_done: [
      { text: 'Tests pass', checked: false },
      { text: 'Works on a phone', checked: true },
    ],
    constraints: [{ text: 'No new libraries', checked: false }],
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  profile: string | null;
  body: unknown;
}

function harness(children: ReactNode, detail: () => unknown, language: 'en' | 'ar' = 'en') {
  const calls: Call[] = [];
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      profile: headers['X-Hub-Profile'] ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (url.includes('/profiles')) return json({ items: [] });
    if (url.endsWith(`/tasks/${TASK}`) && call.method === 'GET') return json(detail());
    if (url.endsWith(`/tasks/${TASK}`) && call.method === 'PATCH')
      return json({ ...(detail() as object), ...(call.body as object) });
    return json({ items: [] });
  };
  render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter>{children}</MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return calls;
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

afterEach(cleanup);

describe('definition of done and constraints in the details dialog (§103)', () => {
  it('lets the reviewer tick a line in review, add one, and saves the whole list', async () => {
    const user = userEvent.setup();
    const calls = harness(<TaskDialog task={hubTask()} onClose={() => {}} />, () => ({
      ...hubTask(),
      comments: [],
    }));
    const dod = await screen.findByTestId('task-dod');
    expect(within(dod).getByText('In review: tick each line that holds, then Save.')).toBeVisible();
    expect(within(dod).getByTestId('task-dod-count')).toHaveTextContent('1 of 2 ticked');
    const ticks = within(dod).getAllByTestId('task-dod-tick');
    expect(ticks[0]).toBeEnabled();
    await user.click(ticks[0]!);
    await user.type(within(dod).getByTestId('task-dod-input'), 'Screenshot attached{Enter}');
    expect(within(dod).getAllByTestId('task-dod-line')).toHaveLength(3);
    // A constraint removed: its list is sent too.
    const constraints = screen.getByTestId('task-constraints');
    await user.click(within(constraints).getByTestId('task-constraints-remove'));

    await user.click(screen.getByTestId('task-dialog-save'));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: 'PATCH',
      profile: 'design',
      body: {
        definition_of_done: [
          { text: 'Tests pass', checked: true },
          { text: 'Works on a phone', checked: true },
          { text: 'Screenshot attached', checked: false },
        ],
        constraints: [],
      },
    });
  });

  it('shows the ticks outside review without letting anyone change them', async () => {
    harness(<TaskDialog task={hubTask({ status: 'ready' })} onClose={() => {}} />, () => ({
      ...hubTask({ status: 'ready' }),
      comments: [],
    }));
    const dod = await screen.findByTestId('task-dod');
    for (const tick of within(dod).getAllByTestId('task-dod-tick')) expect(tick).toBeDisabled();
    expect(
      within(dod).getByText(
        'What must be true for the task to count as done. The agent is given these with every run.',
      ),
    ).toBeVisible();
    // Nothing changed, nothing to save.
    expect(screen.getByTestId('task-dialog-save')).toBeDisabled();
  });

  it('says it in Arabic too', async () => {
    harness(
      <TaskDialog task={hubTask()} onClose={() => {}} />,
      () => ({ ...hubTask(), comments: [] }),
      'ar',
    );
    const dod = await screen.findByTestId('task-dod');
    expect(within(dod).getByRole('heading', { name: 'تعريف الإنجاز' })).toBeVisible();
    expect(within(dod).getByTestId('task-dod-count')).toHaveTextContent('1 من 2 مُعلَّمة');
    expect(
      within(screen.getByTestId('task-constraints')).getByRole('heading', { name: 'القيود' }),
    ).toBeVisible();
  });
});

describe("a Hermes card's details (§102)", () => {
  const hermesCard = hubTask({
    status: 'running',
    external: { source: 'hermes', id: 't_00000001' },
    definition_of_done: [],
    constraints: [],
  });

  it("shows Hermes's own runs and events instead of lists Hermes would never see", async () => {
    harness(<TaskDialog task={hermesCard} onClose={() => {}} />, () => ({
      ...hermesCard,
      comments: [],
      hermes: {
        runs: [
          {
            id: 5,
            profile: 'design',
            status: 'running',
            outcome: null,
            summary: null,
            error: null,
            started_at: '2026-09-21T14:25:00Z',
            ended_at: null,
          },
          {
            id: 4,
            profile: 'design',
            status: 'crashed',
            outcome: 'crashed',
            summary: null,
            error: 'worker exited with 137',
            started_at: '2026-09-21T14:14:20Z',
            ended_at: '2026-09-21T14:20:00Z',
          },
        ],
        events: [
          { id: 3, kind: 'claimed', run_id: 5, payload: null, created_at: '2026-09-21T14:25:00Z' },
          {
            id: 2,
            kind: 'some_new_hermes_event',
            run_id: null,
            payload: null,
            created_at: '2026-09-21T14:21:00Z',
          },
          {
            id: 1,
            kind: 'created',
            run_id: null,
            payload: null,
            created_at: '2026-09-21T14:13:20Z',
          },
        ],
      },
    }));
    const history = await screen.findByTestId('task-hermes-history');
    const runs = within(history).getAllByTestId('task-hermes-run');
    expect(runs.map((run) => run.textContent)).toEqual([
      expect.stringContaining('Running'),
      expect.stringContaining('worker exited with 137'),
    ]);
    expect(runs[1]).toHaveTextContent('Crashed');
    const events = within(history).getAllByTestId('task-hermes-event');
    expect(events.map((event) => event.getAttribute('data-kind'))).toEqual([
      'claimed',
      'some_new_hermes_event',
      'created',
    ]);
    expect(events[0]).toHaveTextContent('Picked up by a worker');
    expect(events[0]).toHaveTextContent('attempt 5');
    // A kind this client does not know is shown as Hermes wrote it, not hidden.
    expect(events[1]).toHaveTextContent('some_new_hermes_event');
    expect(events[2]).toHaveTextContent('Created');
    expect(screen.queryByTestId('task-dod')).toBeNull();
    expect(screen.queryByTestId('task-constraints')).toBeNull();
  });
});

describe('the board card (§103)', () => {
  const actions = (): CardActions => ({
    onMove: vi.fn(),
    onRename: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onAssign: vi.fn(),
    onHandOver: vi.fn(),
    onStop: vi.fn(),
    onUnassign: vi.fn(),
  });
  const card = (value: Task) => (
    <DndContext>
      <SortableContext items={[value.id]}>
        <ul>
          <TaskCard task={value} actions={actions()} />
        </ul>
      </SortableContext>
    </DndContext>
  );

  it('counts the ticked lines of its definition of done, and says nothing when it has none', async () => {
    harness(card(hubTask()), () => ({}));
    expect(await screen.findByTestId('task-dod-badge')).toHaveTextContent('1/2');
    cleanup();
    harness(card(hubTask({ definition_of_done: [] })), () => ({}));
    await screen.findByTestId('task-card');
    expect(screen.queryByTestId('task-dod-badge')).toBeNull();
  });
});
