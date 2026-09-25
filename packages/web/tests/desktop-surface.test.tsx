// The web client inside the desktop app (apps/desktop, ADR 0009): the same bundle, told by
// the app's bridge that it is the `desktop` surface of navigation.json.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore, type StoredSession } from '../src/auth/store.js';
import type { DesktopBridge, DesktopState } from '../src/desktop/bridge-types.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { adoptDesktopSession } from '../src/desktop/desktop.js';
import { notifyDesktop } from '../src/desktop/effects.js';
import { pairingLinkOf } from '../src/screens/DeviceConnectionsScreen.js';
import { ThisDeviceTab } from '../src/settings/ThisDeviceTab.js';

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

const SESSION: StoredSession = {
  profile: 'default',
  token: 'hub_at_x',
  refresh_token: null,
  expires_at: null,
  user: { id: 'u', username: 'owner', display_name: 'Owner', role: 'owner' },
};

function fakeBridge(over: Partial<DesktopState> = {}) {
  let state: DesktopState = {
    appVersion: '1.2.3',
    platform: 'linux',
    mode: 'remote',
    hubUrl: 'https://hub.example',
    closeToTray: true,
    trayAvailable: true,
    ...over,
  };
  const bridge = {
    surface: 'desktop' as const,
    getState: vi.fn(async () => state),
    takePendingSession: vi.fn(async (): Promise<unknown> => null),
    changeConnection: vi.fn(async () => {}),
    setCloseToTray: vi.fn(async (value: boolean) => {
      state = { ...state, closeToTray: value };
      return state;
    }),
    setLanguage: vi.fn(),
    notify: vi.fn(),
    setUnreadCount: vi.fn(),
    onOpenPath: vi.fn(() => () => {}),
  } satisfies DesktopBridge;
  return bridge;
}

const meta = {
  name: 'Core Hub',
  server_version: '0.1.0',
  contract_version: '1.0.0',
  api_versions: ['v1'],
  realtime_namespaces: [],
  locales: ['ar', 'en'],
  setup_required: false,
};
const fetchImpl = (async (url: string) =>
  new URL(String(url)).pathname.endsWith('/meta')
    ? new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ error: 'x', code: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

function mountThisDevice() {
  const store = new SessionStore(memoryStorage());
  store.save(SESSION);
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <ThisDeviceTab />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const withBridge = (bridge: unknown) => {
  (globalThis as { corehubDesktop?: unknown }).corehubDesktop = bridge;
};

afterEach(() => {
  cleanup();
  delete (globalThis as { corehubDesktop?: unknown }).corehubDesktop;
});

describe('surface', () => {
  // The surface is decided when the manifest module loads, so each case loads it afresh.
  beforeEach(() => {
    vi.resetModules();
  });

  it('is the web without a bridge, and has no This device page', async () => {
    const manifest = await import('../src/navigation/manifest.js');
    expect(manifest.SURFACE).toBe('web');
    expect(manifest.webDestinations.some((d) => d.id === 'this_device')).toBe(false);
  });

  it('is the desktop with the bridge: every web route, plus This device', async () => {
    withBridge(fakeBridge());
    const manifest = await import('../src/navigation/manifest.js');
    const { routes } = await import('../src/navigation/routes.js');
    const { SETTINGS_IDS } = await import('../src/settings/SettingsNav.js');
    expect(manifest.SURFACE).toBe('desktop');
    expect(manifest.routeOf('this_device')).toBe('/settings/this-device');
    // The desktop inherits the web's routes rather than keeping a second list.
    for (const [id, route] of Object.entries(manifest.navigation.surfaceRoutes.web ?? {}))
      if (!id.startsWith('$')) expect(manifest.routeOf(id)).toBe(route);
    expect(routes.map((r) => r.id)).toContain('this_device');
    // In the settings list, between Privacy and About, as navigation.json orders the tabs.
    const tabs = SETTINGS_IDS.filter((id) => manifest.navigation.settingsTabs.includes(id));
    expect(tabs.slice(tabs.indexOf('privacy'), tabs.indexOf('about') + 1)).toEqual([
      'privacy',
      'this_device',
      'about',
    ]);
  });

  it('ignores a window property that is not the bridge', async () => {
    withBridge({ surface: 'web' });
    const manifest = await import('../src/navigation/manifest.js');
    expect(manifest.SURFACE).toBe('web');
  });
});

describe('pairing hand-over', () => {
  it('stores the session the app got by pairing, once', async () => {
    const bridge = fakeBridge();
    bridge.takePendingSession.mockResolvedValueOnce(SESSION);
    withBridge(bridge);
    const store = new SessionStore(memoryStorage());
    await adoptDesktopSession(store);
    expect(store.read()?.token).toBe('hub_at_x');
  });

  it('keeps the existing sign-in when what arrives is not a session', async () => {
    const bridge = fakeBridge();
    bridge.takePendingSession.mockResolvedValueOnce({ token: 1 });
    withBridge(bridge);
    const store = new SessionStore(memoryStorage());
    store.save({ ...SESSION, token: 'mine' });
    await adoptDesktopSession(store);
    expect(store.read()?.token).toBe('mine');
  });
});

describe('notices reach the OS', () => {
  it('hands a new notice to the app, pointing at its conversation', async () => {
    const bridge = fakeBridge();
    withBridge(bridge);
    notifyDesktop({
      event: 'notice.created',
      namespace: '/rt/devices',
      profile: null,
      ts: '2026-09-25T00:00:00Z',
      seq: 1,
      payload: {
        notice: {
          title: 'Run finished',
          body: 'All done',
          resource: { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0SS' },
        },
        unread_count: 1,
      },
    });
    expect(bridge.notify).toHaveBeenCalledWith({
      title: 'Run finished',
      body: 'All done',
      path: '/chat/01J8QK3ZR2W7M5N4P6T8V9X0SS',
    });
  });

  it('does nothing in a browser', async () => {
    expect(() => notifyDesktop({ payload: {} })).not.toThrow();
  });
});

describe('This device', () => {
  it('shows the connection the app reports and hands the change back to it', async () => {
    const bridge = fakeBridge();
    withBridge(bridge);
    mountThisDevice();
    await waitFor(() =>
      expect(screen.getByTestId('this-device-hub').textContent).toBe('https://hub.example'),
    );
    expect(screen.getByTestId('this-device-mode').textContent).toBe('Connected to a hub');
    expect(screen.getByTestId('this-device-version').textContent).toBe('1.2.3');
    expect(screen.getByTestId('this-device-platform').textContent).toBe('Linux');
    await waitFor(() =>
      expect(screen.getByTestId('this-device-hub-state').textContent).toContain('0.1.0'),
    );
    await userEvent.click(screen.getByTestId('this-device-change'));
    expect(bridge.changeConnection).toHaveBeenCalledOnce();
  });

  it('turns keeping the app in the tray off through the app', async () => {
    const bridge = fakeBridge();
    withBridge(bridge);
    mountThisDevice();
    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle);
    expect(bridge.setCloseToTray).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('says so when the desktop has no tray instead of offering a switch that does nothing', async () => {
    withBridge(fakeBridge({ trayAvailable: false }));
    mountThisDevice();
    const toggle = await screen.findByRole('switch');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/no tray/)).toBeTruthy();
  });
});

describe('pairing link for a computer', () => {
  it('turns the QR payload into a corehub://pair link', () => {
    const link = pairingLinkOf(
      JSON.stringify({
        type: 'corehub.pairing',
        hub_url: 'https://hub.example',
        pairing_id: '01J8QK3ZR2W7M5N4P6T8V9X0PR',
        code: '7KQ2-M9XW',
        expires_at: '2026-09-21T11:20:00Z',
      }),
    );
    expect(link).toBe(
      'corehub://pair?hub=https%3A%2F%2Fhub.example&id=01J8QK3ZR2W7M5N4P6T8V9X0PR&code=7KQ2-M9XW',
    );
    expect(pairingLinkOf('not json')).toBeNull();
    expect(pairingLinkOf('{"hub_url":1}')).toBeNull();
  });
});
