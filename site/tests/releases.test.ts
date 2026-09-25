// The download page's release logic: which file is which download (checked against the names the
// release workflow gives them), the visitor's system, the store switches and the API fallback.
import { describe, expect, it, vi } from 'vitest';
import { releaseAssets } from '../../apps/desktop/scripts/release-assets.mjs';
import { STORES } from '../src/config.js';
import {
  ASSET_KEYS,
  ASSET_PATTERNS,
  CACHE_MS,
  detectPlatform,
  formatSize,
  loadLatest,
  pickAssets,
  readRelease,
  releasesPage,
  storeLink,
} from '../src/releases.js';
import realRelease from './fixtures/release-v1.1.1.json' with { type: 'json' };

const REPO = 'twuijri/core-hub';
const download = (tag: string, name: string) =>
  `https://github.com/${REPO}/releases/download/${tag}/${name}`;

/** A release as the API returns it, with release-assets.mjs's file names for `version`. */
function apiRelease(version: string) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
    published_at: '2026-09-26T01:02:03Z',
    draft: false,
    assets: releaseAssets(version).map((a, i) => ({
      name: a.name,
      browser_download_url: download(`v${version}`, a.name),
      size: 1000000 * (i + 1),
    })),
  };
}

describe('file names (apps/desktop/scripts/release-assets.mjs is the source)', () => {
  it.each(['1.1.1', '1.2.0', '10.20.30'])(
    'each download matches exactly its own file in %s',
    (v) => {
      const assets = releaseAssets(v);
      for (const key of ASSET_KEYS) {
        const matches = assets.filter((a) => ASSET_PATTERNS[key].test(a.name));
        expect(
          matches.map((a) => a.key),
          key,
        ).toEqual([key]);
      }
    },
  );

  it('offers every release file but the MSIX, which Windows installs only from the Store', () => {
    const offered = releaseAssets('1.1.1')
      .map((a) => a.key)
      .filter((key) => key !== 'windows-msix');
    expect([...ASSET_KEYS].sort()).toEqual([...offered].sort());
    const msix = releaseAssets('1.1.1').find((a) => a.key === 'windows-msix')!;
    expect(ASSET_KEYS.some((key) => ASSET_PATTERNS[key].test(msix.name))).toBe(false);
  });

  it('picks every download from the real v1.1.1 release (GET /releases/latest, 2026-09-26)', () => {
    const release = readRelease(realRelease, REPO)!;
    expect(release).not.toBeNull();
    expect(Object.keys(release.downloads).sort()).toEqual([...ASSET_KEYS].sort());
    for (const expected of releaseAssets(release.version)) {
      if (expected.key === 'windows-msix') continue;
      const got = release.downloads[expected.key as keyof typeof release.downloads]!;
      expect(got.name).toBe(expected.name);
      expect(got.url).toBe(download(release.tag, expected.name));
      expect(got.size).toBeGreaterThan(1024 * 1024);
    }
  });
});

describe('reading a release', () => {
  it('turns the API answer into the page’s downloads, sizes and links', () => {
    const release = readRelease(apiRelease('1.1.1'), REPO)!;
    expect(release).toMatchObject({
      tag: 'v1.1.1',
      version: '1.1.1',
      publishedAt: '2026-09-26T01:02:03Z',
      pageUrl: `https://github.com/${REPO}/releases/tag/v1.1.1`,
    });
    expect(release.downloads['windows-exe']).toEqual({
      name: 'Core-Hub-Setup-1.1.1-x64.exe',
      url: download('v1.1.1', 'Core-Hub-Setup-1.1.1-x64.exe'),
      size: 1000000,
    });
    expect(release.downloads['linux-deb']?.name).toBe('corehub_1.1.1_amd64.deb');
  });

  it('never links a file outside this repository’s release downloads', () => {
    const picked = pickAssets(
      [
        { name: 'Core-Hub-1.1.1-arm64.dmg', browser_download_url: 'https://evil.example/x.dmg' },
        {
          name: 'Core-Hub-Setup-1.1.1-x64.exe',
          browser_download_url: `https://github.com/someone/else/releases/download/v1.1.1/x.exe`,
        },
        { name: 'Core-Hub-1.1.1-android.apk', browser_download_url: 42 },
      ],
      REPO,
    );
    expect(picked).toEqual({});
  });

  it('leaves out a file the release does not have, so the page points at the release instead', () => {
    const json = apiRelease('1.1.1');
    json.assets = json.assets.filter((a) => !a.name.endsWith('.apk'));
    const release = readRelease(json, REPO)!;
    expect(release.downloads['android-apk']).toBeUndefined();
    expect(release.downloads['windows-exe']).toBeDefined();
  });

  it('is not a release when GitHub answers with an error, a draft or nothing', () => {
    expect(readRelease({ message: 'API rate limit exceeded for 1.2.3.4.' }, REPO)).toBeNull();
    expect(readRelease({ message: 'Not Found', status: '404' }, REPO)).toBeNull();
    expect(readRelease({ ...apiRelease('1.1.1'), draft: true }, REPO)).toBeNull();
    expect(readRelease(null, REPO)).toBeNull();
    expect(readRelease('oops', REPO)).toBeNull();
  });

  it('falls back to the releases page when the answer has no usable page link', () => {
    const release = readRelease({ ...apiRelease('1.1.1'), html_url: 'https://x.example' }, REPO)!;
    expect(release.pageUrl).toBe(releasesPage(REPO));
    expect(releasesPage(REPO)).toBe('https://github.com/twuijri/core-hub/releases/latest');
  });
});

describe('loading the latest release', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };
  const ok = (json: unknown) =>
    Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));

  it('asks the GitHub API for the latest release', async () => {
    const fetch = vi.fn(() => ok(apiRelease('1.1.1')));
    const release = await loadLatest({ repo: REPO, fetch });
    expect(release?.version).toBe('1.1.1');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/twuijri/core-hub/releases/latest',
      expect.anything(),
    );
  });

  it('gives null when rate-limited, not found or offline', async () => {
    const limited = () =>
      Promise.resolve(new Response('{"message":"API rate limit exceeded"}', { status: 403 }));
    expect(await loadLatest({ repo: REPO, fetch: limited })).toBeNull();
    const missing = () => Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
    expect(await loadLatest({ repo: REPO, fetch: missing })).toBeNull();
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await loadLatest({ repo: REPO, fetch: offline })).toBeNull();
    const garbage = () => Promise.resolve(new Response('<html>', { status: 200 }));
    expect(await loadLatest({ repo: REPO, fetch: garbage })).toBeNull();
  });

  it('reuses a fresh answer instead of calling again, and asks again once it is old', async () => {
    const storage = memory();
    const fetch = vi.fn(() => ok(apiRelease('1.1.1')));
    const first = await loadLatest({ repo: REPO, fetch, storage, now: 1000 });
    const again = await loadLatest({ repo: REPO, fetch, storage, now: 1000 + CACHE_MS - 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
    await loadLatest({ repo: REPO, fetch, storage, now: 1000 + CACHE_MS });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('works when storage throws', async () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const release = await loadLatest({ repo: REPO, fetch: () => ok(apiRelease('1.1.1')), storage });
    expect(release?.version).toBe('1.1.1');
  });
});

describe('the visitor’s system', () => {
  it.each([
    [
      'windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      {},
    ],
    [
      'macos',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
      { maxTouchPoints: 0 },
    ],
    [
      'ios',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
      { maxTouchPoints: 5 },
    ],
    [
      'ios',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      {},
    ],
    [
      'android',
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
      {},
    ],
    [
      'linux',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      {},
    ],
    ['linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', {}],
    [
      null,
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      {},
    ],
    [null, '', {}],
  ] as const)('%s ← %s', (expected, userAgent, extra) => {
    expect(detectPlatform({ userAgent, ...extra })).toBe(expected);
  });

  it('trusts the client hint when the user agent is reduced', () => {
    const reduced = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
    expect(
      detectPlatform({ userAgent: reduced, userAgentData: { platform: 'Android', mobile: true } }),
    ).toBe('android');
    expect(detectPlatform({ userAgent: '', userAgentData: { platform: 'Windows' } })).toBe(
      'windows',
    );
    expect(detectPlatform({ userAgent: '', userAgentData: { platform: 'macOS' } })).toBe('macos');
  });
});

describe('store buttons', () => {
  it('are links only when switched on with an https address', () => {
    const url = 'https://apps.microsoft.com/detail/9MT62R5V3P5N';
    expect(storeLink({ enabled: true, url })).toEqual({ available: true, href: url });
    expect(storeLink({ enabled: false, url })).toEqual({ available: false });
    expect(storeLink({ enabled: true, url: '' })).toEqual({ available: false });
    expect(storeLink({ enabled: true, url: 'javascript:alert(1)' })).toEqual({ available: false });
    expect(storeLink({ enabled: true, url: 'http://apps.microsoft.com/x' })).toEqual({
      available: false,
    });
  });

  it('config.js: each store turns on with its flag alone, the App Store once it has a link', () => {
    expect(STORES.microsoftStore.url).toBe('https://apps.microsoft.com/detail/9MT62R5V3P5N');
    expect(storeLink({ ...STORES.microsoftStore, enabled: true }).available).toBe(true);
    expect(storeLink({ ...STORES.googlePlay, enabled: true }).available).toBe(true);
    expect(storeLink({ ...STORES.appStore, enabled: true }).available).toBe(
      STORES.appStore.url !== '',
    );
    for (const flag of Object.values(STORES))
      expect(storeLink({ ...flag, enabled: false }).available).toBe(false);
  });
});

describe('sizes', () => {
  it.each([
    [148_000_000, '141 MB'],
    [52_428_800, '50 MB'],
    [15_990_000, '15.2 MB'],
    [900_000, '879 KB'],
    [null, ''],
    [0, ''],
  ] as const)('%s → %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});
