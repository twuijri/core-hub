// The update check: which release is newer, which installer fits, and what GitHub said.
import { describe, expect, it } from 'vitest';
import { checkForUpdate, RELEASES_URL } from '../../src/main/updates.js';
import {
  assetFor,
  checkIsDue,
  compareVersions,
  pickUpdate,
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

  it('checks on its own at most once a day', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(checkIsDue(null, now)).toBe(true);
    expect(checkIsDue('2026-09-25T01:00:00Z', now)).toBe(false);
    expect(checkIsDue('2026-09-24T11:00:00Z', now)).toBe(true);
    expect(checkIsDue('garbage', now)).toBe(true);
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
