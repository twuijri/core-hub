/**
 * Two helps on the Schedules page (DECISIONS §53):
 *
 * - writing a schedule's time: a "Common schedules" menu fills in the cron or the interval,
 *   and the form shows the next three times **the hub** says it would run
 *   (`schedules.previewTrigger`), in the schedule's timezone — or why the hub cannot read it;
 * - a workflow run's limits: the run's view shows the limits it ran under, what it cost and
 *   which limit stopped it, and opens the workflow's limits to change them.
 *
 * Asserted: what a person sees, and what each action asks of the hub.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SchedulesScreen } from '../src/schedules/SchedulesScreen.js';
import { moneyOf, secondsOf } from '../src/schedules/WorkflowLimits.js';
import { openControl } from './helpers/ui.js';

afterEach(cleanup);

const FLOW = '01J8QK3ZR2W7M5N4P6T8V9X0WF';
const FLOW_RUN = '01J8QK3ZR2W7M5N4P6T8V9X0WR';

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

interface Seen {
  method: string;
  path: string;
  profile: string | null;
  body: Record<string, unknown> | null;
}

function fakeHub() {
  const seen: Seen[] = [];
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
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    seen.push({ method, path, profile, body });
    if (path === '/profiles') {
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    }
    if (path === '/agents') return json({ items: [] });
    if (path === '/schedules' && method === 'GET') return json({ items: [], next_cursor: null });
    if (path === '/schedules/preview') {
      const trigger = body!.trigger as { kind: string; expression: string | null };
      if (trigger.kind === 'cron' && trigger.expression === 'every day') {
        return json(
          {
            error: 'conflict',
            code: 'conflict',
            details: {
              reason: 'cron_invalid',
              field: 'trigger.expression',
              message: 'a cron expression has five fields, not 2',
            },
          },
          409,
        );
      }
      return json({
        timezone: 'Asia/Riyadh',
        next_runs: ['2026-09-29T06:00:00Z', '2026-09-30T06:00:00Z', '2026-10-01T06:00:00Z'],
      });
    }
    if (path === `/workflow-runs/${FLOW_RUN}`) {
      return json({
        id: FLOW_RUN,
        workflow_id: FLOW,
        status: 'failed',
        steps: [
          {
            node_id: 'review',
            attempt: 1,
            status: 'cancelled',
            approval_id: null,
            error: 'stopped: the run went over its cost limit of $2.00 (it cost about $2.10)',
          },
        ],
        error: 'stopped: the run went over its cost limit of $2.00 (it cost about $2.10)',
        limits: {
          max_duration_seconds: 1800,
          max_cost: { amount: '2.00', currency: 'USD' },
          step_timeout_seconds: null,
        },
        cost: { amount: '2.100000', currency: 'USD' },
        stopped_by: 'max_cost',
      });
    }
    if (path === `/workflows/${FLOW}` && method === 'GET') {
      return json({
        id: FLOW,
        name: 'Release',
        limits: {
          max_duration_seconds: 1800,
          max_cost: { amount: '2.000000', currency: 'USD' },
          step_timeout_seconds: null,
        },
      });
    }
    if (path === `/workflows/${FLOW}` && method === 'PATCH') {
      return json({ id: FLOW, name: 'Release', limits: body!.limits });
    }
    return json({ items: [] });
  };
  return { seen, fetchImpl };
}

function mount(fetchImpl: typeof fetch, at = '/schedules') {
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
                  <Route path="*" element={<SchedulesScreen />} />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const lastPreview = (seen: Seen[]) =>
  [...seen].reverse().find((call) => call.path === '/schedules/preview');

describe('Schedules: common schedules and the next runs', () => {
  it('a template fills in the cron, and the next three times are the hub’s, in the schedule’s zone', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl);

    await openControl(user, await screen.findByTestId('schedule-templates'));
    const menu = await screen.findByTestId('schedule-templates-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Every hour',
      'Every day at 8:00',
      'Weekdays at 9:00',
      'Every Monday at 9:00',
      'First of the month at 9:00',
      'Every 15 minutes',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Weekdays at 9:00' }));
    expect(screen.getByTestId('schedule-value')).toHaveValue('0 9 * * 1-5');

    // The hub is asked, in the profile the schedule is made in, for three times.
    await waitFor(() =>
      expect(lastPreview(seen)?.body).toMatchObject({
        trigger: { kind: 'cron', expression: '0 9 * * 1-5' },
        count: 3,
      }),
    );
    expect(lastPreview(seen)!.profile).toBe('default');
    const runs = await screen.findAllByTestId('schedule-next-run');
    expect(runs.map((run) => run.getAttribute('data-at'))).toEqual([
      '2026-09-29T06:00:00Z',
      '2026-09-30T06:00:00Z',
      '2026-10-01T06:00:00Z',
    ]);
    // Shown in the schedule's zone (Riyadh, UTC+3): 06:00 UTC is 09:00 there.
    expect(runs[0]).toHaveTextContent(/Tuesday/);
    expect(runs[0]).toHaveTextContent(/09:00/);
    expect(screen.getByTestId('schedule-next-runs')).toHaveTextContent('Next runs (Asia/Riyadh)');
  });

  it('"Every 15 minutes" is an interval', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl);
    await openControl(user, await screen.findByTestId('schedule-templates'));
    await user.click(await screen.findByRole('menuitem', { name: 'Every 15 minutes' }));
    expect(screen.getByTestId('schedule-value')).toHaveValue('15');
    await waitFor(() =>
      expect(lastPreview(seen)?.body).toMatchObject({
        trigger: { kind: 'interval', every_minutes: 15, expression: null },
      }),
    );
  });

  it('says why the hub cannot read a time, before it is saved', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub();
    mount(fetchImpl);
    const field = await screen.findByTestId('schedule-value');
    await user.clear(field);
    await user.type(field, 'every day');
    expect(await screen.findByTestId('schedule-next-runs-error')).toHaveTextContent(
      'The hub cannot read this: a cron expression has five fields, not 2',
    );
    expect(screen.queryAllByTestId('schedule-next-run')).toHaveLength(0);
  });
});

describe('Workflow runs: limits', () => {
  it('shows the limits the run worked under, what it cost, and which one stopped it', async () => {
    const { fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?workflow_run=${FLOW_RUN}&profile=default`);
    const limits = await screen.findByTestId('workflow-run-limits');
    expect(within(limits).getByTestId('workflow-run-stopped')).toHaveTextContent(
      'Stopped: the run went over its cost limit.',
    );
    expect(within(limits).getByTestId('workflow-run-limit-time')).toHaveTextContent('30 min');
    expect(within(limits).getByTestId('workflow-run-limit-cost')).toHaveTextContent('$2.00');
    expect(within(limits).getByTestId('workflow-run-limit-step')).toHaveTextContent('No limit');
    expect(within(limits).getByTestId('workflow-run-cost')).toHaveTextContent('$2.10');
  });

  it("changes the workflow's limits for its next runs", async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub();
    mount(fetchImpl, `/schedules?workflow_run=${FLOW_RUN}&profile=default`);
    await user.click(await screen.findByTestId('workflow-limits-toggle'));
    const time = await screen.findByTestId('workflow-limit-time');
    await waitFor(() => expect(time).toHaveValue('30'));
    expect(screen.getByTestId('workflow-limit-cost')).toHaveValue('2');

    // Something unreadable is not sent.
    await user.clear(screen.getByTestId('workflow-limit-cost'));
    await user.type(screen.getByTestId('workflow-limit-cost'), 'lots');
    expect(screen.getByTestId('workflow-limits-save')).toBeDisabled();
    expect(screen.getByText('An amount in US dollars above zero, like 2.50.')).toBeInTheDocument();

    await user.clear(screen.getByTestId('workflow-limit-cost'));
    await user.type(screen.getByTestId('workflow-limit-cost'), '3.5');
    await user.clear(time);
    await user.type(time, '45');
    await user.type(screen.getByTestId('workflow-limit-step'), '0.5');
    await user.click(screen.getByTestId('workflow-limits-save'));
    await waitFor(() =>
      expect(seen.find((call) => call.method === 'PATCH')?.body).toEqual({
        limits: {
          max_duration_seconds: 2700,
          max_cost: { amount: '3.5', currency: 'USD' },
          step_timeout_seconds: 30,
        },
      }),
    );
    expect(seen.find((call) => call.method === 'PATCH')!.path).toBe(`/workflows/${FLOW}`);
    expect(await screen.findByTestId('workflow-limits-saved')).toBeInTheDocument();
  });

  it('reads minutes and dollars the way a person types them', () => {
    expect(secondsOf('')).toBeNull();
    expect(secondsOf('1.5')).toBe(90);
    expect(secondsOf('0')).toBeNaN();
    expect(secondsOf('soon')).toBeNaN();
    expect(moneyOf('')).toBeNull();
    expect(moneyOf('0.25')).toEqual({ amount: '0.25', currency: 'USD' });
    expect(moneyOf('0')).toBeUndefined();
    expect(moneyOf('-1')).toBeUndefined();
  });
});
