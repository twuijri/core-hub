// The web client inside the desktop app (apps/desktop, ADR 0009): the same bundle, told by
// the app's bridge that it is the `desktop` surface of navigation.json.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore, type StoredSession } from '../src/auth/store.js';
import type {
  DesktopBridge,
  DesktopDeviceState,
  DesktopHelperState,
  DesktopProgramsState,
  DesktopState,
} from '../src/desktop/bridge-types.js';
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

const RELEASES = 'https://github.com/twuijri/core-hub/releases';

function fakeHelper(over: Partial<DesktopHelperState> = {}) {
  let helper: DesktopHelperState = {
    enabled: false,
    url: null,
    token: 'a'.repeat(64),
    folders: [],
    allowOpen: false,
    tools: [
      { name: 'list_allowed_folders', description: '' },
      { name: 'list_directory', description: '' },
      { name: 'read_text_file', description: '' },
    ],
    activity: [],
    error: null,
    ...over,
  };
  const set = (patch: Partial<DesktopHelperState>) => (helper = { ...helper, ...patch });
  return {
    get: vi.fn(async () => helper),
    // As the app does: on with nothing shared, its own folder is shared writable (§89).
    setEnabled: vi.fn(async (value: boolean) =>
      set({
        enabled: value,
        url: value ? 'http://127.0.0.1:47001/mcp' : null,
        ...(value && helper.folders.length === 0
          ? {
              folders: [{ path: '/home/t/Core Hub', write: true }],
              defaultFolder: '/home/t/Core Hub',
            }
          : {}),
      }),
    ),
    addFolder: vi.fn(async () =>
      set({ folders: [...helper.folders, { path: '/home/t/Docs', write: false }] }),
    ),
    removeFolder: vi.fn(async (folder: string) =>
      set({ folders: helper.folders.filter((f) => f.path !== folder) }),
    ),
    setFolderWrite: vi.fn(async () => helper),
    setAllowOpen: vi.fn(async (value: boolean) => set({ allowOpen: value })),
    newToken: vi.fn(async () => helper),
  };
}

const RESOLVE_PROGRAM = {
  id: 'davinci-resolve',
  name: 'DaVinci Resolve',
  source: 'claude_desktop_extension' as const,
  origin: '/home/t/.config/Claude/Claude Extensions/ant.resolve/manifest.json',
  description: 'Drive DaVinci Resolve.',
  status: 'needs_setup' as const,
  fields: [
    {
      key: 'api_key',
      title: 'API key',
      description: null,
      sensitive: true,
      required: true,
      set: false,
      value: null,
    },
  ],
  profiles: [] as string[],
  tools: [] as Array<{ name: string; description: string }>,
  running: false,
  error: null,
  resolve: true,
};

function fakePrograms() {
  let state: DesktopProgramsState = {
    programs: [
      RESOLVE_PROGRAM,
      {
        ...RESOLVE_PROGRAM,
        id: 'figma',
        name: 'Figma',
        source: 'cursor',
        origin: '/home/t/.cursor/mcp.json',
        description: null,
        status: 'remote',
        fields: [],
        resolve: false,
      },
    ],
    scannedAt: '2026-09-27T10:00:00Z',
    resolve: null,
  };
  const program = (id: string) => state.programs.find((p) => p.id === id)!;
  const put = (id: string, patch: Partial<DesktopProgramsState['programs'][number]>) =>
    (state = {
      ...state,
      programs: state.programs.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  return {
    get: vi.fn(async () => state),
    rescan: vi.fn(async () => state),
    setProfiles: vi.fn(async (id: string, profiles: string[]) =>
      put(id, {
        profiles,
        tools: profiles.length > 0 ? [{ name: 'render', description: 'Render the timeline' }] : [],
      }),
    ),
    setField: vi.fn(async (id: string, key: string, value: string | null) =>
      put(id, {
        status: value ? 'ready' : 'needs_setup',
        fields: program(id).fields.map((f) => (f.key === key ? { ...f, set: !!value } : f)),
      }),
    ),
    checkResolve: vi.fn(async () => ({
      ...state,
      resolve: {
        checkedAt: '2026-09-27T10:01:00Z',
        programId: 'davinci-resolve',
        integration: 'shared' as const,
        running: true,
        scripting: 'unreachable' as const,
        product: null,
        version: null,
        studio: null,
        steps: ['enable_scripting' as const, 'needs_studio' as const],
      },
    })),
  };
}

function fakeDevice() {
  let state: DesktopDeviceState = {
    hub: 'https://hub.example',
    linked: false,
    deviceId: null,
    status: 'unlinked',
    detail: null,
  };
  return {
    get: vi.fn(async () => state),
    link: vi.fn(async () => {
      state = { ...state, linked: true, deviceId: DEVICE_ID, status: 'connected' };
      return state;
    }),
    forget: vi.fn(async () => {
      state = { ...state, linked: false, deviceId: null, status: 'unlinked' };
      return state;
    }),
  };
}

const DEVICE_ID = '01J8QK3ZR2W7M5N4P6T8V9X0DV';

/** What the OS answered about the microphone, for the fake bridge. */
let micStatus: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' = 'unknown';

/** The hub's `devices.getRelay`, as the desktop app would answer it through the hub. */
const RELAY_OFF = {
  available: true,
  enabled: false,
  connected: false,
  route: null,
  relay_url: null,
  hub_port: 47113,
  token_set: false,
  tunnel_id: null,
  hostname: null,
  hostnames: [],
  tailnet: null,
  error: null,
  error_detail: null,
  connected_at: null,
};
let relayState: Record<string, unknown> = { ...RELAY_OFF };

function fakeBridge(
  over: Partial<DesktopState> = {},
  helperOver: Partial<DesktopHelperState> = {},
) {
  let state: DesktopState = {
    appVersion: '1.2.3',
    platform: 'linux',
    mode: 'remote',
    hubUrl: 'https://hub.example',
    closeToTray: true,
    trayAvailable: true,
    local: null,
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
    helper: fakeHelper(helperOver),
    programs: fakePrograms(),
    voice: {
      mic: vi.fn(async () => ({ status: micStatus, canOpenSettings: true })),
      askMic: vi.fn(async () => ({ status: 'granted' as const, canOpenSettings: true })),
      openMicSettings: vi.fn(async () => {}),
    },
    device: fakeDevice(),
    updates: {
      get: vi.fn(async () => ({ auto: true, last: null, releasesPage: RELEASES })),
      check: vi.fn(async () => ({
        auto: true,
        releasesPage: RELEASES,
        last: {
          status: 'available' as const,
          current: '1.2.3',
          checkedAt: '2026-09-25T10:00:00Z',
          update: {
            version: '1.3.0',
            download: 'https://dl.example/Core-Hub-1.3.0-x86_64.AppImage',
            size: 125_800_000,
            page: `${RELEASES}/tag/v1.3.0`,
          },
        },
      })),
      setAuto: vi.fn(async (value: boolean) => ({
        auto: value,
        last: null,
        releasesPage: RELEASES,
      })),
    },
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
const sent: Array<{ method: string; path: string; body: unknown }> = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const fetchImpl = (async (url: string, init: RequestInit = {}) => {
  const pathname = new URL(String(url)).pathname;
  const method = (init.method ?? 'GET').toUpperCase();
  sent.push({ method, path: pathname, body: init.body ? JSON.parse(String(init.body)) : null });
  if (pathname.endsWith('/meta')) return json(meta);
  if (pathname.endsWith('/models/speech'))
    return json({ stt: { ready: true }, tts: { ready: false } });
  if (pathname.endsWith('/relay') && method === 'PUT') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    relayState = {
      ...relayState,
      enabled: body.enabled ?? relayState.enabled,
      route: body.route ?? relayState.route,
      hostname: body.hostname ?? relayState.hostname,
      token_set: body.token ? true : relayState.token_set,
      tunnel_id: body.token ? '6ff42ae2' : relayState.tunnel_id,
      connected: body.enabled === true,
      relay_url: body.enabled === true ? 'https://hub.example.com' : null,
    };
    return json(relayState);
  }
  if (pathname.endsWith('/relay')) return json(relayState);
  if (pathname.endsWith('/agents')) return json({ items: [{ id: 'AG1', slug: 'hermes' }] });
  if (pathname.endsWith('/agents/AG1/mcp-servers'))
    return method === 'POST' ? json({ name: 'this-computer' }, 201) : json({ items: [] });
  if (pathname.endsWith('/profiles'))
    return json({
      items: [
        { id: 'P1', slug: 'default', name: 'Default' },
        { id: 'P2', slug: 'work', name: 'Work' },
      ],
    });
  if (pathname.endsWith('/auth/pairings') && method === 'POST')
    return json({ id: '01J8QK3ZR2W7M5N4P6T8V9X0PR', code: '7KQ2-M9XW', status: 'pending' }, 201);
  if (pathname.endsWith(`/devices/${DEVICE_ID}`) && method === 'PATCH')
    return json({ id: DEVICE_ID, profiles: ['work'] });
  if (pathname.endsWith('/devices'))
    return json({ items: [{ id: DEVICE_ID, profiles: null }], next_cursor: null });
  return json({ error: 'x', code: 'not_found' }, 404);
}) as unknown as typeof fetch;

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
    // The desktop inherits the web's routes rather than keeping a second list — all but a
    // destination the manifest keeps to the web alone (the owner's terminal, DECISIONS §70).
    for (const [id, route] of Object.entries(manifest.navigation.surfaceRoutes.web ?? {})) {
      const destination = manifest.destinationsById.get(id);
      if (id.startsWith('$') || (destination && !manifest.onThisSurface(destination))) continue;
      expect(manifest.routeOf(id)).toBe(route);
    }
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

describe('This device in local mode', () => {
  it('says where the hub keeps its data and which Hermes it runs', async () => {
    withBridge(
      fakeBridge({
        mode: 'local',
        hubUrl: 'http://127.0.0.1:40123',
        local: {
          dataDir: '/home/t/.config/Core Hub/local-hub',
          hermes: 'program',
          hermesProgram: '/home/t/.local/bin/hermes',
        },
      }),
    );
    mountThisDevice();
    await waitFor(() =>
      expect(screen.getByTestId('this-device-mode').textContent).toBe('Running on this computer'),
    );
    expect(screen.getByTestId('this-device-data-dir').textContent).toBe(
      '/home/t/.config/Core Hub/local-hub',
    );
    expect(screen.getByTestId('this-device-hermes').textContent).toBe('Installed on this computer');
    expect(screen.getByTestId('this-device-hermes-path').textContent).toBe(
      '/home/t/.local/bin/hermes',
    );
  });

  it('has no Hermes rows in remote mode', async () => {
    withBridge(fakeBridge());
    mountThisDevice();
    await screen.findByTestId('this-device-hub');
    expect(screen.queryByTestId('this-device-hermes')).toBeNull();
  });
});

describe('local helper permission screen', () => {
  it('is off by default; on, it shares the app’s own folder and shows exactly what it exposes', async () => {
    const bridge = fakeBridge({ mode: 'local', hubUrl: 'http://127.0.0.1:40123' });
    withBridge(bridge);
    mountThisDevice();
    const helper = await screen.findByTestId('helper');
    expect(screen.getByTestId('helper-enabled').getAttribute('aria-checked')).toBe('false');
    // Off: nothing below the switch but what it says.
    expect(screen.queryByTestId('helper-folders-fold')).toBeNull();
    await userEvent.click(screen.getByTestId('helper-enabled'));
    await waitFor(() =>
      expect(screen.getByTestId('helper-folders').textContent).toContain('/home/t/Core Hub'),
    );
    expect(screen.getByTestId('helper-default-folder').textContent).toBe('Core Hub folder');
    expect(
      [...helper.querySelectorAll('[data-tool]')].map((li) => li.getAttribute('data-tool')),
    ).toEqual(['list_allowed_folders', 'list_directory', 'read_text_file']);
    await userEvent.click(screen.getByTestId('helper-add-folder'));
    await waitFor(() =>
      expect(screen.getByTestId('helper-folders').textContent).toContain('/home/t/Docs'),
    );
    // The page stays one page: programs are a part of it, not a page of their own.
    expect(within(helper).getByTestId('programs')).toBeTruthy();
  });

  it('turned on in local mode, adds itself to Hermes through the hub’s MCP contract', async () => {
    sent.length = 0;
    const bridge = fakeBridge({ mode: 'local', hubUrl: 'http://127.0.0.1:40123' });
    withBridge(bridge);
    mountThisDevice();
    await screen.findByTestId('helper');
    const toggle = screen.getByTestId('helper-enabled');
    await userEvent.click(toggle);
    expect(bridge.helper.setEnabled).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(screen.getByTestId('helper-url').textContent).toBe('http://127.0.0.1:47001/mcp'),
    );
    const add = await screen.findByTestId('helper-add-to-hermes');
    await waitFor(() => expect(add.hasAttribute('disabled')).toBe(false));
    await userEvent.click(add);
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'POST')).toEqual({
        method: 'POST',
        // The contract's agents.createMcpServer, for the Hermes agent the hub listed.
        path: expect.stringMatching(/\/agents\/AG1\/mcp-servers$/),
        body: {
          name: 'this-computer',
          transport: 'http',
          enabled: true,
          config: {
            url: 'http://127.0.0.1:47001/mcp',
            // Which profile asks, so the helper offers that profile's programs only.
            headers: {
              Authorization: `Bearer ${'a'.repeat(64)}`,
              'X-Corehub-Profile': 'default',
            },
          },
        },
      }),
    );
  });

  it('links this computer to a hub on a server with a pairing of the person’s own', async () => {
    sent.length = 0;
    const bridge = fakeBridge({}, { enabled: true, url: 'http://127.0.0.1:47001/mcp' });
    withBridge(bridge);
    mountThisDevice();
    const panel = await screen.findByTestId('device-link');
    expect(screen.getByTestId('device-link-status').textContent).toBe('Not linked');
    // The loopback address and the Hermes button belong to the hub on this computer only.
    expect(screen.queryByTestId('helper-url')).toBeNull();
    expect(screen.queryByTestId('helper-add-to-hermes')).toBeNull();
    await userEvent.click(within(panel).getByTestId('device-link-button'));
    await waitFor(() =>
      expect(bridge.device.link).toHaveBeenCalledWith('01J8QK3ZR2W7M5N4P6T8V9X0PR', '7KQ2-M9XW'),
    );
    expect(sent.find((r) => r.path.endsWith('/auth/pairings'))).toMatchObject({ method: 'POST' });
    await waitFor(() =>
      expect(screen.getByTestId('device-link-status').textContent).toBe('Connected'),
    );
    // Every profile until the person narrows it; leaving one out sends the rest.
    const work = await screen.findByTestId('device-link-profile-default');
    expect(work.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(work);
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PATCH')).toMatchObject({
        path: `/api/v1/devices/${DEVICE_ID}`,
        body: { profiles: ['work'] },
      }),
    );
  });
});

describe('programs on this computer', () => {
  it('lists what other assistants registered, takes a missing setting, and switches one on per profile', async () => {
    const bridge = fakeBridge({}, { enabled: true });
    withBridge(bridge);
    mountThisDevice();
    const programs = await screen.findByTestId('programs');
    const resolve = within(programs).getByTestId('program-davinci-resolve');
    expect(within(resolve).getByText('Claude Desktop extension')).toBeTruthy();
    expect(screen.getByTestId('program-status-davinci-resolve').textContent).toBe('Needs setup');
    expect(screen.getByTestId('program-status-figma').textContent).toBe('Online server');
    // Needs setup: no profile can switch it on until the key is given.
    expect(screen.queryByTestId('program-profiles-davinci-resolve')).toBeNull();
    await userEvent.type(within(resolve).getByLabelText(/API key/), 'k-123');
    await userEvent.click(within(resolve).getByRole('button', { name: 'Save' }));
    expect(bridge.programs.setField).toHaveBeenCalledWith('davinci-resolve', 'api_key', 'k-123');
    await waitFor(() =>
      expect(screen.getByTestId('program-status-davinci-resolve').textContent).toBe('Ready'),
    );
    await userEvent.click(await screen.findByTestId('program-davinci-resolve-profile-work'));
    expect(bridge.programs.setProfiles).toHaveBeenCalledWith('davinci-resolve', ['work']);
    await waitFor(() =>
      expect(screen.getByTestId('program-tools-davinci-resolve').textContent).toContain('render'),
    );
  });

  it('checks DaVinci Resolve and says what to fix, step by step', async () => {
    const bridge = fakeBridge({}, { enabled: true });
    withBridge(bridge);
    mountThisDevice();
    await userEvent.click(await screen.findByTestId('resolve-check'));
    const steps = await screen.findByTestId('resolve-steps');
    expect(
      [...steps.querySelectorAll('[data-step]')].map((li) => li.getAttribute('data-step')),
    ).toEqual(['enable_scripting', 'needs_studio']);
    expect(steps.textContent).toContain('External scripting using → Local');
  });
});

describe('desktop updates', () => {
  it('checks when asked and links the installer — it never installs by itself', async () => {
    const bridge = fakeBridge();
    withBridge(bridge);
    mountThisDevice();
    await screen.findByTestId('desktop-updates');
    expect(screen.getByTestId('updates-auto').getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByTestId('updates-check'));
    expect(bridge.updates.check).toHaveBeenCalledOnce();
    const link = await screen.findByTestId('updates-download');
    expect(link.getAttribute('href')).toBe('https://dl.example/Core-Hub-1.3.0-x86_64.AppImage');
    expect(link.textContent).toContain('126 MB');
    expect(screen.getByTestId('updates-available').textContent).toContain('1.3.0');
  });

  it('turns the daily check off through the app', async () => {
    const bridge = fakeBridge();
    withBridge(bridge);
    mountThisDevice();
    await userEvent.click(await screen.findByTestId('updates-auto'));
    expect(bridge.updates.setAuto).toHaveBeenCalledWith(false);
  });

  it('in the Microsoft Store build, says the Store updates it and offers no check', async () => {
    const bridge = fakeBridge();
    const store = {
      channel: 'store' as const,
      auto: false,
      last: null,
      releasesPage: 'https://apps.microsoft.com/detail/9MT62R5V3P5N',
    };
    bridge.updates.get.mockImplementation(async () => store);
    withBridge(bridge);
    mountThisDevice();
    expect((await screen.findByTestId('updates-store')).textContent).toBe(
      'Updates come from the Microsoft Store.',
    );
    expect(screen.getByText('Open in the Microsoft Store').getAttribute('href')).toBe(
      store.releasesPage,
    );
    expect(screen.queryByTestId('updates-check')).toBeNull();
    expect(screen.queryByTestId('updates-auto')).toBeNull();
    expect(bridge.updates.check).not.toHaveBeenCalled();
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

describe('Voice in This device', () => {
  afterEach(() => {
    micStatus = 'unknown';
  });

  it('says what the system answered about the microphone, and opens its settings when blocked', async () => {
    micStatus = 'denied';
    const bridge = fakeBridge();
    withBridge(bridge);
    mountThisDevice();
    const part = await screen.findByTestId('desktop-voice');
    await waitFor(() => expect(within(part).getByText('Blocked')).toBeTruthy());
    // The page no longer says the desktop app has no voice.
    expect(screen.queryByText(/not in the desktop app yet/)).toBeNull();
    await userEvent.click(within(part).getByTestId('desktop-voice-settings'));
    expect(bridge.voice.openMicSettings).toHaveBeenCalledOnce();
  });

  it('asks the system on macOS while it has not been asked', async () => {
    micStatus = 'not-determined';
    const bridge = fakeBridge({ platform: 'darwin' });
    withBridge(bridge);
    mountThisDevice();
    await userEvent.click(await screen.findByTestId('desktop-voice-ask'));
    expect(bridge.voice.askMic).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText('Allowed')).toBeTruthy());
  });

  it('says so when this browser cannot record, instead of hanging', async () => {
    withBridge(fakeBridge());
    mountThisDevice();
    await userEvent.click(await screen.findByTestId('desktop-voice-test'));
    expect((await screen.findByTestId('desktop-voice-result')).textContent).toBe(
      'No microphone could be opened.',
    );
  });
});

describe('Reach from outside in This device', () => {
  const LOCAL = {
    mode: 'local' as const,
    hubUrl: 'http://127.0.0.1:47113',
    local: {
      dataDir: '/home/t/.config/Core Hub/local-hub',
      hermes: 'program' as const,
      hermesProgram: null,
    },
  };
  beforeEach(() => {
    relayState = { ...RELAY_OFF };
    sent.length = 0;
  });

  it('is not offered when the app talks to a hub on a server', async () => {
    withBridge(fakeBridge());
    mountThisDevice();
    await screen.findByTestId('desktop-voice');
    expect(screen.queryByTestId('outside-access')).toBeNull();
  });

  it('warns first, then hands the pasted token to the hub once and never shows it', async () => {
    withBridge(fakeBridge(LOCAL));
    mountThisDevice();
    const part = await screen.findByTestId('outside-access');
    expect(within(part).getByTestId('outside-warning').textContent).toContain(
      'reachable from the internet',
    );
    expect(within(part).getByTestId('outside-service').textContent).toBe('http://localhost:47113');
    const on = within(part).getByTestId('outside-on');
    expect(on.hasAttribute('disabled')).toBe(true);
    await userEvent.type(
      within(part).getByTestId('outside-token'),
      'eyJhIjoiYSIsInQiOiJ0IiwicyI6InMifQ==',
    );
    await userEvent.type(within(part).getByTestId('outside-hostname'), 'hub.example.com');
    await userEvent.click(on);
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PUT' && r.path.endsWith('/relay'))?.body).toEqual({
        enabled: true,
        route: 'cloudflare',
        hostname: 'hub.example.com',
        token: 'eyJhIjoiYSIsInQiOiJ0IiwicyI6InMifQ==',
      }),
    );
    expect((await within(part).findByTestId('outside-connected')).textContent).toContain(
      'https://hub.example.com',
    );
    expect(within(part).getByTestId('outside-token-kept').textContent).toContain('6ff42ae2');
    expect((within(part).getByTestId('outside-token') as HTMLInputElement).value).toBe('');
  });

  it('offers Tailscale only when this computer is on a tailnet', async () => {
    relayState = { ...RELAY_OFF, tailnet: { address: '100.101.102.103', dns_name: null } };
    withBridge(fakeBridge(LOCAL));
    mountThisDevice();
    const part = await screen.findByTestId('outside-access');
    await userEvent.click(within(part).getByRole('radio', { name: /Tailscale/ }));
    expect(within(part).getByTestId('outside-tailnet').textContent).toBe('100.101.102.103');
    await userEvent.click(within(part).getByTestId('outside-on'));
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PUT')?.body).toEqual({
        enabled: true,
        route: 'tailscale',
      }),
    );
  });
});

describe('dictation in the desktop app', () => {
  it('never falls back to the browser recognizer, which has no service behind it in Electron', async () => {
    const { browserRecognizer } = await import('../src/voice/useDictation.js');
    const scope = window as unknown as { webkitSpeechRecognition?: unknown };
    scope.webkitSpeechRecognition = class {};
    try {
      expect(browserRecognizer()).not.toBeNull();
      withBridge(fakeBridge());
      expect(browserRecognizer()).toBeNull();
    } finally {
      delete scope.webkitSpeechRecognition;
    }
  });
});
