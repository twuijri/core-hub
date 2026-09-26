/**
 * The `install` way of updating (DECISIONS §108): electron-updater against the repository's
 * GitHub releases. It reads the release's `latest.yml` (Windows .exe), `latest-mac.yml` (the
 * signed zip beside the dmg) or `latest-linux.yml` (the AppImage) — from github.com, without a
 * token — downloads a newer version in the background, checks its SHA-512, and says so. The
 * person restarts when they choose (`restart`), or it is installed when the app quits. Nothing
 * restarts the app on its own.
 *
 * Only the Windows .exe, the macOS app and the AppImage get here (`updateMode` in
 * shared/updates.ts); the Store build and the .deb never load an updater.
 */
import { PRODUCT } from '@corehub/contracts';
import { AppImageUpdater, MacUpdater, NsisUpdater, type AppUpdater } from 'electron-updater';

export interface PendingUpdate {
  version: string;
  /** Downloading in the background, or downloaded and waiting for a restart. */
  status: 'downloading' | 'ready';
  /** 0–100 while downloading, when the updater says. */
  percent: number | null;
}

export type InstallCheck =
  | { status: 'available'; version: string }
  | { status: 'up_to_date' }
  | { status: 'failed'; message: string };

/** electron-updater's GitHub provider options (builder-util-runtime's `GithubOptions`). */
export interface FeedOptions {
  provider: 'github';
  owner: string;
  repo: string;
  releaseType: 'release';
}

/** Where the updater reads releases: stable releases of this repository, never pre-releases. */
export function feedOptions(repository: string = PRODUCT.repository): FeedOptions {
  const [owner, repo] = repository.split('/') as [string, string];
  return { provider: 'github', owner, repo, releaseType: 'release' };
}

export class AutoInstaller {
  private readonly updater: AppUpdater;
  private pending: PendingUpdate | null = null;

  constructor(
    platform: NodeJS.Platform,
    private readonly onChange: (pending: PendingUpdate | null) => void,
  ) {
    const options = feedOptions();
    this.updater =
      platform === 'win32'
        ? new NsisUpdater(options)
        : platform === 'darwin'
          ? new MacUpdater(options)
          : new AppImageUpdater(options);
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.updater.on('update-available', (info: { version: string }) =>
      this.set({ version: info.version, status: 'downloading', percent: null }),
    );
    this.updater.on('download-progress', (progress: { percent?: number }) => {
      if (!this.pending || this.pending.status !== 'downloading') return;
      const percent =
        typeof progress.percent === 'number' && Number.isFinite(progress.percent)
          ? Math.max(0, Math.min(100, Math.round(progress.percent)))
          : null;
      if (percent !== this.pending.percent) this.set({ ...this.pending, percent });
    });
    this.updater.on('update-downloaded', (info: { version: string }) =>
      this.set({ version: info.version, status: 'ready', percent: 100 }),
    );
    // A download that failed is tried again at the next check; what was ready stays ready.
    this.updater.on('error', () => {
      if (this.pending?.status === 'downloading') this.set(null);
    });
  }

  get state(): PendingUpdate | null {
    return this.pending;
  }

  /** Asks the release feed; a newer version starts downloading at once. */
  async check(): Promise<InstallCheck> {
    try {
      const result = await this.updater.checkForUpdates();
      if (!result) return { status: 'failed', message: 'the updater is off in this build' };
      // The download reports through the events above; its failure must not go unhandled.
      result.downloadPromise?.catch(() => {});
      return result.isUpdateAvailable
        ? { status: 'available', version: result.updateInfo.version }
        : { status: 'up_to_date' };
    } catch (error) {
      // electron-updater's messages can carry a stack and the whole feed; the first line says it.
      const text = error instanceof Error ? error.message : String(error);
      return { status: 'failed', message: (text.split('\n')[0] ?? '').slice(0, 200) };
    }
  }

  /**
   * The person pressed "Restart to update": install the downloaded version and start it again.
   * Silent on Windows (the installer keeps the folder the person chose the first time).
   */
  restart(): boolean {
    if (this.pending?.status !== 'ready') return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }

  private set(next: PendingUpdate | null): void {
    this.pending = next;
    this.onChange(next);
  }
}
