// Device cards on Device connections (the owner, 2026-09-25): each linked device is a card
// that tells it apart from the others — its kind, name, model, system and app versions, when
// it was last active and paired, where its push stands — with rename, test and remove. The
// page is one page now: a phone paired here is listed from the hub, so it is still there after
// the person leaves and comes back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: unknown) => void;
const sockets = new Map<string, Map<string, Set<Listener>>>();

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  constructor(private readonly namespace: string) {}
  private listeners(event: string) {
    const byEvent = sockets.get(this.namespace) ?? new Map<string, Set<Listener>>();
    sockets.set(this.namespace, byEvent);
    const set = byEvent.get(event) ?? new Set<Listener>();
    byEvent.set(event, set);
    return set;
  }
  on(event: string, listener: Listener) {
    this.listeners(event).add(listener);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners(event).delete(listener);
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
  return {
    ...real,
    connectNamespace: (options: { namespace: string }) => new FakeSocket(options.namespace),
  };
});
// The page's frame (sidebar, top bar) is not what these tests are about.
vi.mock('../src/shell/AppShell.js', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { DeviceCard } = await import('../src/devices/DeviceCard.js');
const { DeviceConnectionsScreen } = await import('../src/screens/DeviceConnectionsScreen.js');
const { modelLine, osKey, pushView, relativeTime } = await import('../src/devices/format.js');

afterEach(() => {
  cleanup();
  sockets.clear();
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

const NOW = Date.parse('2026-09-25T12:00:00Z');
const PHONE_ID = '01J8QK3ZR2W7M5N4P6T8V9X0DV';

function iphone(over: Record<string, unknown> = {}) {
  return {
    id: PHONE_ID,
    user_id: 'u',
    device_key: 'iphone-key',
    name: "Abdulaziz's iPhone",
    platform: 'ios',
    kind: 'phone',
    brand: 'Apple',
    model: 'iPhone 16 Pro',
    os_version: '18.6',
    app_version: '0.1.0',
    connection: 'lan',
    online: true,
    last_seen_at: '2026-09-25T11:55:00Z',
    paired_at: '2026-09-21T11:16:00Z',
    app_token_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
    capabilities: [],
    push: { provider: 'apns', locale: 'ar', registered_at: '2026-09-25T08:00:00Z' },
    push_blocker: 'none',
    this_device: false,
    created_at: '2026-09-21T11:16:00Z',
    updated_at: '2026-09-25T11:55:00Z',
    ...over,
  };
}

/** An app older than the new fields, on a hub that has never heard from it. */
function olderPhone() {
  return iphone({
    id: '01J8QK3ZR2W7M5N4P6T8V9X0D2',
    name: 'Android',
    platform: 'android',
    brand: null,
    model: null,
    os_version: null,
    app_version: null,
    online: false,
    last_seen_at: null,
    push: null,
    push_blocker: null,
  });
}

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

const json = (value: unknown, status = 200) =>
  Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

function fakeHub(initial: Record<string, unknown>[], providers = ['webpush', 'apns']) {
  const state = { devices: initial, pairing: null as Record<string, unknown> | null };
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ path, method, body });
    if (path === '/devices' && method === 'GET')
      return json({ items: state.devices, next_cursor: null });
    if (path.endsWith('/push/test')) return json({ provider: 'apns', status: 'sent', error: null });
    if (path.startsWith('/devices/') && method === 'PATCH')
      return json({ ...state.devices[0], ...body });
    if (path.startsWith('/devices/') && method === 'DELETE') return json(null, 204);
    if (path === '/push/config') return json({ webpush_public_key: 'BK', providers });
    if (path === '/push/senders') return json({ items: [] });
    if (path === '/auth/pairings' && method === 'POST') {
      state.pairing = {
        id: 'P1',
        status: 'pending',
        code: 'ABCD-EFGH',
        connection: 'lan',
        qr_payload: JSON.stringify({
          type: 'corehub.pairing',
          hub_url: 'http://hub.test',
          pairing_id: 'P1',
          code: 'ABCD-EFGH',
        }),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        device_id: null,
        created_at: new Date().toISOString(),
      };
      return json(state.pairing, 201);
    }
    if (path === '/auth/pairings/P1') return json(state.pairing);
    return json({ error: 'not found', code: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, state };
}

function mount(fetchImpl: typeof fetch, node: ReactNode, language: 'en' | 'ar' = 'en') {
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
            <RealtimeProvider>{node}</RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const card = (device: Record<string, unknown>, extra: Record<string, unknown> = {}) => (
  <MemoryRouter>
    <ul>
      <DeviceCard
        device={device as never}
        readyProviders={['webpush', 'apns']}
        now={NOW}
        {...extra}
      />
    </ul>
  </MemoryRouter>
);

describe('what a device card says', () => {
  it('says how long ago, in Arabic too', () => {
    expect(relativeTime('2026-09-25T11:55:00Z', NOW, 'en')).toBe('5 minutes ago');
    // The digits are whatever the page's other Arabic numbers use (Intl's `ar`).
    expect(relativeTime('2026-09-25T11:55:00Z', NOW, 'ar')).toMatch(/^قبل [٥5] دقائق$/);
    expect(relativeTime('2026-09-25T11:59:40Z', NOW, 'en')).toBe('now');
    expect(relativeTime('2026-09-25T12:00:30Z', NOW, 'en')).toBe('now');
    expect(relativeTime('2026-09-24T12:00:00Z', NOW, 'en')).toBe('yesterday');
    expect(relativeTime('2026-09-22T09:00:00Z', NOW, 'ar')).toMatch(/^قبل [٣3] أيام$/);
  });

  it('works out push from the registration, then the device, then the hub', () => {
    const base = { platform: 'ios' as const, push: null, push_blocker: null };
    const on = { provider: 'apns' as const, locale: 'ar' as const, registered_at: 'x' };
    expect(pushView({ ...base, push: on, push_blocker: 'permission_denied' }, [])).toEqual({
      state: 'on',
      provider: 'apns',
    });
    expect(pushView({ ...base, push_blocker: 'not_in_build' }, ['apns']).state).toBe(
      'not_in_build',
    );
    expect(pushView({ ...base, push_blocker: 'permission_pending' }, null).state).toBe(
      'permission_pending',
    );
    expect(pushView({ ...base, push_blocker: 'none' }, ['webpush'])).toEqual({
      state: 'no_sender',
      provider: 'apns',
    });
    expect(pushView({ ...base, platform: 'web' }, ['webpush']).state).toBe('off');
    expect(pushView(base, null).state).toBe('off');
  });

  it('names the model once and the system by the device', () => {
    expect(modelLine({ brand: 'Apple', model: 'iPhone 16 Pro' })).toBe('iPhone 16 Pro');
    expect(modelLine({ brand: 'Google', model: 'Pixel 9' })).toBe('Google Pixel 9');
    expect(modelLine({ brand: 'samsung', model: 'Samsung Galaxy S24' })).toBe('Samsung Galaxy S24');
    expect(modelLine({ brand: null, model: null })).toBeNull();
    expect(osKey({ platform: 'ios', kind: 'tablet' })).toBe('devices.os.ipados');
    expect(osKey({ platform: 'web', kind: 'browser' })).toBeNull();
  });
});

describe('a device card', () => {
  it('shows every field a device reports', async () => {
    const { fetchImpl } = fakeHub([]);
    mount(fetchImpl, card(iphone({ this_device: true }), { justPaired: true }));
    const row = await screen.findByTestId('device-row');
    expect(within(row).getByTestId('device-icon').getAttribute('data-icon')).toBe('phone-ios');
    expect(within(row).getByRole('img', { name: 'Phone' })).toBeTruthy();
    expect(within(row).getByTestId('device-name').textContent).toBe("Abdulaziz's iPhone");
    expect(within(row).getByTestId('device-model').textContent).toBe('iPhone 16 Pro');
    expect(within(row).getByTestId('device-versions').textContent).toBe(
      'iOS 18.6 · Core Hub 0.1.0',
    );
    expect(within(row).getByTestId('device-seen').textContent).toContain(
      'Last active 5 minutes ago',
    );
    expect(within(row).getByTestId('device-paired').textContent).toBe('Paired Sep 21, 2026');
    expect(within(row).getByTestId('device-push').textContent).toBe('Push on · APNs (iPhone)');
    expect(within(row).getByTestId('device-this').textContent).toBe('This device');
    expect(within(row).getByTestId('device-just-paired')).toBeTruthy();
    expect(within(row).getByText('Online')).toBeTruthy();

    // The exact time is one focus away, in our tooltip.
    const time = within(row).getByTestId('device-seen-time');
    expect(time.getAttribute('datetime')).toBe('2026-09-25T11:55:00Z');
    act(() => time.focus());
    expect((await screen.findByRole('tooltip')).textContent).toMatch(/September 25, 2026/);
  });

  it('shows what it has for an app that reports less, in Arabic', async () => {
    const { fetchImpl } = fakeHub([]);
    mount(fetchImpl, card(olderPhone()), 'ar');
    const row = await screen.findByTestId('device-row');
    expect(within(row).getByTestId('device-name').textContent).toBe('Android');
    expect(within(row).queryByTestId('device-model')).toBeNull();
    expect(within(row).getByTestId('device-versions').textContent).toBe('أندرويد');
    expect(within(row).getByTestId('device-seen').textContent).toContain('لا نشاط بعد');
    expect(within(row).getByTestId('device-push').textContent).toBe(
      'الإشعارات متوقفة: لا مرسِل FCM (أندرويد) في هذا المركز بعد',
    );
    expect(within(row).queryByTestId('device-test')).toBeNull();
    expect(within(row).queryByTestId('device-this')).toBeNull();
  });

  it('says why push is off when the device knows', async () => {
    const { fetchImpl } = fakeHub([]);
    mount(fetchImpl, card(iphone({ push: null, push_blocker: 'permission_pending' })));
    expect((await screen.findByTestId('device-push')).textContent).toBe(
      'Waiting for notification permission',
    );
    cleanup();
    mount(fetchImpl, card(iphone({ push: null, push_blocker: 'not_in_build' })));
    expect((await screen.findByTestId('device-push')).textContent).toBe(
      "Push isn't available in this build of the app",
    );
  });

  it('renames, tests and removes after asking; an admin is led to push setup', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = fakeHub([iphone()]);
    const setUp = vi.fn();
    mount(fetchImpl, card(iphone()));
    const row = await screen.findByTestId('device-row');

    await user.click(within(row).getByTestId('device-rename'));
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'آيفون العمل');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH')?.body).toEqual({ name: 'آيفون العمل' }),
    );

    await user.click(within(row).getByTestId('device-test'));
    expect(await within(row).findByText(/^Sent\./)).toBeTruthy();
    expect(sent.some((s) => s.path === `/devices/${PHONE_ID}/push/test`)).toBe(true);

    await user.click(within(row).getByTestId('device-revoke'));
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain("Remove Abdulaziz's iPhone?");
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'DELETE')?.path).toBe(`/devices/${PHONE_ID}`),
    );

    cleanup();
    mount(
      fetchImpl,
      card(iphone({ push: null }), {
        readyProviders: ['webpush'],
        isAdmin: true,
        onSetUpPush: setUp,
      }),
    );
    await user.click(await screen.findByTestId('device-set-up-push'));
    expect(setUp).toHaveBeenCalledOnce();
  });
});

describe('the Device connections page', () => {
  function page(fetchImpl: typeof fetch) {
    return mount(
      fetchImpl,
      <MemoryRouter initialEntries={['/settings/devices']}>
        <Routes>
          <Route
            path="/settings/devices"
            element={
              <>
                <Link to="/chat">away</Link>
                <DeviceConnectionsScreen />
              </>
            }
          />
          <Route path="/chat" element={<Link to="/settings/devices">back</Link>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('lists a phone paired here, and still lists it after leaving and coming back', async () => {
    const user = userEvent.setup();
    const hub = fakeHub([]);
    page(hub.fetchImpl);
    expect(await screen.findByText('No devices yet')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();

    await user.click(screen.getByTestId('start-pairing'));
    expect(await screen.findByTestId('pairing-code')).toBeTruthy();

    // The phone claims the code; the hub says so on /rt/devices.
    const claimed = { ...hub.state.pairing, status: 'claimed', device_id: PHONE_ID };
    hub.state.pairing = claimed;
    hub.state.devices = [iphone()];
    act(() => {
      for (const listener of sockets.get('/rt/devices')?.get('pairing.claimed') ?? [])
        listener({
          event: 'pairing.claimed',
          namespace: '/rt/devices',
          profile: null,
          ts: new Date().toISOString(),
          seq: 1,
          payload: { pairing: claimed, device: iphone() },
        });
    });
    const row = await screen.findByTestId('device-row');
    expect(within(row).getByTestId('device-just-paired')).toBeTruthy();
    expect(screen.queryByTestId('pairing')).toBeNull();
    expect(screen.queryByText(/^Paired:/)).toBeNull();
    expect(
      within(screen.getByTestId('device-group-mobile')).getByText('Phones and tablets'),
    ).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'away' }));
    expect(screen.queryByTestId('device-row')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'back' }));
    const again = await screen.findByTestId('device-row');
    expect(within(again).getByTestId('device-name').textContent).toBe("Abdulaziz's iPhone");
    expect(within(again).queryByTestId('device-just-paired')).toBeNull();
  });

  it('groups phones, computers and browsers', async () => {
    const hub = fakeHub([
      iphone(),
      iphone({ id: 'C1', name: 'MacBook', platform: 'macos', kind: 'computer', model: null }),
      iphone({ id: 'B1', name: 'Firefox — Linux', platform: 'web', kind: 'browser', push: null }),
    ]);
    page(hub.fetchImpl);
    await screen.findAllByTestId('device-row');
    const groups = screen.getAllByTestId(/^device-group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual([
      'device-group-mobile',
      'device-group-computer',
      'device-group-browser',
    ]);
    const browser = within(screen.getByTestId('device-group-browser')).getByTestId('device-row');
    expect(within(browser).getByTestId('device-paired').textContent).toMatch(/^Added /);
  });
});
