// Devices and browser push in the web client: turning notifications on in this browser (the
// browser's objects played by fakes), the device list (rename, remove, last active, push), the
// admin's push senders, and the per-kind push switch on the Notifications page.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubClient } from '@corehub/contracts';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { NotificationsTab } from '../src/notify/NotificationsTab.js';
import { DevicesPanel } from '../src/devices/DevicesPanel.js';
import {
  BrowserPushError,
  base64UrlToBytes,
  browserName,
  browserPushState,
  deviceKey,
  enableBrowserPush,
  type PushEnvironment,
} from '../src/devices/browserPush.js';

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

function device(over: Record<string, unknown> = {}) {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0DV',
    user_id: 'u',
    device_key: 'phone-key',
    name: 'هاتف طارق',
    platform: 'android',
    kind: 'phone',
    brand: 'Google',
    model: 'Pixel 9',
    os_version: '15',
    app_version: '1.0.2',
    connection: 'lan',
    online: false,
    last_seen_at: '2026-09-25T09:00:00Z',
    paired_at: '2026-09-24T09:00:00Z',
    app_token_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
    capabilities: [],
    push: { provider: 'fcm', locale: 'ar', registered_at: '2026-09-25T08:00:00Z' },
    push_blocker: 'none',
    this_device: false,
    created_at: '2026-09-24T09:00:00Z',
    updated_at: '2026-09-25T09:00:00Z',
    ...over,
  };
}

const ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'core-hub-66772',
  client_email: 'push@core-hub-66772.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
});

const SENDERS = {
  items: [
    {
      provider: 'webpush',
      state: 'ready',
      source: 'generated',
      missing: [],
      details: { public_key: 'BK' },
      devices: 1,
      last_error: null,
      last_sent_at: null,
    },
    {
      provider: 'fcm',
      state: 'not_configured',
      source: 'none',
      missing: ['service_account'],
      details: {},
      devices: 0,
      last_error: null,
      last_sent_at: null,
    },
    {
      provider: 'apns',
      state: 'not_configured',
      source: 'none',
      missing: ['key_id', 'team_id', 'bundle_id', 'private_key'],
      details: {},
      devices: 0,
      last_error: null,
      last_sent_at: null,
    },
  ],
};

function hub(devices: Record<string, unknown>[]) {
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ path, method, body });
    if (path === '/devices' && method === 'GET') return json({ items: devices, next_cursor: null });
    if (path.startsWith('/devices/') && method === 'PATCH') return json({ ...devices[0], ...body });
    if (path.startsWith('/devices/') && method === 'DELETE') return json(null, 204);
    if (path === '/push/senders') return json(SENDERS);
    if (path.startsWith('/push/senders/') && method === 'PUT') return json(SENDERS.items[1]);
    if (path === '/push/config') return json({ webpush_public_key: 'BK', providers: ['webpush'] });
    if (path === '/notify/notices') return json({ items: [], next_cursor: null, unread_count: 0 });
    if (path === '/notify/preferences')
      return json(
        body ?? {
          events: {},
          quiet_hours: { enabled: false, from: '22:00', to: '07:00', timezone: 'UTC' },
        },
      );
    if (path === '/notify/test-notice') return json({ id: 'n' }, 201);
    return json({ error: 'not found', code: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(fetchImpl: typeof fetch, node: ReactNode) {
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
              <MemoryRouter>{node}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

/** A browser, played: permission, a service worker registry and a push manager. */
function fakeBrowserEnv(permission: NotificationPermission, answer: NotificationPermission) {
  const calls: string[] = [];
  let subscription: Record<string, unknown> | null = null;
  const pushManager = {
    getSubscription: async () => subscription,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      calls.push(`subscribe:${options.applicationServerKey.length}`);
      subscription = {
        options,
        unsubscribe: async () => true,
        toJSON: () => ({
          endpoint: 'https://push.example/abc',
          keys: { p256dh: 'p', auth: 'a' },
        }),
      };
      return subscription;
    },
  };
  let registered = false;
  const env: PushEnvironment = {
    serviceWorker: {
      getRegistration: async () => (registered ? { pushManager } : undefined),
      register: async (url: string) => {
        calls.push(`register:${url}`);
        registered = true;
        return { pushManager };
      },
    } as unknown as ServiceWorkerContainer,
    notification: {
      permission,
      requestPermission: async () => {
        calls.push('permission');
        return answer;
      },
    },
    storage: memoryStorage(),
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  };
  return { env, calls };
}

describe('browser push, in this browser', () => {
  it('names the browser the way a person recognises it, and keeps one key', () => {
    expect(browserName('Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe(
      'Edge — Windows',
    );
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/130.0')).toBe(
      'Firefox — macOS',
    );
    const storage = memoryStorage();
    expect(deviceKey(storage)).toBe(deviceKey(storage));
    expect(Array.from(base64UrlToBytes('AQID_w'))).toEqual([1, 2, 3, 255]);
  });

  it('asks, registers the worker, subscribes with the hub key, then tells the hub', async () => {
    const { fetchImpl, sent } = hub([]);
    const answered = ((url: string, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/devices') && init.method === 'POST')
        return json(device({ id: 'browser-id', kind: 'browser', push: null }), 201);
      if (path.endsWith('/devices/browser-id/push'))
        return json({ provider: 'webpush', locale: 'en', registered_at: '2026-09-25T09:00:00Z' });
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const client = createHubClient({
      baseUrl: 'http://hub.test',
      fetch: (url, init) => {
        sent.push({
          path: new URL(String(url)).pathname.replace(/^\/api\/v1/, ''),
          method: (init?.method ?? 'GET').toUpperCase(),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return answered(String(url), init ?? {});
      },
    });
    const { env, calls } = fakeBrowserEnv('default', 'granted');
    expect(await browserPushState(env)).toBe('off');
    const key =
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    await enableBrowserPush(client, env, { publicKey: key, locale: 'en' });
    expect(calls).toEqual(['permission', 'register:/push-sw.js', 'subscribe:65']);
    const register = sent.find((s) => s.path === '/devices' && s.method === 'POST');
    expect(register?.body).toMatchObject({
      name: 'Chrome — Linux',
      platform: 'web',
      kind: 'browser',
      capabilities: ['notifications'],
    });
    const push = sent.find((s) => s.path === '/devices/browser-id/push');
    expect(push).toMatchObject({ method: 'PUT', body: { provider: 'webpush', locale: 'en' } });
    expect(JSON.parse((push!.body as { token: string }).token)).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('stops when the person says no, and tells the hub nothing', async () => {
    const { fetchImpl, sent } = hub([]);
    const client = createHubClient({ baseUrl: 'http://hub.test', fetch: fetchImpl });
    const { env } = fakeBrowserEnv('default', 'denied');
    await expect(
      enableBrowserPush(client, env, { publicKey: 'AQID', locale: 'ar' }),
    ).rejects.toBeInstanceOf(BrowserPushError);
    expect(sent).toEqual([]);
  });
});

describe('the device list', () => {
  it('lists devices with last seen and push, renames and revokes after asking', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = hub([device()]);
    mount(fetchImpl, <DevicesPanel isAdmin />);
    const row = await screen.findByTestId('device-row');
    expect(within(row).getByText('هاتف طارق')).toBeTruthy();
    expect(within(row).getByTestId('device-push').textContent).toBe('Push on · FCM (Android)');
    expect(within(row).getByTestId('device-seen').textContent).toMatch(/^Last active /);

    await user.click(within(row).getByTestId('device-rename'));
    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Work phone');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH')?.body).toEqual({ name: 'Work phone' }),
    );

    await user.click(within(row).getByTestId('device-revoke'));
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    const dialog = await screen.findByTestId('confirm-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'DELETE')?.path).toBe(
        '/devices/01J8QK3ZR2W7M5N4P6T8V9X0DV',
      ),
    );
  });

  it('shows the admin which senders are configured and what is missing', async () => {
    const { fetchImpl } = hub([]);
    mount(fetchImpl, <DevicesPanel isAdmin />);
    expect(await screen.findByText('No devices yet')).toBeTruthy();
    // Folded under the devices: one line, and nothing about fields or environment variables.
    const section = await screen.findByTestId('push-senders');
    expect(section.hasAttribute('open')).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId('push-senders-summary').textContent).toContain('APNs (iPhone)'),
    );
    const fcm = await screen.findByTestId('push-sender-fcm');
    expect(fcm.getAttribute('data-state')).toBe('not_configured');
    expect(section.textContent).not.toContain('service_account');
    expect(section.textContent).not.toContain('COREHUB_');
    expect(screen.getByTestId('push-sender-webpush').getAttribute('data-state')).toBe('ready');
  });

  it('lets the admin paste the FCM service account, stored and never filled back in', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = hub([]);
    mount(fetchImpl, <DevicesPanel isAdmin />);
    await user.click(await screen.findByTestId('push-senders-summary'));
    expect(screen.getByTestId('push-senders').hasAttribute('open')).toBe(true);
    await user.click(await screen.findByTestId('push-sender-edit-fcm'));
    const dialog = await screen.findByTestId('push-sender-dialog');
    // The environment is the other way, told inside the dialog only.
    const env = within(dialog).getByTestId('push-sender-env');
    expect(env.textContent).toContain('COREHUB_FCM_SERVICE_ACCOUNT');
    expect(within(env).getByRole('link', { name: 'docs/DEPLOY.md' }).getAttribute('href')).toBe(
      'https://github.com/twuijri/core-hub/blob/main/docs/DEPLOY.md',
    );
    expect(within(dialog).getByTestId('push-sender-save').hasAttribute('disabled')).toBe(true);
    // The file is the way in; the text field waits behind "Paste instead".
    expect(within(dialog).queryByLabelText('Service account JSON')).toBeNull();
    await user.click(within(dialog).getByTestId('push-sender-paste'));
    await user.click(within(dialog).getByLabelText('Service account JSON'));
    await user.paste('{"project_id":"p"}');
    expect(within(dialog).getByTestId('push-sender-save').hasAttribute('disabled')).toBe(true);
    await user.clear(within(dialog).getByLabelText('Service account JSON'));
    await user.paste(ACCOUNT);
    expect(within(dialog).getByTestId('push-sender-file-ok').textContent).toContain(
      'core-hub-66772',
    );
    await user.click(within(dialog).getByTestId('push-sender-save'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PUT' && s.path === '/push/senders/fcm')?.body).toEqual({
        enabled: true,
        service_account: ACCOUNT,
      }),
    );
  });

  it('does not show a member the push senders', async () => {
    const { fetchImpl, sent } = hub([]);
    mount(fetchImpl, <DevicesPanel isAdmin={false} />);
    await screen.findByText('No devices yet');
    expect(screen.queryByTestId('push-senders')).toBeNull();
    expect(sent.some((s) => s.path === '/push/senders')).toBe(false);
  });
});

describe('the Notifications page, push', () => {
  it('turns push off for one kind without touching its inbox switch', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = hub([]);
    mount(fetchImpl, <NotificationsTab />);
    await user.click(await screen.findByTestId('notify-push-run_completed'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PUT')?.body).toMatchObject({
        events: { run_completed: { in_app: true, push: false } },
      }),
    );
  });

  it('offers a test notification, and says when this browser cannot get push', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = hub([]);
    mount(fetchImpl, <NotificationsTab />);
    // jsdom has no service worker: the page says so instead of a button that cannot work.
    expect(await screen.findByText('This browser cannot receive push notifications.')).toBeTruthy();
    await user.click(screen.getByTestId('send-test-notice'));
    await waitFor(() =>
      expect(sent.some((s) => s.path === '/notify/test-notice' && s.method === 'POST')).toBe(true),
    );
    expect(await screen.findByText('Sent. Check this browser and your devices.')).toBeTruthy();
  });
});
