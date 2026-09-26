/**
 * A schedule's two run options on the Schedules page (owner, 2026-09-24): «تشغيل الموعد
 * الفائت خلال ٢٤ ساعة», off by default, and «إذا كان التشغيل السابق لا يزال جاريًا»,
 * «انتظار انتهاء السابق» by default — set when a schedule is made, changed from its card, and not offered
 * for Hermes, whose scheduler decides both. A time waiting for the previous run says so in
 * the history.
 *
 * Asserted: what a person sees, and what each click asks of the hub.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SchedulesScreen } from '../src/schedules/SchedulesScreen.js';

afterEach(cleanup);

const HUB_SCHEDULE = '01J8QK3ZR2W7M5N4P6T8V9X0S1';
const HERMES_SCHEDULE = '01J8QK3ZR2W7M5N4P6T8V9X0S2';
const DIRECT = { id: '01J8QK3ZR2W7M5N4P6T8V9X0A1', slug: 'direct', name: 'Direct' };
const HERMES = { id: '01J8QK3ZR2W7M5N4P6T8V9X0A2', slug: 'hermes', name: 'Hermes' };

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

function schedule(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    profile: 'default',
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
    run_if_missed: false,
    overlap: 'wait',
    ...over,
  };
}

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function fakeHub(agents: Array<typeof DIRECT>) {
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
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    seen.push({ method, path, body });
    if (path === '/profiles') {
      return json({ items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'D' }] });
    }
    if (path === '/agents') return json({ items: agents });
    if (path === '/schedules' && method === 'GET') {
      return json({
        items: [
          schedule(HUB_SCHEDULE, 'Morning brief'),
          schedule(HERMES_SCHEDULE, 'Hermes inbox', {
            external: { source: 'hermes', id: 'job-1' },
            run_if_missed: null,
            overlap: null,
          }),
        ],
        next_cursor: null,
      });
    }
    if (path === '/schedules' && method === 'POST') {
      return json(schedule('01J8QK3ZR2W7M5N4P6T8V9X0S3', String(body?.name)), 201);
    }
    if (path.startsWith('/schedules/') && method === 'PATCH') {
      return json(schedule(HUB_SCHEDULE, 'Morning brief', body ?? {}));
    }
    if (path === `/schedules/${HUB_SCHEDULE}/runs`) {
      return json({
        items: [
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0L2',
            status: 'queued',
            waiting: true,
            trigger: 'schedule',
            session_id: null,
            workflow_run_id: null,
            output_preview: null,
            error: null,
            started_at: null,
            finished_at: null,
          },
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0L1',
            status: 'running',
            waiting: false,
            trigger: 'schedule',
            session_id: null,
            workflow_run_id: null,
            output_preview: null,
            error: null,
            started_at: '2026-09-24T06:00:00Z',
            finished_at: null,
          },
        ],
        next_cursor: null,
      });
    }
    return json({ items: [] });
  };
  return { seen, fetchImpl };
}

function mount(fetchImpl: typeof fetch) {
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
              <MemoryRouter initialEntries={['/schedules']}>
                <SchedulesScreen />
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

const missedBox = (within_: HTMLElement) =>
  within(within_).getByRole('checkbox', { name: /^Run if missed \(within 24 hours\)/ });
const choice = (within_: HTMLElement, label: RegExp) =>
  within(within_).getByRole('radio', { name: label });

describe('Schedules: the run options', () => {
  it('makes a new schedule with the defaults, or with what the person chose', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub([DIRECT]);
    mount(fetchImpl);
    const options = await screen.findByTestId('schedule-new-options');
    // The owner's defaults: do not run a missed time; wait for the previous run.
    expect(missedBox(options)).not.toBeChecked();
    expect(choice(options, /^Wait, then run/)).toBeChecked();
    expect(options).toHaveTextContent('Up to two minutes late still counts as on time.');
    expect(options).toHaveTextContent('"Run now" always starts at once and stops nothing.');

    await user.type(screen.getByTestId('schedule-name'), 'Report');
    await user.click(missedBox(options));
    await user.click(choice(options, /^Stop the previous/));
    expect(choice(options, /^Stop the previous/)).toBeChecked();
    await user.click(screen.getByTestId('schedule-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.method === 'POST' && c.path === '/schedules')).toBe(true),
    );
    const sent = seen.find((c) => c.method === 'POST' && c.path === '/schedules')!.body!;
    expect(sent).toMatchObject({ name: 'Report', run_if_missed: true, overlap: 'replace' });
    // Back to the defaults for the next one.
    await waitFor(() => expect(missedBox(options)).not.toBeChecked());
    expect(choice(options, /^Wait, then run/)).toBeChecked();
  });

  it('does not offer them for Hermes, and sends none', async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub([HERMES, DIRECT]);
    mount(fetchImpl);
    await cardNamed('Hermes inbox');
    expect(screen.queryByTestId('schedule-new-options')).toBeNull();
    await user.type(screen.getByTestId('schedule-name'), 'Inbox');
    await user.click(screen.getByTestId('schedule-save'));
    await waitFor(() =>
      expect(seen.some((c) => c.method === 'POST' && c.path === '/schedules')).toBe(true),
    );
    const sent = seen.find((c) => c.method === 'POST' && c.path === '/schedules')!.body!;
    expect(sent).not.toHaveProperty('run_if_missed');
    expect(sent).not.toHaveProperty('overlap');
    // Hermes's card has no options to open; the hub's has.
    const hermesCard = await cardNamed('Hermes inbox');
    expect(within(hermesCard).queryByTestId('schedule-options-toggle')).toBeNull();
    expect(
      within(await cardNamed('Morning brief')).getByTestId('schedule-options-toggle'),
    ).toBeInTheDocument();
  });

  it("changes a schedule's options from its card, each change saved at once", async () => {
    const user = userEvent.setup();
    const { seen, fetchImpl } = fakeHub([DIRECT]);
    mount(fetchImpl);
    const card = await cardNamed('Morning brief');
    await user.click(within(card).getByTestId('schedule-options-toggle'));
    const panel = within(card).getByTestId('schedule-options');
    expect(missedBox(panel)).not.toBeChecked();
    expect(choice(panel, /^Wait, then run/)).toBeChecked();

    await user.click(choice(panel, /^Run alongside/));
    await waitFor(() =>
      expect(
        seen.find((c) => c.method === 'PATCH' && c.path === `/schedules/${HUB_SCHEDULE}`)?.body,
      ).toEqual({ overlap: 'parallel' }),
    );
    await user.click(missedBox(panel));
    await waitFor(() =>
      expect(seen.filter((c) => c.method === 'PATCH').map((c) => c.body)).toContainEqual({
        run_if_missed: true,
      }),
    );
  });

  it('shows a time waiting for the previous run as waiting', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub([DIRECT]);
    mount(fetchImpl);
    const card = await cardNamed('Morning brief');
    await user.click(within(card).getByTestId('schedule-history-toggle'));
    const lines = await within(card).findAllByTestId('schedule-run-line');
    expect(lines[0]).toHaveAttribute('data-waiting', 'true');
    expect(lines[0]).toHaveTextContent('Waiting for the previous run to end');
    expect(lines[1]).not.toHaveAttribute('data-waiting');
  });
});
