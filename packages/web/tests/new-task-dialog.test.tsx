/**
 * The New task dialog (owner, 2026-09-29: a task with only a name is useless). "New task" on
 * the board opens it; it takes everything `TaskCreate` does, refuses what the hub would refuse
 * before sending, creates with an `Idempotency-Key` as the phones do, and — for "Start now" —
 * starts the task with the chosen model through `tasks.assignTask`, because `TaskCreate` has
 * no model. A Hermes card is Hermes's: no definition of done, no start from the hub.
 *
 * The browser journey is `e2e/zzzzzzzzzzzz-new-task-dialog.spec.ts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { NewTaskDialog } from '../src/tasks/NewTaskDialog.js';
import {
  createBody,
  effectiveWhen,
  emptyForm,
  newUlid,
  parseTags,
  problemsOf,
} from '../src/tasks/newTask.js';
import type { Task } from '../src/tasks/queries.js';
import { chooseInCombobox, chooseOption, stubListViewport } from './helpers/ui.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const DIRECT = '01J8QK3ZR2W7M5N4P6T8V9X0AD';
const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AH';
const PROJECT = '01J8QK3ZR2W7M5N4P6T8V9X0PW';
const MADE = '01J8QK3ZR2W7M5N4P6T8V9X0TN';

describe('the rules the dialog sends by', () => {
  it('refuses an empty title and a due moment that has passed', () => {
    const now = new Date('2026-09-29T12:00:00');
    expect(problemsOf(emptyForm(), now)).toEqual({ title: 'required' });
    expect(problemsOf({ ...emptyForm('Ship'), due: '2026-09-28T09:00' }, now)).toEqual({
      due: 'past',
    });
    expect(problemsOf({ ...emptyForm('Ship'), due: '2026-10-01T09:00' }, now)).toEqual({});
  });

  it('splits tags on Latin and Arabic commas, once each', () => {
    expect(parseTags(' web, android،  web ,, ')).toEqual(['web', 'android']);
  });

  it('starts now only with an agent, and never a Hermes card', () => {
    expect(effectiveWhen({ when: 'now', agentId: null, hermes: false })).toBe('later');
    expect(effectiveWhen({ when: 'now', agentId: DIRECT, hermes: false })).toBe('now');
    expect(effectiveWhen({ when: 'auto', agentId: HERMES, hermes: true })).toBe('later');
  });

  it('sends only what was filled, and no lists on a Hermes card', () => {
    const lines = [
      { text: ' Tests pass ', checked: true },
      { text: '  ', checked: false },
    ];
    const full = createBody({
      ...emptyForm(' Ship the page '),
      description: 'Build it\nwith care',
      agentId: DIRECT,
      priority: 'high',
      tags: 'web, ui',
      projectId: PROJECT,
      subtasks: [{ text: 'Outline', checked: false }],
      definitionOfDone: lines,
      constraints: [{ text: 'No new libraries', checked: false }],
      status: 'todo',
      when: 'auto',
    });
    expect(full).toEqual({
      title: 'Ship the page',
      description: 'Build it\nwith care',
      status: 'todo',
      priority: 'high',
      auto_start: true,
      assignee_agent_id: DIRECT,
      project_id: PROJECT,
      tags: ['web', 'ui'],
      subtasks: [{ title: 'Outline' }],
      definition_of_done: [{ text: 'Tests pass', checked: false }],
      constraints: [{ text: 'No new libraries', checked: false }],
    });
    const hermes = createBody({
      ...emptyForm('Card'),
      agentId: HERMES,
      hermes: true,
      definitionOfDone: lines,
      when: 'auto',
    });
    expect(hermes).not.toHaveProperty('definition_of_done');
    expect(hermes.auto_start).toBe(false);
  });

  it('names each create with a fresh ULID', () => {
    const a = newUlid();
    expect(a).toMatch(ULID);
    expect(newUlid()).not.toBe(a);
  });
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

interface Call {
  method: string;
  path: string;
  profile: string | null;
  key: string | null;
  body: Record<string, unknown> | null;
}

interface Answers {
  create?: (attempt: number) => { status: number; body: unknown };
  assign?: (attempt: number) => { status: number; body: unknown };
}

function agentRow(id: string, slug: string, name: string) {
  return { id, slug, name, status: 'available', enabled: true };
}

function madeTask(body: Record<string, unknown>): Partial<Task> {
  return { id: MADE, title: String(body.title), status: body.status as Task['status'] };
}

function mount(answers: Answers = {}) {
  const calls: Call[] = [];
  const created: Array<{ task: Task; started: boolean }> = [];
  let closed = 0;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  let creates = 0;
  let assigns = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({
      method,
      path,
      profile: headers.get('X-Hub-Profile'),
      key: headers.get('Idempotency-Key'),
      body,
    });
    if (path === '/profiles') return json({ items: [] });
    if (path === '/agents')
      return json({
        items: [agentRow(DIRECT, 'direct', 'Direct'), agentRow(HERMES, 'hermes', 'Hermes')],
      });
    if (path === '/projects')
      return json({
        items: [
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P0', name: 'Default', status: 'active' },
          { id: PROJECT, name: 'Website', status: 'active' },
        ],
      });
    if (path === '/models')
      return json({
        items: [
          {
            key: 'openrouter/gpt-x',
            model: 'gpt-x',
            alias: 'GPT X',
            provider: 'openrouter',
            kind: 'chat',
            visible: true,
            disabled: false,
          },
        ],
        next_cursor: null,
      });
    if (path === '/tasks' && method === 'POST') {
      creates += 1;
      const answer = answers.create?.(creates) ?? { status: 201, body: madeTask(body!) };
      return json(answer.body, answer.status);
    }
    if (path.endsWith('/assign')) {
      assigns += 1;
      const answer = answers.assign?.(assigns) ?? {
        status: 200,
        body: { task_id: MADE, job_id: 'j', run_id: 'r', session_id: 's' },
      };
      return json(answer.body, answer.status);
    }
    return json({ items: [] });
  };
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const wrap = (children: ReactNode) => (
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
    </ThemeProvider>
  );
  render(
    wrap(
      <NewTaskDialog
        open
        onClose={() => {
          closed += 1;
        }}
        onCreated={(task, started) => created.push({ task, started })}
      />,
    ),
  );
  return { calls, created, closedCount: () => closed };
}

const posts = (calls: Call[], path: string) =>
  calls.filter((call) => call.method === 'POST' && call.path.endsWith(path));

let undoViewport: () => void = () => {};
beforeEach(() => {
  undoViewport = stubListViewport();
});
afterEach(() => {
  undoViewport();
  cleanup();
});

describe('the New task dialog', () => {
  it('says what is missing and sends nothing without a title', async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    const dialog = await screen.findByTestId('new-task-dialog');
    await user.click(within(dialog).getByTestId('new-task-save'));
    expect(await within(dialog).findByText('Write a title for the task.')).toBeVisible();
    expect(within(dialog).getByTestId('new-task-title')).toHaveAttribute('aria-invalid', 'true');
    expect(posts(calls, '/tasks')).toHaveLength(0);
  });

  it('creates the whole task, then starts it with the chosen model', async () => {
    const user = userEvent.setup();
    const { calls, created, closedCount } = mount();
    const dialog = await screen.findByTestId('new-task-dialog');
    await user.type(within(dialog).getByTestId('new-task-title'), 'Settings page');
    await user.type(
      within(dialog).getByTestId('new-task-description'),
      'Build the tabs from the navigation map.',
    );
    await chooseOption(user, within(dialog).getByTestId('new-task-agent'), 'Direct');
    await chooseInCombobox(user, await within(dialog).findByTestId('new-task-model'), 'GPT X');
    await chooseOption(user, within(dialog).getByTestId('new-task-priority'), 'High');
    await user.type(within(dialog).getByTestId('new-task-tags'), 'web, ui');
    await chooseOption(user, await within(dialog).findByTestId('new-task-project'), 'Website');
    await user.type(within(dialog).getByTestId('task-subtasks-input'), 'Account tab{Enter}');
    await user.type(within(dialog).getByTestId('task-dod-input'), 'Tests pass{Enter}');
    await user.type(within(dialog).getByTestId('task-constraints-input'), 'No new libs{Enter}');
    // "Start now" is the phones' default once an agent is chosen: no status to pick.
    expect(within(dialog).queryByTestId('new-task-status')).toBeNull();
    await user.click(within(dialog).getByTestId('new-task-save'));

    await waitFor(() => expect(posts(calls, '/assign')).toHaveLength(1));
    const [create] = posts(calls, '/tasks');
    expect(create!.profile).toBe('default');
    expect(create!.key).toMatch(ULID);
    expect(create!.body).toMatchObject({
      title: 'Settings page',
      description: 'Build the tabs from the navigation map.',
      assignee_agent_id: DIRECT,
      priority: 'high',
      tags: ['web', 'ui'],
      project_id: PROJECT,
      status: 'triage',
      auto_start: false,
      subtasks: [{ title: 'Account tab' }],
      definition_of_done: [{ text: 'Tests pass', checked: false }],
      constraints: [{ text: 'No new libs', checked: false }],
    });
    expect(posts(calls, '/assign')[0]!.path).toBe(`/tasks/${MADE}/assign`);
    expect(posts(calls, '/assign')[0]!.body).toMatchObject({
      agent_id: DIRECT,
      start: true,
      model: 'openrouter/gpt-x',
    });
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ task: { id: MADE }, started: true });
    expect(closedCount()).toBe(1);
  });

  it("offers no definition of done or start on Hermes's card, and says why", async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    const dialog = await screen.findByTestId('new-task-dialog');
    await user.type(within(dialog).getByTestId('new-task-title'), 'Research brief');
    await chooseOption(user, within(dialog).getByTestId('new-task-agent'), 'Hermes');
    expect(await within(dialog).findByTestId('new-task-hermes')).toBeVisible();
    expect(within(dialog).queryByTestId('task-dod')).toBeNull();
    expect(within(dialog).queryByTestId('new-task-model')).toBeNull();
    expect(within(dialog).queryByTestId('new-task-when-choice')).toBeNull();
    await chooseOption(user, within(dialog).getByTestId('new-task-status'), 'Ready');
    await user.click(within(dialog).getByTestId('new-task-save'));
    await waitFor(() => expect(posts(calls, '/tasks')).toHaveLength(1));
    const body = posts(calls, '/tasks')[0]!.body!;
    expect(body).toMatchObject({ assignee_agent_id: HERMES, status: 'ready', auto_start: false });
    expect(body).not.toHaveProperty('definition_of_done');
    expect(posts(calls, '/assign')).toHaveLength(0);
  });

  it("shows the hub's refusal, and Save again names the same task", async () => {
    const user = userEvent.setup();
    const { calls, created } = mount({
      create: (attempt) =>
        attempt === 1
          ? {
              status: 409,
              body: {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                code: 'conflict',
                message: 'The hub refused the task.',
                details: { reason: 'hermes_owns_text' },
              },
            }
          : { status: 201, body: { id: MADE, title: 'Retry me', status: 'triage' } },
    });
    const dialog = await screen.findByTestId('new-task-dialog');
    await user.type(within(dialog).getByTestId('new-task-title'), 'Retry me');
    await user.click(within(dialog).getByTestId('new-task-save'));
    expect(await within(dialog).findByTestId('new-task-error')).toBeVisible();
    expect(created).toHaveLength(0);
    await user.click(within(dialog).getByTestId('new-task-save'));
    await waitFor(() => expect(created).toHaveLength(1));
    const [first, second] = posts(calls, '/tasks');
    expect(second!.key).toBe(first!.key);
  });

  it('keeps a task whose start failed, and Start again only starts it', async () => {
    const user = userEvent.setup();
    const { calls, created } = mount({
      assign: (attempt) =>
        attempt === 1
          ? {
              status: 422,
              body: {
                type: 'about:blank',
                title: 'Unavailable',
                status: 422,
                code: 'agent_unavailable',
                message: 'The agent cannot take a turn.',
              },
            }
          : { status: 200, body: { task_id: MADE, job_id: 'j', run_id: 'r', session_id: 's' } },
    });
    const dialog = await screen.findByTestId('new-task-dialog');
    await user.type(within(dialog).getByTestId('new-task-title'), 'Start me');
    await chooseOption(user, within(dialog).getByTestId('new-task-agent'), 'Direct');
    await user.click(within(dialog).getByTestId('new-task-save'));
    expect(await within(dialog).findByTestId('new-task-not-started')).toBeVisible();
    expect(within(dialog).getByTestId('new-task-error')).toBeVisible();
    expect(within(dialog).getByTestId('new-task-save')).toHaveTextContent('Start again');
    await user.click(within(dialog).getByTestId('new-task-save'));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(posts(calls, '/tasks')).toHaveLength(1);
    expect(posts(calls, '/assign')).toHaveLength(2);
  });
});
