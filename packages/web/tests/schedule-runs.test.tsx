/**
 * The Schedules page runs what it shows (2026-09-24): "Run now" works for the hub's own
 * schedules too, a schedule's history opens the conversation or the workflow run each line
 * started, and a workflow run waiting for a person is answered where it is shown — approve,
 * or deny with a reason. The inbox opens that run here.
 *
 * Asserted: what a person sees, and what each click asks of the hub (and in which profile).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SchedulesScreen } from '../src/schedules/SchedulesScreen.js';
import { NotificationsTab } from '../src/notify/NotificationsTab.js';

afterEach(cleanup);

const SCHEDULE = '01J8QK3ZR2W7M5N4P6T8V9X0S1';
const FLOW_SCHEDULE = '01J8QK3ZR2W7M5N4P6T8V9X0S2';
const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0SS';
const LINE = '01J8QK3ZR2W7M5N4P6T8V9X0L1';
const FLOW_LINE = '01J8QK3ZR2W7M5N4P6T8V9X0L2';
const FLOW_RUN = '01J8QK3ZR2W7M5N4P6T8V9X0WR';
const APPROVAL = '01J8QK3ZR2W7M5N4P6T8V9X0AP';

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

function schedule(id: string, name: string, profile = 'default') {
  return {
    id,
    profile,
    name,
    enabled: true,
    state: 'scheduled',
    next_run_at: '2026-09-25T06:00:00Z',
    trigger: {
      kind: 'cron',
      expression: '0 9 * * *',
      every_minutes: null,
      run_at: null,
      timezone: 'Asia/Riyadh',
    },
    delivery: { kind: 'none', channel: null, address: null },
    last_error: null,
    external: null,
  };
}

interface Seen {
  method: string;
  path: string;
  profile: string | null;
  body: unknown;
}

function fakeHub(options: { runStatus?: string } = {}) {
  const seen: Seen[] = [];
  let answered = false;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
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
    if (path === '/profiles') {
      return json({
        items: [
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
          { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'designer', name: 'Designer' },
        ],
      });
    }
    if (path === '/agents') return json({ items: [] });
    if (path === '/schedules' && method === 'GET') {
      return json({
        items: [
          schedule(SCHEDULE, 'Morning brief', 'designer'),
          schedule(FLOW_SCHEDULE, 'Release flow'),
        ],
        next_cursor: null,
      });
    }
    if (path === `/schedules/${SCHEDULE}/run`) {
      return json(
        {
          job_id: '01J8QK3ZR2W7M5N4P6T8V9X0JB',
          schedule_run_id: LINE,
          session_id: SESSION,
          run_id: '01J8QK3ZR2W7M5N4P6T8V9X0RN',
          workflow_run_id: null,
        },
        202,
      );
    }
    if (path === `/schedules/${SCHEDULE}/runs`) {
      return json({
        items: [
          {
            id: LINE,
            status: 'succeeded',
            trigger: 'manual',
            session_id: SESSION,
            workflow_run_id: null,
            output_preview: 'Three things got done.',
            error: null,
            started_at: '2026-09-24T06:00:00Z',
            finished_at: '2026-09-24T06:00:05Z',
          },
        ],
        next_cursor: null,
      });
    }
    if (path === `/schedules/${FLOW_SCHEDULE}/runs`) {
      return json({
        items: [
          {
            id: FLOW_LINE,
            status: 'running',
            trigger: 'schedule',
            session_id: null,
            workflow_run_id: FLOW_RUN,
            output_preview: null,
            error: null,
            started_at: '2026-09-24T06:00:00Z',
            finished_at: null,
          },
        ],
        next_cursor: null,
      });
    }
    if (path === `/workflow-runs/${FLOW_RUN}`) {
      const waiting = !answered && (options.runStatus ?? 'waiting') === 'waiting';
      return json({
        id: FLOW_RUN,
        status: waiting ? 'waiting' : 'succeeded',
        steps: [
          { node_id: 'build', attempt: 1, status: 'succeeded', approval_id: null, error: null },
          {
            node_id: 'publish',
            attempt: 1,
            status: waiting ? 'waiting_approval' : 'succeeded',
            approval_id: APPROVAL,
            error: null,
          },
        ],
        error: null,
      });
    }
    if (path === `/approvals/${APPROVAL}`) {
      return json({
        id: APPROVAL,
        status: 'pending',
        title: 'publish',
        description: 'Publish v2.4?',
      });
    }
    if (path === `/approvals/${APPROVAL}/respond`) {
      answered = true;
      return json({ id: APPROVAL, status: body.decision === 'deny' ? 'denied' : 'approved' });
    }
    return json({ items: [] });
  };
  return { seen, fetchImpl };
}

/** Where the app went, for a click that navigates. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function mount(children: ReactNode, fetchImpl: typeof fetch, at = '/schedules') {
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
              <MemoryRouter initialEntries={[at]}>
                <Routes>
                  <Route
                    path="*"
                    element={
                      <>
                        {children}
                        <Where />
                      </>
                    }
                  />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const cardNamed = async (name: string) =>
  (await screen.findAllByTestId('schedule-card')).find((card) => card.textContent?.includes(name))!;

describe('Schedules: run now, and what it started', () => {
  it("runs a hub schedule in its own profile and offers the run's conversation", async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(<SchedulesScreen />, fetchImpl);
    const card = await cardNamed('Morning brief');
    const button = within(card).getByTestId('schedule-run');
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() =>
      expect(seen.some((c) => c.path === `/schedules/${SCHEDULE}/run`)).toBe(true),
    );
    expect(seen.find((c) => c.path === `/schedules/${SCHEDULE}/run`)!.profile).toBe('designer');
    expect(await screen.findByTestId('schedule-fired')).toHaveTextContent(
      '“Morning brief” started.',
    );
    // In the schedule's own profile, from the address: the top selector does not move.
    await waitFor(() =>
      expect(screen.getByTestId('schedule-fired-session')).toHaveAttribute(
        'href',
        `/chat/${SESSION}?profile=designer`,
      ),
    );

    // The history opened with the run in it, and the line opens the same conversation.
    const line = await within(card).findByTestId('schedule-run-line');
    expect(line).toHaveAttribute('data-status', 'succeeded');
    expect(line).toHaveTextContent('Three things got done.');
    expect(within(line).getByTestId('schedule-run-session')).toHaveAttribute(
      'href',
      `/chat/${SESSION}?profile=designer`,
    );
    expect(seen.find((c) => c.path === `/schedules/${SCHEDULE}/runs`)!.profile).toBe('designer');
  });
});

describe('Schedules: a workflow run waiting for a person', () => {
  it('opens from the history and approves', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(<SchedulesScreen />, fetchImpl);
    const card = await cardNamed('Release flow');
    await user.click(within(card).getByTestId('schedule-history-toggle'));
    await user.click(await within(card).findByTestId('schedule-run-workflow'));

    const dialog = await screen.findByTestId('workflow-run-dialog');
    expect(within(dialog).getByTestId('workflow-run-status')).toHaveTextContent('Waiting');
    expect(await within(dialog).findByTestId('workflow-approval-question')).toHaveTextContent(
      'Publish v2.4?',
    );
    expect(screen.getByTestId('where')).toHaveTextContent(
      `/schedules?workflow_run=${FLOW_RUN}&profile=default`,
    );
    await user.click(within(dialog).getByTestId('workflow-approve'));
    await waitFor(() =>
      expect(seen.some((c) => c.path === `/approvals/${APPROVAL}/respond`)).toBe(true),
    );
    const respond = seen.find((c) => c.path === `/approvals/${APPROVAL}/respond`)!;
    expect(respond.body).toEqual({ decision: 'approve_once', answer: null });
    expect(respond.profile).toBe('default');
    await waitFor(() =>
      expect(within(dialog).getByTestId('workflow-run-status')).toHaveTextContent('Done'),
    );
    expect(within(dialog).queryByTestId('workflow-approval')).toBeNull();
  });

  it('denies with the reason given', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(<SchedulesScreen />, fetchImpl, `/schedules?workflow_run=${FLOW_RUN}&profile=default`);
    const dialog = await screen.findByTestId('workflow-run-dialog');
    await user.type(
      await within(dialog).findByTestId('workflow-approval-reason'),
      'Tests are not green',
    );
    await user.click(within(dialog).getByTestId('workflow-deny'));
    await waitFor(() =>
      expect(seen.find((c) => c.path === `/approvals/${APPROVAL}/respond`)?.body).toEqual({
        decision: 'deny',
        answer: 'Tests are not green',
      }),
    );
  });
});

describe('the inbox opens a waiting workflow run', () => {
  it('goes to the run, in the profile it happened in', async () => {
    const user = userEvent.setup();
    const notice = {
      id: '01J8QK3ZR2W7M5N4P6T8V9X0NT',
      kind: 'approval_requested',
      title: 'Release flow is waiting for you',
      body: 'publish',
      profile: 'designer',
      resource: { kind: 'workflow_run', id: FLOW_RUN },
      read_at: null,
      created_at: '2026-09-24T06:00:00Z',
    };
    const fetchImpl: typeof fetch = (input) => {
      const path = new URL(String(input)).pathname;
      const body = path.endsWith('/notify/notices')
        ? { items: [notice], next_cursor: null, unread_count: 1 }
        : path.endsWith('/notify/preferences')
          ? {
              events: {},
              quiet_hours: { enabled: false, from: '22:00', to: '07:00', timezone: 'UTC' },
            }
          : { updated: 1 };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
      );
    };
    mount(<NotificationsTab />, fetchImpl, '/settings/notifications');
    await user.click(await screen.findByText('Release flow is waiting for you'));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        `/schedules?workflow_run=${FLOW_RUN}&profile=designer`,
      ),
    );
  });
});
