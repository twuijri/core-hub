/**
 * "Is there a newer Core Hub for this computer?", and what the app does about it.
 *
 * Two ways, by how this copy was installed (`updateMode`, DECISIONS §108):
 * - `install` — the Windows .exe (NSIS), the macOS dmg and the Linux AppImage: electron-updater
 *   reads the release's `latest*.yml`, downloads the new version in the background and asks the
 *   person to restart (src/main/auto-update.ts). It installs on quit too, never by restarting on
 *   its own.
 * - `notify` — the Linux .deb (and a development run): the GitHub releases API below says a
 *   newer version is out, and the app links the download page. Nothing is downloaded.
 * - `off` — the Microsoft Store build: the Store updates it; the app never asks GitHub.
 *
 * For `notify`, a release counts when it is published (not a draft), is newer than this app, and
 * carries an installer for this platform and architecture. Pre-releases (the `test` channel)
 * are offered only to an app that is itself a pre-release.
 */

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string | null;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets?: GitHubAsset[];
}

export interface UpdateFound {
  version: string;
  /** The installer for this computer. */
  download: string;
  size: number | null;
  /** The release page (notes). */
  page: string;
}

interface Version {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semantic-version order: negative when a < b. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The installer in a release that fits this computer, by the names the packaging gives them. */
export function assetFor(
  assets: readonly GitHubAsset[],
  platform: NodeJS.Platform,
  arch: string,
): GitHubAsset | null {
  const lower = (a: GitHubAsset) => a.name.toLowerCase();
  const armish = arch === 'arm64';
  const archWords = armish ? ['arm64', 'aarch64'] : ['x64', 'x86_64', 'amd64'];
  const fits = (a: GitHubAsset) => archWords.some((w) => lower(a).includes(w));
  const pick = (ext: string) => assets.find((a) => lower(a).endsWith(ext) && fits(a)) ?? null;
  if (platform === 'darwin') return pick('.dmg');
  if (platform === 'win32') return pick('.exe');
  if (platform === 'linux') return pick('.appimage') ?? pick('.deb');
  return null;
}

export function pickUpdate(
  releases: readonly GitHubRelease[],
  current: string,
  platform: NodeJS.Platform,
  arch: string,
): UpdateFound | null {
  const wantsPre = (parseVersion(current)?.pre.length ?? 0) > 0;
  let best: UpdateFound | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (release.prerelease && !wantsPre) continue;
    const version = release.tag_name.replace(/^v/, '');
    if (!parseVersion(version) || compareVersions(version, current) <= 0) continue;
    const asset = assetFor(release.assets ?? [], platform, arch);
    if (!asset) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = {
      version,
      download: asset.browser_download_url,
      size: typeof asset.size === 'number' ? asset.size : null,
      page: release.html_url,
    };
  }
  return best;
}

/** The first look, a little after start so it never slows the launch. */
export const FIRST_CHECK_DELAY_MS = 10_000;
/** Then every six hours while the app runs (a person can always ask now). */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ScheduleTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: ScheduleTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * The automatic checks: `run` about ten seconds after start, then every six hours. `run` itself
 * reads the person's switch each time, so turning it off stops the next look without a restart.
 * Returns the function that stops the schedule.
 */
export function scheduleUpdateChecks(
  run: () => void,
  timers: ScheduleTimers = realTimers,
): () => void {
  let interval: unknown = null;
  const first = timers.setTimeout(() => {
    run();
    interval = timers.setInterval(run, AUTO_CHECK_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);
  return () => {
    timers.clearTimeout(first);
    if (interval !== null) timers.clearInterval(interval);
  };
}

/**
 * How this copy of the app was installed:
 * - `nsis` — the Windows .exe from a GitHub release;
 * - `msix` — the Microsoft Store package (the `store` channel);
 * - `dmg` — the macOS app (from the signed dmg);
 * - `appimage` — the Linux AppImage (Electron's AppImage runtime sets `APPIMAGE`);
 * - `deb` — the Linux .deb (electron-builder writes `resources/package-type`);
 * - `unpacked` — a packaged app run from its folder (`linux-unpacked`, the smoke tests);
 * - `development` — `electron .` from the repository.
 */
export type Packaging = 'nsis' | 'msix' | 'dmg' | 'appimage' | 'deb' | 'unpacked' | 'development';

export function packagingOf(input: {
  platform: NodeJS.Platform;
  channel: UpdateChannel;
  packaged: boolean;
  /** `process.env.APPIMAGE`, set only inside a running AppImage. */
  appImage?: string | undefined;
  /** The contents of `resources/package-type`, or null. */
  packageType?: string | null | undefined;
}): Packaging {
  if (input.channel === 'store') return 'msix';
  if (!input.packaged) return 'development';
  if (input.platform === 'win32') return 'nsis';
  if (input.platform === 'darwin') return 'dmg';
  if (input.platform === 'linux') {
    // The AppImage is built from the same folder as the .deb, so it may carry the .deb's
    // `package-type` file; only a running AppImage has APPIMAGE.
    if (input.appImage && input.appImage.trim() !== '') return 'appimage';
    if (input.packageType?.trim() === 'deb') return 'deb';
  }
  return 'unpacked';
}

/**
 * What the app does about a new version:
 * - `install`: electron-updater downloads it in the background and asks to restart;
 * - `notify`: says a new version is out and links the download page;
 * - `off`: never looks (the Store updates the MSIX).
 */
export type UpdateMode = 'install' | 'notify' | 'off';

export function updateMode(packaging: Packaging): UpdateMode {
  switch (packaging) {
    case 'msix':
      return 'off';
    case 'nsis':
    case 'dmg':
    case 'appimage':
      return 'install';
    default:
      return 'notify';
  }
}

/** The download page (site/, GitHub Pages): where a .deb user gets the new version. */
export const DOWNLOAD_PAGE = 'https://twuijri.github.io/core-hub/';

/** A release's own page, for "What's new". */
export const releasePage = (repository: string, version: string) =>
  `https://github.com/${repository}/releases/tag/v${version}`;

/**
 * Where this copy of the app gets its updates. `github`: the releases above (the .exe, dmg,
 * AppImage and deb installers). `store`: the Microsoft Store (the MSIX build) — the Store
 * updates it, and the app must never look for or point at another installer.
 */
export type UpdateChannel = 'github' | 'store';

/** The Core Hub product in the Microsoft Store (public; docs/RELEASING.md). */
export const STORE_PRODUCT_ID = '9MT62R5V3P5N';
export const STORE_PAGE = `https://apps.microsoft.com/detail/${STORE_PRODUCT_ID}`;

/**
 * The channel, from what the build says and where the app runs:
 * - `metadata`: `corehubChannel` in the packaged app's package.json, which packaging stamps as
 *   `store` for the MSIX (COREHUB_CHANNEL=store, scripts/package.mjs) — the build-time flag;
 * - `windowsStore`: Electron's `process.windowsStore`, true inside any MSIX/APPX package — so a
 *   Store install never checks GitHub even if the stamp were missing;
 * - `env`: COREHUB_CHANNEL at run time, for trying the Store behaviour in a development run.
 */
export function updateChannel(input: {
  metadata?: unknown;
  windowsStore?: boolean | undefined;
  env?: string | undefined;
}): UpdateChannel {
  if (input.windowsStore === true) return 'store';
  if (input.metadata === 'store') return 'store';
  if (input.env?.trim().toLowerCase() === 'store') return 'store';
  return 'github';
}

/** Whether the app looks for a new release on its own (and may be asked to). */
export function checksGitHub(channel: UpdateChannel): boolean {
  return channel === 'github';
}
