// The Notifications page: what reached you, and what should. The inbox is the hub's
// record, so an empty one stays empty, and every switch writes a whole preferences
// object rather than the one field that changed.
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
import { NotificationsTab } from '../src/notify/NotificationsTab.js';
import { NOTICE_KINDS } from '../src/notify/queries.js';

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

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function hub(notices: Record<string, unknown>[], preferences?: Record<string, unknown>) {
  const sent: Sent[] = [];
  const prefs = preferences ?? {
    events: {},
    quiet_hours: { enabled: false, from: '22:00', to: '07:00', timezone: 'Asia/Riyadh' },
  };
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ url: String(url), method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/notify/notices') && method === 'GET')
      return json({
        items: notices,
        next_cursor: null,
        unread_count: notices.filter((n) => n.read_at === null).length,
      });
    if (path.endsWith('/notify/notices') && method === 'PATCH') return json({ updated: 1 });
    if (path.includes('/notify/notices/')) return json(notices[0]);
    if (path.endsWith('/notify/preferences')) return json(body ?? prefs);
    return json({ error: { code: 'not_found', message: path } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function notice(over: Record<string, unknown> = {}) {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0NT',
    user_id: 'u',
    profile: 'default',
    kind: 'run_completed',
    title: 'أنهى Hermes الرد',
    body: 'خطة الإطلاق',
    resource: { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0YA' },
    read_at: null,
    created_at: '2026-09-22T10:15:40Z',
    ...over,
  };
}

function mount(fetchImpl: typeof fetch, language: 'ar' | 'en' = 'en') {
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
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={['/settings/notifications']}>
                <NotificationsTab />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('the Notifications page', () => {
  it('says an empty inbox is empty, and does not invent a welcome notice', async () => {
    const { fetchImpl } = hub([]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByText('Nothing yet')).toBeTruthy());
    expect(screen.queryByTestId('notice-list')).toBeNull();
  });

  it('shows what happened, with its own words and the time it happened', async () => {
    const { fetchImpl } = hub([notice()]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('notice-list')).toBeTruthy());
    expect(screen.getByText('أنهى Hermes الرد')).toBeTruthy();
    expect(screen.getByText('خطة الإطلاق')).toBeTruthy();
  });

  it('cannot mark all read when nothing is unread', async () => {
    const { fetchImpl } = hub([notice({ read_at: '2026-09-22T11:00:00Z' })]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('notice-list')).toBeTruthy());
    expect(screen.getByTestId('mark-all-read').hasAttribute('disabled')).toBe(true);
  });

  it('marks one read by opening it, with the contract’s `read`, not a timestamp', async () => {
    const { fetchImpl, sent } = hub([notice()]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('notice-list')).toBeTruthy());
    await userEvent.click(screen.getByText('أنهى Hermes الرد'));
    await waitFor(() => {
      const patch = sent.find((s) => s.method === 'PATCH' && s.url.includes('/notices/'));
      expect(patch?.body).toEqual({ read: true });
    });
  });

  it('a kind nobody ever changed is on, because a missing key means on', async () => {
    const { fetchImpl } = hub([]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('notify-kind-run_completed')).toBeTruthy());
    expect(screen.getByTestId('notify-kind-run_completed').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  it('is a table: one row per event, and the two switches under «في الهب» and «على الأجهزة»', async () => {
    // Owner, 2026-09-26: two unlabelled-looking switches a row, and "Push to devices" said
    // seven times, read as noise. The columns say it once.
    const { fetchImpl } = hub([]);
    mount(fetchImpl);
    const table = await screen.findByTestId('notify-events');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual([
      expect.stringMatching(/Event|الحدث/),
      expect.stringMatching(/In the hub|في الهب/),
      expect.stringMatching(/On devices|على الأجهزة/),
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(NOTICE_KINDS.length);
    // Each row: the event's name once, its two switches in its own cells, named for a reader.
    const first = rows[0] as HTMLElement;
    const cells = within(first).getAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(within(cells[1] as HTMLElement).getByRole('switch')).toHaveAccessibleName(
      /(In the hub|في الهب)$/,
    );
    expect(within(cells[2] as HTMLElement).getByRole('switch')).toHaveAccessibleName(
      /(On devices|على الأجهزة)$/,
    );
    // The words "push to devices" no longer repeat on every row.
    expect(screen.queryAllByText(/Push to devices|إرسال إلى الأجهزة/)).toHaveLength(0);
    // Quiet hours come after the table.
    const quiet = screen.getByTestId('notify-quiet');
    expect(table.compareDocumentPosition(quiet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('turning a kind off sends the whole preferences object, quiet hours included', async () => {
    // The contract requires both fields; sending only what changed is a 400, and the
    // window the person set would be the thing that vanished.
    const { fetchImpl, sent } = hub([]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('notify-kind-run_completed')).toBeTruthy());
    await userEvent.click(screen.getByTestId('notify-kind-run_completed'));
    await waitFor(() => {
      const put = sent.find((s) => s.method === 'PUT');
      expect(put?.body).toMatchObject({
        events: { run_completed: { in_app: false, push: true } },
        quiet_hours: { enabled: false, from: '22:00', to: '07:00', timezone: 'Asia/Riyadh' },
      });
    });
  });

  it('shows the quiet window only when it is on, and keeps the zone it was given', async () => {
    const { fetchImpl } = hub([], {
      events: {},
      quiet_hours: { enabled: true, from: '23:30', to: '06:15', timezone: 'Asia/Riyadh' },
    });
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('quiet-window')).toBeTruthy());
    expect(screen.getByText('Asia/Riyadh')).toBeTruthy();
    expect(screen.getByDisplayValue('23:30')).toBeTruthy();
  });

  it('says plainly that quiet hours are about devices, not about the inbox', async () => {
    // A window that hid the inbox would lose what happened at night; the page has to say
    // which of the two it is, because both are plausible.
    const { fetchImpl } = hub([]);
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('notify-quiet')).toBeTruthy());
    expect(screen.getByText(/not the inbox/)).toBeTruthy();
  });
});
