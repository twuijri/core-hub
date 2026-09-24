/**
 * Assigning a task starts it (2026-09-24): the dialog that asks for it, and the card that
 * shows what came of it — running with a way to stop it and a way into its conversation,
 * then the agent's last words in Review, or the reason in Blocked.
 *
 * What the hub does with the request is asserted in the server's own suite
 * (`packages/server/tests/unit/task-runs.test.ts`); here, that the client asks for it.
 */
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { AssignDialog } from '../src/tasks/AssignDialog.js';
import { TaskCard } from '../src/tasks/TasksScreen.js';
import type { Task } from '../src/tasks/queries.js';
import type { Agent } from '../src/types.js';
import { openControl } from './helpers/ui.js';

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
const CODEX = '01J8QK3ZR2W7M5N4P6T8V9X0CX';
const GEMINI = '01J8QK3ZR2W7M5N4P6T8V9X0GM';
const TASK = '01J8QK3ZR2W7M5N4P6T8V9X0TK';
const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YE';

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    profile: 'default',
    slug: name.toLowerCase(),
    name,
    status: 'available',
    enabled: true,
    ...(over as Record<string, unknown>),
  } as unknown as Agent;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: TASK,
    project_id: '01J8QK3ZR2W7M5N4P6T8V9X0PJ',
    title: 'صفحة الإعدادات',
    description: null,
    status: 'ready',
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

function harness(children: ReactNode, agents: Agent[] = []) {
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
    if (url.includes('/assign')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { start?: boolean };
      calls.push({ method: init?.method ?? 'GET', url, body });
      return json(
        body.start
          ? { task_id: TASK, job_id: 'j', run_id: 'r', session_id: SESSION }
          : { task_id: TASK, job_id: null, run_id: null, session_id: null },
        202,
      );
    }
    return json(url.includes('/agents') ? { items: agents } : { items: [] });
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

const noActions = () => ({
  onMove: vi.fn(),
  onRename: vi.fn(),
  onEdit: vi.fn(),
  onHandOver: vi.fn(),
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

describe('the assign dialog asks the hub to start the task', () => {
  it('offers only the agents that can run here, and "assign and start" starts', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const calls = harness(<AssignDialog task={task()} onClose={onClose} />, [
      agent(HERMES, 'Hermes'),
      agent(CODEX, 'Codex'),
      agent(GEMINI, 'Gemini CLI', { status: 'not_installed' }),
    ]);
    const picker = await screen.findByTestId('task-assign-agent');
    await waitFor(() => expect(picker.textContent).toContain('Hermes'));
    await openControl(user, picker);
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Hermes', 'Codex']);
    await user.keyboard('{Escape}');

    await user.type(screen.getByTestId('task-assign-instructions'), 'Start with the account tab.');
    await user.click(screen.getByTestId('task-assign-start'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain(`/tasks/${TASK}/assign`);
    expect(calls[0]!.body).toEqual({
      agent_id: HERMES,
      start: true,
      instructions: 'Start with the account tab.',
      model: null,
      provider: null,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('"assign only" assigns without starting, and sends no empty instructions', async () => {
    const user = userEvent.setup();
    const calls = harness(<AssignDialog task={task()} onClose={() => {}} />, [
      agent(CODEX, 'Codex'),
    ]);
    const only = await screen.findByTestId('task-assign-only');
    await waitFor(() => expect(only).toBeEnabled());
    await user.click(only);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ agent_id: CODEX, start: false, instructions: null });
  });

  it('says so when no agent can take a task, instead of an empty picker', async () => {
    harness(<AssignDialog task={task()} onClose={() => {}} />, [
      agent(GEMINI, 'Gemini CLI', { status: 'not_installed' }),
    ]);
    expect(await screen.findByText(/No agent on this hub can take a task yet/)).toBeVisible();
    expect(screen.getByTestId('task-assign-start')).toBeDisabled();
  });
});

describe('the card shows what the run is doing', () => {
  it('a running card can be stopped, and opens its conversation', async () => {
    const user = userEvent.setup();
    const actions = noActions();
    harness(
      card(
        task({
          status: 'running',
          session_id: SESSION,
          assignee: { kind: 'agent', id: CODEX, name: 'Codex' },
        }),
        actions,
      ),
    );
    expect(screen.getByText('Running')).toBeVisible();
    expect(screen.getByTestId('task-agent').textContent).toBe('Codex');
    expect(screen.getByTestId('task-session')).toHaveAttribute('href', `/chat/${SESSION}`);
    // Stop replaces the quick move: a running card's next move is the worker's, not ours.
    expect(screen.queryByTestId('task-quick')).toBeNull();
    await user.click(screen.getByTestId('task-stop'));
    expect(actions.onStop).toHaveBeenCalledOnce();
  });

  it('a card in Review carries the agent’s last words', () => {
    harness(
      card(
        task({
          status: 'review',
          session_id: SESSION,
          latest_summary: 'Added the page and its test. Left: the copy.',
        }),
      ),
    );
    expect(screen.getByTestId('task-summary').textContent).toBe(
      'Added the page and its test. Left: the copy.',
    );
    expect(screen.queryByTestId('task-stop')).toBeNull();
  });

  it('a blocked card says why', () => {
    harness(card(task({ status: 'blocked', blocked_reason: 'The run failed: no key' })));
    expect(screen.getByTestId('task-blocked-reason').textContent).toBe('The run failed: no key');
  });

  it('the menu offers assigning, and a card with an agent can be unassigned', async () => {
    const user = userEvent.setup();
    const actions = noActions();
    harness(card(task({ assignee: { kind: 'agent', id: CODEX, name: 'Codex' } }), actions));
    await openControl(user, screen.getByTestId('task-more'));
    await user.click(await screen.findByRole('menuitem', { name: 'Reassign…' }));
    expect(actions.onAssign).toHaveBeenCalledOnce();
    await openControl(user, screen.getByTestId('task-more'));
    await user.click(await screen.findByRole('menuitem', { name: 'Unassign' }));
    expect(actions.onUnassign).toHaveBeenCalledOnce();
  });

  it("a card on Hermes's board is not offered to the hub's worker", async () => {
    const user = userEvent.setup();
    harness(card(task({ external: { source: 'hermes', id: 't_1' } })));
    await openControl(user, screen.getByTestId('task-more'));
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: /Assign/ })).toBeNull();
  });
});
