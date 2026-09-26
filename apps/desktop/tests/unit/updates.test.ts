// The update check: which release is newer, which installer fits, and what GitHub said.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appChannel,
  appPackaging,
  checkForUpdate,
  RELEASES_URL,
  STORE_UPDATES_MESSAGE,
} from '../../src/main/updates.js';
import {
  AUTO_CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  assetFor,
  checksGitHub,
  compareVersions,
  packagingOf,
  pickUpdate,
  scheduleUpdateChecks,
  STORE_PAGE,
  updateChannel,
  updateMode,
  type GitHubRelease,
} from '../../src/shared/updates.js';

const assets = (version: string) =>
  [
    `Core-Hub-${version}-x86_64.AppImage`,
    `corehub_${version}_amd64.deb`,
    `Core-Hub-${version}-arm64.AppImage`,
    `Core-Hub-${version}-arm64.dmg`,
    `Core-Hub-${version}-x64.dmg`,
    `Core-Hub-Setup-${version}-x64.exe`,
    'core-hub-image.tar',
  ].map((name) => ({
    name,
    browser_download_url: `https://dl.example/${name}`,
    size: 100_000_000,
  }));

const release = (tag: string, over: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/twuijri/core-hub/releases/tag/${tag}`,
  draft: false,
  prerelease: tag.includes('-'),
  assets: assets(tag.replace(/^v/, '')),
  ...over,
});

describe('versions', () => {
  it('orders releases the semantic-version way', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0-alpha.16')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-alpha.16', '0.1.0-alpha.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-alpha.16', '0.1.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });
});

describe('what each copy does about a new version (DECISIONS §108)', () => {
  const base = { channel: 'github' as const, packaged: true };

  it.each([
    // platform, channel, packaged, APPIMAGE, package-type → packaging → mode
    ['win32', 'github', true, undefined, null, 'nsis', 'install'],
    ['win32', 'store', true, undefined, null, 'msix', 'off'],
    ['darwin', 'github', true, undefined, null, 'dmg', 'install'],
    ['linux', 'github', true, '/home/a/Core-Hub.AppImage', null, 'appimage', 'install'],
    // The AppImage may carry the .deb's package-type file; APPIMAGE decides.
    ['linux', 'github', true, '/home/a/Core-Hub.AppImage', 'deb', 'appimage', 'install'],
    ['linux', 'github', true, undefined, 'deb', 'deb', 'notify'],
    ['linux', 'github', true, '', 'deb', 'deb', 'notify'],
    ['linux', 'github', true, undefined, null, 'unpacked', 'notify'],
    ['win32', 'github', false, undefined, null, 'development', 'notify'],
    ['darwin', 'github', false, undefined, null, 'development', 'notify'],
    ['linux', 'github', false, '/x.AppImage', null, 'development', 'notify'],
    // The Store build never looks, even in a development run that asks to behave like it.
    ['win32', 'store', false, undefined, null, 'msix', 'off'],
    ['freebsd', 'github', true, undefined, null, 'unpacked', 'notify'],
  ] as const)(
    '%s, %s channel, packaged %s, APPIMAGE %s, package-type %s → %s → %s',
    (platform, channel, packaged, appImage, packageType, packaging, mode) => {
      const got = packagingOf({ platform, channel, packaged, appImage, packageType });
      expect(got).toBe(packaging);
      expect(updateMode(got)).toBe(mode);
    },
  );

  it('reads the .deb marker electron-builder leaves in resources/', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-packaging-'));
    try {
      const at = (env: NodeJS.ProcessEnv) =>
        appPackaging({ ...base, resourcesPath: dir, platform: 'linux', env });
      expect(at({})).toBe('unpacked');
      writeFileSync(path.join(dir, 'package-type'), 'deb\n');
      expect(at({})).toBe('deb');
      expect(at({ APPIMAGE: '/tmp/Core-Hub-1.1.3-x86_64.AppImage' })).toBe('appimage');
      expect(
        appPackaging({ ...base, channel: 'store', resourcesPath: dir, platform: 'win32', env: {} }),
      ).toBe('msix');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('when the app looks on its own', () => {
  it('about ten seconds after start, then every six hours, until stopped', () => {
    vi.useFakeTimers();
    try {
      expect(FIRST_CHECK_DELAY_MS).toBe(10_000);
      expect(AUTO_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
      const run = vi.fn();
      const stop = scheduleUpdateChecks(run);
      vi.advanceTimersByTime(9_999);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(AUTO_CHECK_INTERVAL_MS - 1);
      expect(run).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(2 * AUTO_CHECK_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(4);
      stop();
      vi.advanceTimersByTime(10 * AUTO_CHECK_INTERVAL_MS);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts when stopped before the first look', () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      scheduleUpdateChecks(run)();
      vi.advanceTimersByTime(AUTO_CHECK_INTERVAL_MS * 2);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the installer for this computer', () => {
  const list = assets('1.0.0');
  it.each([
    ['linux', 'x64', 'Core-Hub-1.0.0-x86_64.AppImage'],
    ['linux', 'arm64', 'Core-Hub-1.0.0-arm64.AppImage'],
    ['darwin', 'arm64', 'Core-Hub-1.0.0-arm64.dmg'],
    ['darwin', 'x64', 'Core-Hub-1.0.0-x64.dmg'],
    ['win32', 'x64', 'Core-Hub-Setup-1.0.0-x64.exe'],
  ] as const)('%s %s → %s', (platform, arch, name) => {
    expect(assetFor(list, platform, arch)?.name).toBe(name);
  });

  it('falls back to the .deb on Linux, and finds nothing for a platform with no build', () => {
    expect(
      assetFor(
        list.filter((a) => !a.name.endsWith('AppImage')),
        'linux',
        'x64',
      )?.name,
    ).toBe('corehub_1.0.0_amd64.deb');
    expect(assetFor(list, 'win32', 'arm64')).toBeNull();
    expect(assetFor(list, 'freebsd', 'x64')).toBeNull();
  });
});

describe('picking the update', () => {
  it('offers the newest published release with an installer for this computer', () => {
    const update = pickUpdate(
      [release('v1.2.0', { draft: true }), release('v1.1.0'), release('v1.0.5'), release('v0.9.0')],
      '1.0.0',
      'linux',
      'x64',
    );
    expect(update).toEqual({
      version: '1.1.0',
      download: 'https://dl.example/Core-Hub-1.1.0-x86_64.AppImage',
      size: 100_000_000,
      page: 'https://github.com/twuijri/core-hub/releases/tag/v1.1.0',
    });
  });

  it('skips a release that has no desktop build (a server-only tag)', () => {
    expect(pickUpdate([release('v1.1.0', { assets: [] })], '1.0.0', 'linux', 'x64')).toBeNull();
  });

  it('offers pre-releases only to an app that is itself a pre-release', () => {
    const releases = [release('v0.1.0-alpha.17'), release('v0.1.0-alpha.16')];
    expect(pickUpdate(releases, '0.0.9', 'linux', 'x64')).toBeNull();
    expect(pickUpdate(releases, '0.1.0-alpha.16', 'linux', 'x64')?.version).toBe('0.1.0-alpha.17');
    expect(pickUpdate(releases, '0.1.0-alpha.17', 'linux', 'x64')).toBeNull();
  });
});

describe('asking GitHub', () => {
  it('reads the releases once, without a token, and says what it found', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify([release('v2.0.0')]));
    }) as unknown as typeof fetch;
    const result = await checkForUpdate({
      current: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      now: () => new Date('2026-09-25T00:00:00Z'),
    });
    expect(result).toMatchObject({
      status: 'available',
      current: '1.0.0',
      checkedAt: '2026-09-25T00:00:00.000Z',
      update: { version: '2.0.0', download: 'https://dl.example/Core-Hub-2.0.0-arm64.dmg' },
    });
    expect(seen[0]?.url).toBe(RELEASES_URL);
    expect(RELEASES_URL).toBe('https://api.github.com/repos/twuijri/core-hub/releases?per_page=30');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers['user-agent']).toBe('corehub-desktop/1.0.0');
  });

  it('says up to date, or why it could not tell', async () => {
    const empty = (async () => new Response('[]')) as unknown as typeof fetch;
    expect(
      (await checkForUpdate({ current: '1.0.0', platform: 'linux', arch: 'x64', fetchImpl: empty }))
        .status,
    ).toBe('up_to_date');
    const limited = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    expect(
      await checkForUpdate({
        current: '1.0.0',
        platform: 'linux',
        arch: 'x64',
        fetchImpl: limited,
      }),
    ).toMatchObject({ status: 'failed', message: 'GitHub answered 403' });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(
      await checkForUpdate({
        current: '1.0.0',
        platform: 'linux',
        arch: 'x64',
        fetchImpl: offline,
      }),
    ).toMatchObject({ status: 'failed', message: 'fetch failed' });
  });
});

describe('the Microsoft Store build', () => {
  it('is the store channel when packaging stamped it, inside any MSIX, or when asked', () => {
    expect(updateChannel({})).toBe('github');
    expect(updateChannel({ metadata: 'store' })).toBe('store');
    expect(updateChannel({ metadata: 'github', windowsStore: true })).toBe('store');
    expect(updateChannel({ env: 'Store' })).toBe('store');
    expect(updateChannel({ metadata: 'something', windowsStore: false, env: '' })).toBe('github');
    expect(checksGitHub('github')).toBe(true);
    expect(checksGitHub('store')).toBe(false);
    expect(STORE_PAGE).toBe('https://apps.microsoft.com/detail/9MT62R5V3P5N');
  });

  it('reads the stamp from the packaged package.json', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-channel-'));
    try {
      expect(appChannel(dir, {})).toBe('github');
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.1.0' }));
      expect(appChannel(dir, {})).toBe('github');
      expect(appChannel(dir, { COREHUB_CHANNEL: 'store' })).toBe('store');
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ version: '1.1.0', corehubChannel: 'store' }),
      );
      expect(appChannel(dir, {})).toBe('store');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never asks GitHub: the Store updates it', async () => {
    let asked = 0;
    const fetchImpl = (async () => {
      asked += 1;
      return new Response(JSON.stringify([release('v9.0.0')]));
    }) as unknown as typeof fetch;
    const result = await checkForUpdate({
      current: '1.1.0',
      platform: 'win32',
      arch: 'x64',
      channel: 'store',
      fetchImpl,
    });
    expect(asked).toBe(0);
    expect(result).toMatchObject({ status: 'failed', message: STORE_UPDATES_MESSAGE });
    expect(STORE_UPDATES_MESSAGE).toBe('Updates come from the Microsoft Store');
  });
});
