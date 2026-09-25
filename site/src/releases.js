// @ts-check
// What the download page knows about releases, without touching the DOM (tests/releases.test.ts):
// which file of a GitHub release is which download, the visitor's system, and the store switches.
//
// The file names are the ones apps/desktop/scripts/release-assets.mjs gives the release
// (publish-release.yml). The test checks every pattern below against that script's names, so a
// rename there fails here before the page offers a missing file.

/**
 * @typedef {'windows-exe' | 'macos-dmg' | 'linux-appimage' | 'linux-deb' | 'android-apk'} AssetKey
 * @typedef {'windows' | 'macos' | 'linux' | 'android' | 'ios'} Platform
 * @typedef {{ name: string, url: string, size: number | null }} Download
 * @typedef {{
 *   version: string,
 *   tag: string,
 *   publishedAt: string | null,
 *   pageUrl: string,
 *   downloads: Partial<Record<AssetKey, Download>>,
 * }} Release
 * @typedef {{ name?: unknown, browser_download_url?: unknown, size?: unknown }} GitHubAsset
 */

/** A release version as it appears in a file name: X.Y.Z, optionally with a pre-release part. */
const V = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;

/**
 * One pattern per download. The MSIX (`Core-Hub-X.Y.Z-x64.msix`) is deliberately absent: Windows
 * installs it only once the Store has signed it, so the page offers the `.exe` and the Store.
 * @type {Record<AssetKey, RegExp>}
 */
export const ASSET_PATTERNS = {
  'windows-exe': new RegExp(`^Core-Hub-Setup-${V}-x64\\.exe$`),
  'macos-dmg': new RegExp(`^Core-Hub-${V}-arm64\\.dmg$`),
  'linux-appimage': new RegExp(`^Core-Hub-${V}-x86_64\\.AppImage$`),
  'linux-deb': new RegExp(`^corehub_${V}_amd64\\.deb$`),
  'android-apk': new RegExp(`^Core-Hub-${V}-android\\.apk$`),
};

/** @type {AssetKey[]} */
export const ASSET_KEYS = /** @type {AssetKey[]} */ (Object.keys(ASSET_PATTERNS));

/** Where every release lives; the fallback when the API cannot be read. */
export const releasesPage = (/** @type {string} */ repo) =>
  `https://github.com/${repo}/releases/latest`;

/**
 * Picks each download from a release's assets by name. Only a URL under this repository's
 * release downloads is accepted, so a surprising API answer never becomes a link.
 * @param {readonly GitHubAsset[]} assets
 * @param {string} repo
 * @returns {Partial<Record<AssetKey, Download>>}
 */
export function pickAssets(assets, repo) {
  const prefix = `https://github.com/${repo}/releases/download/`;
  /** @type {Partial<Record<AssetKey, Download>>} */
  const picked = {};
  for (const asset of assets) {
    const name = typeof asset.name === 'string' ? asset.name : '';
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (!name || !url.startsWith(prefix)) continue;
    for (const key of ASSET_KEYS) {
      if (picked[key] || !ASSET_PATTERNS[key].test(name)) continue;
      picked[key] = {
        name,
        url,
        size: typeof asset.size === 'number' && asset.size > 0 ? asset.size : null,
      };
    }
  }
  return picked;
}

/**
 * The page's view of `GET /repos/{repo}/releases/latest`, or null when the answer is not a
 * release (an error body, a rate-limit message, a draft).
 * @param {unknown} json
 * @param {string} repo
 * @returns {Release | null}
 */
export function readRelease(json, repo) {
  if (!json || typeof json !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (json);
  if (typeof r.tag_name !== 'string' || r.draft === true) return null;
  const pageUrl =
    typeof r.html_url === 'string' && r.html_url.startsWith(`https://github.com/${repo}/releases/`)
      ? r.html_url
      : releasesPage(repo);
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^v/, ''),
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    pageUrl,
    downloads: pickAssets(Array.isArray(r.assets) ? r.assets : [], repo),
  };
}

/**
 * @typedef {{
 *   userAgent?: string,
 *   platform?: string,
 *   maxTouchPoints?: number,
 *   userAgentData?: { platform?: string, mobile?: boolean } | null,
 * }} NavigatorLike
 */

/**
 * The visitor's system, from what the browser says about itself; null when unsure (ChromeOS,
 * a bot, an empty user agent). Android before Linux (its user agent says both), and an iPad that
 * asks for the desktop site says "Macintosh" but has a touch screen.
 * @param {NavigatorLike} nav
 * @returns {Platform | null}
 */
export function detectPlatform(nav) {
  const ua = nav.userAgent ?? '';
  const hint = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''}`.toLowerCase();
  if (/android/i.test(ua) || hint.includes('android')) return 'android';
  if (/iPhone|iPad|iPod/.test(ua) || /iphone|ipad|ipod/.test(hint)) return 'ios';
  if (/Macintosh|Mac OS X/.test(ua) || hint.includes('mac')) {
    return (nav.maxTouchPoints ?? 0) > 1 ? 'ios' : 'macos';
  }
  if (/Windows/.test(ua) || hint.includes('win')) return 'windows';
  if (/CrOS/.test(ua) || hint.includes('chrome os') || hint.includes('chromeos')) return null;
  if (/Linux|X11/.test(ua) || hint.includes('linux')) return 'linux';
  return null;
}

/**
 * A store button: a link only when switched on in config.js and given an https address.
 * @param {{ enabled: boolean, url: string }} flag
 * @returns {{ available: true, href: string } | { available: false }}
 */
export function storeLink(flag) {
  if (flag.enabled && /^https:\/\/\S+$/.test(flag.url)) return { available: true, href: flag.url };
  return { available: false };
}

/**
 * A file size for people: "142 MB", "980 KB". Latin digits in both languages, like every number
 * in the apps.
 * @param {number | null} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** How long a successful answer is reused (GitHub allows 60 unauthenticated calls an hour). */
export const CACHE_MS = 10 * 60 * 1000;
const CACHE_KEY = 'corehub.download.latest';

/**
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} StorageLike
 */

/**
 * The latest release, or null when it cannot be read (offline, rate-limited, no release yet).
 * A fresh cached answer is used instead of calling the API again.
 * @param {{
 *   repo: string,
 *   fetch: (url: string, init?: RequestInit) => Promise<Response>,
 *   storage?: StorageLike | null,
 *   now?: number,
 * }} options
 * @returns {Promise<Release | null>}
 */
export async function loadLatest({ repo, fetch, storage = null, now = Date.now() }) {
  try {
    const cached = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    if (cached && cached.repo === repo && now - cached.at < CACHE_MS) {
      const release = readRelease(cached.json, repo);
      if (release) return release;
    }
  } catch {
    // A broken or blocked cache is only a missed shortcut.
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const json = await response.json();
    const release = readRelease(json, repo);
    if (release) {
      // Only what readRelease reads, not the notes and uploader details.
      const slim = {
        tag_name: release.tag,
        html_url: release.pageUrl,
        published_at: release.publishedAt,
        assets: Object.values(release.downloads).map((d) => ({
          name: d.name,
          browser_download_url: d.url,
          size: d.size,
        })),
      };
      try {
        storage?.setItem(CACHE_KEY, JSON.stringify({ repo, at: now, json: slim }));
      } catch {
        // Storage full or blocked: the page works without it.
      }
    }
    return release;
  } catch {
    return null;
  }
}
