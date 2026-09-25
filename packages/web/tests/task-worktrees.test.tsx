/**
 * Tasks stage 2 on the web: a project's repository in its settings, a task's worktree in its
 * details (path, branch, state, git's words, Remove), and "Start automatically".
 *
 * What the hub does with them — the real `git worktree`, the start, the limit — is asserted
 * in the server's suite (`packages/server/tests/unit/task-worktrees.test.ts`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { HubApiError } from '@corehub/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { describeTaskError } from '../src/tasks/errors.js';
import { ProjectDialog } from '../src/tasks/ProjectDialog.js';
import { TaskDialog } from '../src/tasks/TaskDialog.js';
import type { Task, Worktree } from '../src/tasks/queries.js';

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
const PROJECT = '01J8QK3ZR2W7M5N4P6T8V9X0PJ';

const worktree = (over: Partial<Worktree> = {}): Worktree => ({
  path: '/data/workspaces/design/worktrees/core-12-settings-page',
  branch: 'task/core-12-settings-page',
  base_branch: 'main',
  status: 'dirty',
  ahead: 2,
  behind: 0,
  changed_files: 3,
  error: null,
  updated_at: '2026-09-25T10:00:00Z',
  ...over,
});

function task(over: Partial<Task> = {}): Task {
  return {
    id: TASK,
    project_id: PROJECT,
    title: 'Settings page',
    description: null,
    status: 'review',
    priority: 'normal',
    tags: [],
    assignee: { kind: 'agent', id: '01J8QK3ZR2W7M5N4P6T8V9X0AG', name: 'Claude Code' },
    position: 'n',
    blocked_reason: null,
    subtask_counts: { total: 0, done: 0 },
    depends_on: [],
    due_at: null,
    external: null,
    // Not the header's profile: every write must name the card's own.
    profile: 'design',
    session_id: null,
    latest_summary: null,
    auto_start: false,
    worktree: worktree(),
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  profile: string | null;
  body: unknown;
}

function harness(
  children: ReactNode,
  answer: (call: Call) => { status: number; body: unknown } | undefined = () => undefined,
  shown: Task = task(),
) {
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
    if (url.endsWith('/projects') && call.method === 'GET') {
      return json({
        items: [
          {
            id: PROJECT,
            name: 'Core Hub',
            status: 'active',
            color: null,
            working_dir: null,
            default_branch: 'main',
            counts: { total: 0, by_status: {} },
          },
        ],
        next_cursor: null,
      });
    }
    if (url.endsWith(`/tasks/${TASK}`) && call.method === 'GET') {
      return json({ ...shown, comments: [] });
    }
    if (url.endsWith(`/tasks/${TASK}/worktree`)) return json({ job_id: 'J' }, 202);
    return json({ ...shown });
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

const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

afterEach(cleanup);

describe("a task's worktree in its details", () => {
  it('shows where it is, its branch and how it stands', async () => {
    harness(<TaskDialog task={task()} onClose={() => {}} />);
    expect(await screen.findByTestId('task-worktree-branch')).toHaveTextContent(
      'task/core-12-settings-page',
    );
    expect(screen.getByTestId('task-worktree-path')).toHaveTextContent(
      '/data/workspaces/design/worktrees/core-12-settings-page',
    );
    expect(screen.getByTestId('task-worktree-status')).toHaveTextContent('Has changes');
    expect(screen.getByTestId('task-worktree')).toHaveTextContent(
      '3 changed files · 2 commits ahead of main',
    );
  });

  it('Remove asks first, then removes it in the card’s own profile', async () => {
    const user = userEvent.setup();
    const calls = harness(<TaskDialog task={task()} onClose={() => {}} />);
    await user.click(await screen.findByTestId('task-worktree-remove'));
    expect(writes(calls)).toHaveLength(0);
    expect(await screen.findByText(/The branch task\/core-12-settings-page stays/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove worktree' }));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: 'DELETE',
          url: expect.stringContaining(`/tasks/${TASK}/worktree`),
          profile: 'design',
        }),
      ]),
    );
  });

  it('cannot be removed from under a running task', async () => {
    harness(
      <TaskDialog task={task({ status: 'running' })} onClose={() => {}} />,
      undefined,
      task({ status: 'running' }),
    );
    expect(await screen.findByTestId('task-worktree-remove')).toBeDisabled();
  });

  it("shows git's own words when git refused", async () => {
    const refused = task({
      worktree: worktree({
        status: 'error',
        error: 'fatal: invalid reference: no-such-branch',
      }),
    });
    harness(<TaskDialog task={refused} onClose={() => {}} />, undefined, refused);
    expect(await screen.findByTestId('task-worktree-status')).toHaveTextContent('Git refused');
    expect(screen.getByTestId('task-worktree-error')).toHaveTextContent(
      'fatal: invalid reference: no-such-branch',
    );
  });

  it('is not shown for a task without one', async () => {
    const plain = task({ worktree: null });
    harness(<TaskDialog task={plain} onClose={() => {}} />, undefined, plain);
    await screen.findByTestId('task-auto-start');
    expect(screen.queryByTestId('task-worktree')).toBeNull();
  });
});

describe('Start automatically', () => {
  it('is saved the moment it is switched, in the card’s own profile', async () => {
    const user = userEvent.setup();
    const calls = harness(<TaskDialog task={task()} onClose={() => {}} />);
    const toggle = await screen.findByTestId('task-auto-start');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: 'PATCH',
          url: expect.stringContaining(`/tasks/${TASK}`),
          profile: 'design',
          body: { auto_start: true },
        }),
      ]),
    );
  });

  it('is not offered on a card on Hermes’s board, which Hermes starts', async () => {
    const hermes = task({ external: { source: 'hermes', id: 't_1' }, worktree: null });
    harness(<TaskDialog task={hermes} onClose={() => {}} />, undefined, hermes);
    await screen.findByTestId('task-dialog-title');
    expect(screen.queryByTestId('task-auto-start')).toBeNull();
  });
});

describe("a project's repository", () => {
  it('is set in the project settings', async () => {
    const user = userEvent.setup();
    const calls = harness(<ProjectDialog open projectId={null} onClose={() => {}} />);
    const field = await screen.findByTestId('project-repository');
    await user.type(field, 'core-hub');
    await user.click(screen.getByTestId('project-dialog-save'));
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          method: 'PATCH',
          url: expect.stringContaining(`/projects/${PROJECT}`),
          body: { working_dir: 'core-hub' },
        }),
      ]),
    );
  });

  it('says why the hub refused a path', async () => {
    const user = userEvent.setup();
    harness(<ProjectDialog open projectId={PROJECT} onClose={() => {}} />, (call) =>
      call.method === 'PATCH'
        ? {
            status: 400,
            body: {
              error: 'The request did not match the expected shape.',
              code: 'validation_failed',
              details: {
                field: 'working_dir',
                reason: 'not_a_git_repo',
                message: 'fatal: not a git repository',
              },
            },
          }
        : undefined,
    );
    await user.type(await screen.findByTestId('project-repository'), 'plain');
    await user.click(screen.getByTestId('project-dialog-save'));
    expect(
      await screen.findByText('That folder is not a git repository: fatal: not a git repository'),
    ).toBeVisible();
  });
});

describe('the reasons a start or a removal is refused', () => {
  const t = (key: string, p?: Record<string, string | number>) =>
    `${key}${p?.message !== undefined ? `|${String(p.message)}` : ''}`;
  const refusal = (details: Record<string, string>) =>
    new HubApiError(409, 'conflict', 'x', { error: 'x', code: 'conflict', details });

  it('keeps git’s words when git refused the worktree', () => {
    expect(
      describeTaskError(refusal({ reason: 'worktree_failed', message: 'fatal: nope' }), t),
    ).toBe('tasks.worktree.failed|fatal: nope');
    expect(describeTaskError(refusal({ reason: 'task_running' }), t)).toBe(
      'tasks.worktree.running',
    );
    expect(describeTaskError(refusal({ reason: 'no_repository' }), t)).toBe(
      'tasks.worktree.no_repository',
    );
  });
});
