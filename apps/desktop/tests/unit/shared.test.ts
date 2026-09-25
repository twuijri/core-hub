// The desktop app's pure logic: addresses, links, settings, window placement, words.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW,
  RECENT_LIMIT,
  defaultConfig,
  languageFromLocale,
  parseConfig,
  withRemote,
} from '../../src/shared/config.js';
import {
  deepLinkFromArgv,
  isSafeAppPath,
  pairingLink,
  parseDeepLink,
  parsePairingInput,
} from '../../src/shared/deep-link.js';
import { normalizeHubUrl, partitionKey } from '../../src/shared/hub-url.js';
import { direction, isolate, translate } from '../../src/shared/i18n.js';
import { placeWindow } from '../../src/shared/window-state.js';

const ID = '01J8QK3ZR2W7M5N4P6T8V9X0PR';

describe('hub address', () => {
  it.each([
    ['hub.example.com', 'https://hub.example.com'],
    ['  https://hub.example.com/chat/01J?x=1  ', 'https://hub.example.com'],
    ['http://hub.example.com:8080/', 'http://hub.example.com:8080'],
    ['192.168.1.20:8080', 'http://192.168.1.20:8080'],
    ['localhost:8080', 'http://localhost:8080'],
    ['10.0.0.5', 'http://10.0.0.5'],
    ['nas.local:8080', 'http://nas.local:8080'],
    ['172.20.1.1', 'http://172.20.1.1'],
    ['172.40.1.1', 'https://172.40.1.1'],
  ])('%s → %s', (input, origin) => {
    expect(normalizeHubUrl(input)).toEqual({ ok: true, origin });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['ftp://hub.example', 'scheme'],
    ['https://user:secret@hub.example', 'credentials'],
    ['http://', 'invalid'],
    ['https://exa mple.com', 'invalid'],
  ])('refuses %j (%s)', (input, reason) => {
    expect(normalizeHubUrl(input)).toEqual({ ok: false, reason });
  });

  it('gives each hub its own, stable storage partition', () => {
    expect(partitionKey('https://a.example')).toBe(partitionKey('https://a.example'));
    expect(partitionKey('https://a.example')).not.toBe(partitionKey('https://b.example'));
    expect(partitionKey('https://a.example')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('corehub:// links', () => {
  it('opens an app page, never another origin', () => {
    expect(parseDeepLink(`corehub://open/chat/${ID}`)).toEqual({
      kind: 'open',
      path: `/chat/${ID}`,
    });
    expect(parseDeepLink('corehub://open/schedules?workflow_run=1')).toEqual({
      kind: 'open',
      path: '/schedules?workflow_run=1',
    });
    expect(parseDeepLink('corehub://open//evil.example')).toBeNull();
    // `..` is resolved by the URL parser: what is left is still a page of the app.
    expect(parseDeepLink('corehub://open/../../settings')).toEqual({
      kind: 'open',
      path: '/settings',
    });
    expect(parseDeepLink('corehub://open/a\\b')).toBeNull();
    expect(isSafeAppPath('/settings/this-device')).toBe(true);
    expect(isSafeAppPath('https://evil.example')).toBe(false);
    expect(isSafeAppPath('//evil.example')).toBe(false);
  });

  it('connects only to a real address', () => {
    expect(parseDeepLink('corehub://connect?hub=hub.example.com')).toEqual({
      kind: 'connect',
      hub: 'https://hub.example.com',
    });
    expect(parseDeepLink('corehub://connect?hub=javascript:alert(1)')).toBeNull();
    expect(parseDeepLink('corehub://connect')).toBeNull();
  });

  it('pairs with a well-formed pairing only', () => {
    const link = pairingLink({ hub: 'https://hub.example', pairingId: ID, code: '7KQ2-M9XW' });
    expect(parseDeepLink(link)).toEqual({
      kind: 'pair',
      pairing: { hub: 'https://hub.example', pairingId: ID, code: '7KQ2-M9XW' },
    });
    expect(
      parseDeepLink('corehub://pair?hub=https://hub.example&id=nope&code=7KQ2-M9XW'),
    ).toBeNull();
    expect(
      parseDeepLink(`corehub://pair?hub=https://hub.example&id=${ID}&code=<script>`),
    ).toBeNull();
  });

  it('refuses other schemes and unknown actions', () => {
    expect(parseDeepLink('https://hub.example')).toBeNull();
    expect(parseDeepLink('corehub://format-disk')).toBeNull();
    expect(parseDeepLink('not a url')).toBeNull();
  });

  it('finds the link Windows and Linux pass on the command line', () => {
    expect(deepLinkFromArgv(['/opt/Core Hub/corehub', '--flag', 'corehub://open/tasks'])).toBe(
      'corehub://open/tasks',
    );
    expect(deepLinkFromArgv(['/opt/corehub'])).toBeNull();
  });

  it('reads a pasted QR payload or a pasted link', () => {
    const payload = {
      type: 'corehub.pairing',
      hub_url: 'https://hub.example',
      pairing_id: ID,
      code: '7kq2-m9xw',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const expected = { hub: 'https://hub.example', pairingId: ID, code: '7KQ2-M9XW' };
    expect(parsePairingInput(JSON.stringify(payload))).toEqual(expected);
    expect(parsePairingInput(JSON.stringify({ ...payload, type: 'majlis.pairing' }))).toEqual(
      expected,
    );
    expect(parsePairingInput(pairingLink(expected))).toEqual(expected);
    expect(
      parsePairingInput(JSON.stringify({ ...payload, expires_at: '2020-01-01T00:00:00Z' })),
    ).toBeNull();
    expect(parsePairingInput(JSON.stringify({ ...payload, type: 'other' }))).toBeNull();
    expect(parsePairingInput('corehub://open/chat')).toBeNull();
    expect(parsePairingInput('{broken')).toBeNull();
  });
});

describe('settings file', () => {
  const id = () => 'device-key-1234';

  it('starts at the first-run screen with a device key', () => {
    const config = defaultConfig(id);
    expect(config.mode).toBeNull();
    expect(config.deviceKey).toBe('device-key-1234');
    expect(config.closeToTray).toBe(true);
  });

  it('keeps what is valid and defaults the rest', () => {
    const config = parseConfig(
      {
        mode: 'remote',
        remote: {
          url: 'hub.example/x',
          recent: ['https://a.example', 'bad url', 'https://a.example'],
        },
        port: 80,
        language: 'fr',
        window: { x: 10, y: 20, width: 100, height: 3000, maximized: true },
        deviceKey: 'short',
        closeToTray: false,
      },
      id,
    );
    expect(config.mode).toBe('remote');
    expect(config.remote).toEqual({ url: 'https://hub.example', recent: ['https://a.example'] });
    expect(config.port).toBeNull();
    expect(config.language).toBeNull();
    expect(config.window).toEqual({ x: 10, y: 20, width: 420, height: 3000, maximized: true });
    expect(config.deviceKey).toBe('device-key-1234');
    expect(config.closeToTray).toBe(false);
  });

  it('survives a file that is not an object', () => {
    expect(parseConfig('garbage', id)).toEqual(defaultConfig(id));
    expect(parseConfig(null, id)).toEqual(defaultConfig(id));
  });

  it('remembers hubs newest first, without repeats, up to the limit', () => {
    let config = defaultConfig(id);
    for (let i = 0; i < RECENT_LIMIT + 2; i += 1)
      config = withRemote(config, `https://h${i}.example`);
    config = withRemote(config, 'https://h3.example');
    expect(config.mode).toBe('remote');
    expect(config.remote.url).toBe('https://h3.example');
    expect(config.remote.recent[0]).toBe('https://h3.example');
    expect(config.remote.recent).toHaveLength(RECENT_LIMIT);
    expect(new Set(config.remote.recent).size).toBe(RECENT_LIMIT);
  });

  it('speaks Arabic to any Arabic locale', () => {
    expect(languageFromLocale('ar-SA')).toBe('ar');
    expect(languageFromLocale('ar')).toBe('ar');
    expect(languageFromLocale('en-GB')).toBe('en');
    expect(languageFromLocale(undefined)).toBe('en');
  });
});

describe('window placement', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };

  it('centres a first window on the primary display', () => {
    const placed = placeWindow(null, [primary], primary);
    expect(placed.positioned).toBe(false);
    expect(placed.width).toBe(DEFAULT_WINDOW.width);
    expect(placed.x).toBe((1920 - DEFAULT_WINDOW.width) / 2);
  });

  it('reopens where it was when that place is still on a screen', () => {
    const saved = { x: 100, y: 50, width: 1000, height: 700, maximized: true };
    expect(placeWindow(saved, [primary], primary)).toEqual({ ...saved, positioned: true });
  });

  it('comes back from a monitor that is gone', () => {
    const saved = { x: 2400, y: 100, width: 1000, height: 700, maximized: false };
    const placed = placeWindow(saved, [primary], primary);
    expect(placed.positioned).toBe(false);
    expect(placed.x).toBeLessThan(1920);
  });

  it('shrinks to fit a smaller screen', () => {
    const small = { x: 0, y: 0, width: 800, height: 600 };
    const saved = { x: null, y: null, width: 1600, height: 1000, maximized: false };
    const placed = placeWindow(saved, [small], small);
    expect(placed.width).toBe(800);
    expect(placed.height).toBe(600);
  });
});

describe('words', () => {
  it('fills placeholders and falls back to English, then to the key', () => {
    expect(translate('en', 'errors.hub_unreachable', { url: 'x' })).toContain('x');
    expect(translate('ar', 'errors.hub_unreachable', { url: 'x' })).toContain('x');
    expect(translate('ar', 'no.such.key')).toBe('no.such.key');
    expect(translate('ar', 'app.name')).toBe('كور هب');
  });

  it('writes Arabic right to left and isolates Latin values', () => {
    expect(direction('ar')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
    expect(isolate('https://hub.example')).toBe('⁨https://hub.example⁩');
  });
});
