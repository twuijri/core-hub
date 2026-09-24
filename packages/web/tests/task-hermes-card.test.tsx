/**
 * A card on Hermes's board is a real mirror (owner, 2026-09-24): it can be edited, commented
 * on, deleted, stopped and handed to another profile from the hub — the hub makes each
 * change on Hermes first. Here: that the board offers those actions on a Hermes card, that
 * the dialogs ask the hub for the right thing in the card's own workspace, and that Hermes's
 * refusal is shown in Hermes's words.
 *
 * What the hub then does with Hermes is asserted in the server's suite
 * (`packages/server/src/modules/tasks/hermes-api.test.ts`, and the real-Hermes test).
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
import { HandOverDialog } from '../src/tasks/HandOverDialog.js';
import { TaskDialog } from '../src/tasks/TaskDialog.js';
import { TaskCard, type CardActions } from '../src/tasks/TasksScreen.js';
import type { Task } from '../src/tasks/queries.js';
import { chooseOption, openControl } from './helpers/ui.js';

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

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const TASK = '01J8QK3ZR2W7M5N4P6T8V9X0TK';

function hermesCard(over: Partial<Task> = {}): Task {
  return {
    id: TASK,
    project_id: '01J8QK3ZR2W7M5N4P6T8V9X0PJ',
    title: 'مراجعة العقد',
    description: 'الوصف القديم',
    status: 'ready',
    priority: 'normal',
    tags: [],
    assignee: { kind: 'agent', id: HERMES, name: 'Hermes' },
    position: 'n',
    blocked_reason: null,
    subtask_counts: { total: 0, done: 0 },
    depends_on: [],
    due_at: null,
    external: { source: 'hermes', id: 't_00000001' },
    // Not the header's workspace: every write must name the card's own.
    profile: 'design',
    session_id: null,
    latest_summary: null,
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  profile: string | null;
  body: unknown;
}

type Answer = { status: number; body: unknown } | undefined;

function harness(children: ReactNode, answer: (call: Call) => Answer = () => undefined) {
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
    const given = answer(call);
    if (given) return json(given.body, given.status);
    if (url.includes('/profiles'))
      return json({
        items: [
          { id: 'w1', slug: 'default', name: 'Default' },
          { id: 'w2', slug: 'design', name: 'Design' },
          { id: 'w3', slug: 'ops', name: 'Operations' },
        ],
      });
    if (url.includes('/agents')) return json({ items: [] });
    if (url.endsWith(`/tasks/${TASK}`) && call.method === 'GET') {
      return json({
        ...hermesCard(),
        comments: [
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0C1',
            task_id: TASK,
            author: { kind: 'agent', id: null, name: 'design' },
            content: 'بدأت العمل',
            created_at: '2026-09-24T09:00:00Z',
          },
        ],
      });
    }
    return json({ task_id: TASK, job_id: null, run_id: null, session_id: null }, 200);
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
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

function card(value: Task, given = actions()) {
  return (
    <DndContext>
      <SortableContext items={[value.id]}>
        <ul>
          <TaskCard task={value} actions={given} />
        </ul>
      </SortableContext>
    </DndContext>
  );
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

afterEach(cleanup);

describe("a Hermes card's menu", () => {
  it('offers details, rename, hand-over and delete — and never the hub worker', async () => {
    const user = userEvent.setup();
    const given = actions();
    harness(card(hermesCard(), given));
    await openControl(user, screen.getByTestId('task-more'));
    const names = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(names).toEqual(
      expect.arrayContaining(['Hand to another profile…', 'Details…', 'Rename', 'Delete']),
    );
    expect(names.some((name) => /Assign/.test(name ?? ''))).toBe(false);
    await user.click(screen.getByRole('menuitem', { name: 'Details…' }));
    expect(given.onEdit).toHaveBeenCalledOnce();
    await openControl(user, screen.getByTestId('task-more'));
    await user.click(await screen.findByRole('menuitem', { name: 'Hand to another profile…' }));
    expect(given.onHandOver).toHaveBeenCalledOnce();
    await openControl(user, screen.getByTestId('task-more'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(given.onDelete).toHaveBeenCalledOnce();
  });

  it('a running Hermes card can be stopped from the card', async () => {
    const user = userEvent.setup();
    const given = actions();
    harness(card(hermesCard({ status: 'running' }), given));
    await user.click(screen.getByTestId('task-stop'));
    expect(given.onStop).toHaveBeenCalledOnce();
  });

  it('a finished Hermes card is not handed anywhere', async () => {
    const user = userEvent.setup();
    harness(card(hermesCard({ status: 'done' })));
    await openControl(user, screen.getByTestId('task-more'));
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: 'Hand to another profile…' })).toBeNull();
  });
});

describe('the details dialog', () => {
  it("shows Hermes's comments and saves only what changed, in the card's workspace", async () => {
    const user = userEvent.setup();
    const calls = harness(<TaskDialog task={hermesCard()} onClose={() => {}} />, (call) =>
      call.method === 'PATCH'
        ? { status: 200, body: hermesCard({ title: 'عقد جديد' }) }
        : undefined,
    );
    expect(
      await screen.findByText("This card is on Hermes's board: changes are made on Hermes first."),
    ).toBeVisible();
    expect((await screen.findByTestId('task-comment')).textContent).toContain('بدأت العمل');
    const detail = calls.find((call) => call.url.endsWith(`/tasks/${TASK}`));
    expect(detail?.profile).toBe('design');

    const title = screen.getByTestId('task-dialog-title');
    await user.clear(title);
    await user.type(title, 'عقد جديد');
    await chooseOption(user, screen.getByTestId('task-dialog-priority'), 'Urgent');
    await user.click(screen.getByTestId('task-dialog-save'));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: 'PATCH',
      profile: 'design',
      body: { title: 'عقد جديد', priority: 'urgent' },
    });
  });

  it("posts a comment, and shows Hermes's refusal in Hermes's words", async () => {
    const user = userEvent.setup();
    const calls = harness(<TaskDialog task={hermesCard()} onClose={() => {}} />, (call) =>
      call.method === 'POST' && call.url.endsWith('/comments')
        ? {
            status: 409,
            body: {
              error: 'Conflict',
              code: 'conflict',
              details: { reason: 'hermes_refused', message: 'body is required' },
            },
          }
        : undefined,
    );
    await screen.findByTestId('task-comment');
    await user.type(screen.getByTestId('task-comment-input'), 'تمام');
    await user.click(screen.getByTestId('task-comment-send'));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: 'POST',
      profile: 'design',
      body: { content: 'تمام' },
    });
    expect(await screen.findByText('Hermes said no: body is required')).toBeVisible();
  });
});

describe('handing a Hermes card to another profile', () => {
  it('offers the other profiles by name and hands it to the one chosen', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const calls = harness(<HandOverDialog task={hermesCard()} onClose={onClose} />);
    const picker = await screen.findByTestId('task-handover-workspace');
    await openControl(user, picker);
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    // Not the card's own profile.
    expect(options).toEqual(['Default', 'Operations']);
    await user.click(screen.getByRole('option', { name: 'Operations' }));
    await user.click(screen.getByTestId('task-handover-submit'));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: 'POST',
      profile: 'design',
      body: { agent_id: HERMES, profile: 'ops', start: false, instructions: null },
    });
    expect(writes(calls)[0]!.url).toContain(`/tasks/${TASK}/assign`);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('asks first when the card is running, and sends nothing when the person says no', async () => {
    const user = userEvent.setup();
    const calls = harness(
      <HandOverDialog task={hermesCard({ status: 'running' })} onClose={() => {}} />,
    );
    await screen.findByTestId('task-handover-workspace');
    await user.click(screen.getByTestId('task-handover-submit'));
    const confirm = await screen.findByTestId('confirm-dialog');
    expect(confirm.textContent).toContain('Hermes stops its current run first');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByTestId('task-handover-submit'));
    const again = await screen.findByTestId('confirm-dialog');
    await user.click(within(again).getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
  });
});
