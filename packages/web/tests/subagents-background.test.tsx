/**
 * Subagents and the Background panel (contract decision §47).
 *
 * - A conversation's subagents: running ones as a tree under the one that started them,
 *   finished ones folded into "Finished (n)", Stop and Steer only where the agent allows them.
 * - The Background button: how many things are working in every profile, each opening where
 *   it lives, and Stop asked in the item's own profile.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundItem, Subagent } from '../src/types.js';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  connect() {
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
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
const { PaneProvider } = await import('../src/shell/pane.js');
const { TopBar } = await import('../src/shell/TopBar.js');
const { SubagentsPanel } = await import('../src/chat/SubagentsPanel.js');
const { splitSubagents, upsertSubagent, clock, elapsedMs } =
  await import('../src/subagents/subagents.js');
const { backgroundHref, runningCount } = await import('../src/background/background.js');

afterEach(cleanup);

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

function subagent(over: Partial<Subagent> & { id: string }): Subagent {
  return {
    session_id: SESSION,
    run_id: null,
    parent_id: null,
    depth: 0,
    goal: `goal of ${over.id}`,
    model: 'm1',
    status: 'running',
    started_at: '2026-09-25T10:00:00Z',
    finished_at: null,
    tool_count: 0,
    last_tool: null,
    accepting_steer: true,
    summary: null,
    tools: [],
    ...over,
  };
}

function item(over: Partial<BackgroundItem> & { id: string }): BackgroundItem {
  return {
    kind: 'chat_run',
    job_kind: null,
    title: 'Launch plan',
    profile: 'default',
    status: 'running',
    started_at: '2026-09-25T10:00:00Z',
    finished_at: null,
    stoppable: true,
    session_id: SESSION,
    resource: null,
    ...over,
  };
}

describe('the pure rules', () => {
  it('draws running subagents as a tree, oldest first, and finished ones newest first', () => {
    const { running, finished } = splitSubagents([
      subagent({ id: 'child', parent_id: 'b', depth: 1, started_at: '2026-09-25T10:00:03Z' }),
      subagent({ id: 'b', started_at: '2026-09-25T10:00:02Z' }),
      subagent({ id: 'a', started_at: '2026-09-25T10:00:01Z' }),
      subagent({ id: 'orphan', parent_id: 'gone', depth: 2, started_at: '2026-09-25T10:00:04Z' }),
      subagent({ id: 'old', status: 'completed', finished_at: '2026-09-25T10:01:00Z' }),
      subagent({ id: 'new', status: 'interrupted', finished_at: '2026-09-25T10:02:00Z' }),
    ]);
    expect(running.map((row) => [row.subagent.id, row.indent])).toEqual([
      ['a', 0],
      ['b', 0],
      ['child', 1],
      ['orphan', 2],
    ]);
    expect(finished.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('replaces a subagent in place, adds a new one, and tells the time as a clock', () => {
    const list = [subagent({ id: 'a' }), subagent({ id: 'b' })];
    expect(
      upsertSubagent(list, subagent({ id: 'a', tool_count: 3 })).map((s) => s.tool_count),
    ).toEqual([3, 0]);
    expect(upsertSubagent(list, subagent({ id: 'c' }))).toHaveLength(3);
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_723_000)).toBe('1:02:03');
    const started = Date.parse('2026-09-25T10:00:00Z');
    expect(elapsedMs(subagent({ id: 'a' }), started + 5000)).toBe(5000);
    expect(
      elapsedMs(subagent({ id: 'a', finished_at: '2026-09-25T10:00:02Z' }), started + 99_000),
    ).toBe(2000);
  });

  it('opens each item where it lives', () => {
    const inLink = (profile: string) => profile;
    expect(backgroundHref(item({ id: 'run:1' }), inLink)).toBe(`/chat/${SESSION}?profile=default`);
    expect(backgroundHref(item({ id: 'run:1' }), () => null)).toBe(`/chat/${SESSION}`);
    expect(backgroundHref(item({ id: 'run:2', kind: 'task_run' }), inLink)).toBe('/tasks');
    expect(
      backgroundHref(
        item({
          id: 'workflow_run:3',
          kind: 'workflow_run',
          session_id: null,
          profile: 'work',
          resource: { kind: 'workflow_run', id: '01J8QK3ZR2W7M5N4P6T8V9X0WR' },
        }),
        inLink,
      ),
    ).toBe('/schedules?workflow_run=01J8QK3ZR2W7M5N4P6T8V9X0WR&profile=work');
    expect(
      backgroundHref(
        item({
          id: 'job:4',
          kind: 'job',
          job_kind: 'plugin_install',
          session_id: null,
          resource: { kind: 'agent', id: AGENT },
        }),
        inLink,
      ),
    ).toBe(`/agents/${AGENT}/plugins`);
    expect(
      backgroundHref(
        item({ id: 'job:5', kind: 'job', job_kind: 'export', session_id: null }),
        inLink,
      ),
    ).toBe('/settings/workspaces');
    expect(runningCount(undefined)).toBe(0);
  });
});

// ------------------------------------------------------------------ mounted

interface Seen {
  method: string;
  path: string;
  profile: string | null;
  body: unknown;
}

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

function hub(routes: Record<string, (method: string, profile: string | null) => unknown>) {
  const seen: Seen[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(String(url));
    const path = decodeURIComponent(pathname.slice(pathname.indexOf('/v1') + 3));
    const headers = new Headers(init.headers);
    const profile = headers.get('X-Hub-Profile');
    const method = (init.method ?? 'GET').toUpperCase();
    seen.push({
      method,
      path,
      profile,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    let body: unknown = { items: [], next_cursor: null };
    if (path === '/meta') body = { name: 'Core Hub', setup_required: false };
    const route = routes[path];
    if (route) body = route(method, profile);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function mount(fetchImpl: typeof fetch, children: React.ReactNode) {
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
              <MemoryRouter>
                <PaneProvider>{children}</PaneProvider>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('the Subagents panel of a conversation', () => {
  const list = (support: string) => ({
    support,
    items: [
      subagent({ id: 'sa-a', goal: 'Review the tests', tool_count: 2, last_tool: 'read_file' }),
      subagent({ id: 'sa-b', goal: 'Write the summary', started_at: '2026-09-25T10:00:01Z' }),
      subagent({
        id: 'sa-c',
        goal: 'Search',
        parent_id: 'sa-b',
        depth: 1,
        started_at: '2026-09-25T10:00:02Z',
        accepting_steer: false,
      }),
      subagent({
        id: 'sa-d',
        goal: 'Old one',
        status: 'completed',
        finished_at: '2026-09-25T10:00:30Z',
        summary: 'Done it',
      }),
    ],
  });

  it('lists the running ones as a tree with their facts, and stops and steers one', async () => {
    const { fetchImpl, seen } = hub({
      [`/sessions/${SESSION}/subagents`]: () => list('full'),
      [`/sessions/${SESSION}/subagents/sa-a/interrupt`]: () =>
        subagent({ id: 'sa-a', status: 'interrupted', finished_at: '2026-09-25T10:00:40Z' }),
      [`/sessions/${SESSION}/subagents/sa-b/steer`]: () => ({ status: 'queued' }),
    });
    const opened: string[] = [];
    mount(
      fetchImpl,
      <SubagentsPanel sessionId={SESSION} onOpenTrajectory={(id) => opened.push(id)} />,
    );
    const panel = await screen.findByTestId('subagents-panel');
    expect(panel.getAttribute('data-support')).toBe('full');
    expect(within(panel).getByTestId('subagents-running-count').textContent).toContain('3 running');
    const rows = within(panel).getAllByTestId('subagent-row');
    expect(rows.map((row) => row.getAttribute('data-subagent-id'))).toEqual([
      'sa-a',
      'sa-b',
      'sa-c',
    ]);
    expect(rows[2]!.style.getPropertyValue('--indent')).toBe('1');
    expect(rows[0]!.textContent).toContain('2 tools');
    expect(rows[0]!.textContent).toContain('last: read_file');
    // Steer only where the subagent still takes guidance.
    expect(within(rows[2]!).queryByTestId('subagent-steer')).toBeNull();

    fireEvent.click(within(rows[1]!).getByTestId('subagent-steer'));
    fireEvent.change(within(rows[1]!).getByTestId('subagent-steer-input'), {
      target: { value: 'Keep it short' },
    });
    fireEvent.click(within(rows[1]!).getByTestId('subagent-steer-send'));
    await waitFor(() =>
      expect(within(rows[1]!).getByTestId('subagent-steer-result').textContent).toBe(
        'Sent. It reads it before its next step.',
      ),
    );
    expect(seen.find((s) => s.path.endsWith('/steer'))?.body).toEqual({ text: 'Keep it short' });

    fireEvent.click(within(rows[0]!).getByTestId('subagent-stop'));
    await waitFor(() =>
      expect(seen.some((s) => s.method === 'POST' && s.path.endsWith('/sa-a/interrupt'))).toBe(
        true,
      ),
    );

    // Finished ones are folded, and each opens in full with a way into the trajectory.
    const toggle = within(panel).getByTestId('subagents-finished-toggle');
    expect(toggle.textContent).toContain('Finished (');
    fireEvent.click(toggle);
    const finished = await within(panel).findAllByTestId('subagent-finished-row');
    expect(finished.map((row) => row.getAttribute('data-subagent-id'))).toContain('sa-d');
    const old = finished.find((row) => row.getAttribute('data-subagent-id') === 'sa-d')!;
    fireEvent.click(within(old).getByTestId('subagent-view'));
    const sheet = await screen.findByTestId('subagent-sheet');
    expect(within(sheet).getByTestId('subagent-summary').textContent).toBe('Done it');
    fireEvent.click(within(sheet).getByTestId('subagent-open-trajectory'));
    expect(opened).toEqual(['subagent:sa-d']);
  });

  it('offers neither Stop nor Steer where the agent only lets them be watched', async () => {
    const { fetchImpl } = hub({ [`/sessions/${SESSION}/subagents`]: () => list('observe') });
    mount(fetchImpl, <SubagentsPanel sessionId={SESSION} onOpenTrajectory={() => undefined} />);
    const panel = await screen.findByTestId('subagents-panel');
    expect(within(panel).getByTestId('subagents-observe')).toBeTruthy();
    expect(within(panel).queryAllByTestId('subagent-stop')).toHaveLength(0);
    expect(within(panel).queryAllByTestId('subagent-steer')).toHaveLength(0);
  });

  it('says nothing at all for a conversation with no subagents', async () => {
    const { fetchImpl, seen } = hub({
      [`/sessions/${SESSION}/subagents`]: () => ({ support: 'none', items: [] }),
    });
    mount(fetchImpl, <SubagentsPanel sessionId={SESSION} onOpenTrajectory={() => undefined} />);
    await waitFor(() => expect(seen.some((s) => s.path.endsWith('/subagents'))).toBe(true));
    expect(screen.queryByTestId('subagents-panel')).toBeNull();
  });
});

describe('the Background button', () => {
  it('counts what is running everywhere, lists it, and stops one in its own profile', async () => {
    const { fetchImpl, seen } = hub({
      '/background': () => ({
        running: [
          item({ id: 'run:01J8QK3ZR2W7M5N4P6T8V9X0RN', title: 'Launch plan' }),
          item({
            id: `subagent:${SESSION}:sa-a`,
            kind: 'subagent',
            title: 'Review the tests',
            profile: 'work',
          }),
          item({
            id: 'job:01J8QK3ZR2W7M5N4P6T8V9X0JB',
            kind: 'job',
            job_kind: 'import',
            title: '',
            stoppable: false,
            session_id: null,
          }),
        ],
        finished: [
          item({
            id: 'workflow_run:01J8QK3ZR2W7M5N4P6T8V9X0WR',
            kind: 'workflow_run',
            title: 'Nightly report',
            status: 'succeeded',
            finished_at: '2026-09-25T09:00:00Z',
            stoppable: false,
            session_id: null,
            resource: { kind: 'workflow_run', id: '01J8QK3ZR2W7M5N4P6T8V9X0WR' },
          }),
        ],
      }),
      [`/background/subagent:${SESSION}:sa-a/stop`]: () =>
        item({ id: `subagent:${SESSION}:sa-a`, kind: 'subagent', status: 'cancelled' }),
    });
    mount(fetchImpl, <TopBar title="x" onMenu={() => undefined} />);
    const button = await screen.findByTestId('background-tasks');
    await waitFor(() => expect(button.getAttribute('data-count')).toBe('3'));
    expect(button.getAttribute('aria-label')).toBe('Running in the background: 3');
    expect(seen.find((s) => s.path === '/background')).toBeTruthy();

    fireEvent.click(button);
    const sheet = await screen.findByTestId('background-sheet');
    const rows = within(sheet).getAllByTestId('background-item');
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'chat_run',
      'subagent',
      'job',
    ]);
    // A job with no progress line is named by its kind; one that cannot stop offers no Stop.
    expect(within(rows[2]!).getByTestId('background-item-title').textContent).toBe('import');
    expect(within(rows[2]!).queryByTestId('background-item-stop')).toBeNull();
    expect(within(rows[0]!).getByTestId('background-item-open').getAttribute('href')).toBe(
      `/chat/${SESSION}`,
    );

    fireEvent.click(within(rows[1]!).getByTestId('background-item-stop'));
    await waitFor(() => {
      const stop = seen.find((s) => s.method === 'POST' && s.path.startsWith('/background/'));
      expect(stop?.path).toBe(`/background/subagent:${SESSION}:sa-a/stop`);
      expect(stop?.profile).toBe('work');
    });

    const toggle = within(sheet).getByTestId('background-finished-toggle');
    expect(toggle.textContent).toContain('(1)');
    fireEvent.click(toggle);
    const done = await within(sheet).findByTestId('background-finished');
    expect(within(done).getByTestId('background-item-title').textContent).toBe('Nightly report');
  });

  it('says so when nothing is running', async () => {
    const { fetchImpl } = hub({ '/background': () => ({ running: [], finished: [] }) });
    mount(fetchImpl, <TopBar title="x" onMenu={() => undefined} />);
    const button = await screen.findByTestId('background-tasks');
    expect(button.getAttribute('data-count')).toBe('0');
    expect(screen.queryByTestId('background-count')).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByTestId('background-none')).toBeTruthy();
  });
});
