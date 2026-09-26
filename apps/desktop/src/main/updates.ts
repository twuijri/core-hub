/**
 * The `notify` update check (DECISIONS §108, for the .deb and development runs; also the
 * fallback when the `install` updater cannot read its feed): the repository's GitHub releases,
 * read without a token. The result is a notice and a link — nothing is downloaded or installed.
 * Which way this copy updates: `appPackaging` here, `updateMode` in shared/updates.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PRODUCT } from '@corehub/contracts';
import {
  checksGitHub,
  packagingOf,
  pickUpdate,
  updateChannel,
  type GitHubRelease,
  type Packaging,
  type UpdateChannel,
  type UpdateFound,
} from '../shared/updates.js';

export const RELEASES_URL = `https://api.github.com/repos/${PRODUCT.repository}/releases?per_page=30`;
export const RELEASES_PAGE = `https://github.com/${PRODUCT.repository}/releases`;

export type UpdateCheck =
  | { status: 'available'; current: string; checkedAt: string; update: UpdateFound }
  | { status: 'up_to_date'; current: string; checkedAt: string }
  | { status: 'failed'; current: string; checkedAt: string; message: string };

/** Said instead of checking by a Microsoft Store build (the Store updates it). */
export const STORE_UPDATES_MESSAGE = 'Updates come from the Microsoft Store';

export async function checkForUpdate(options: {
  current: string;
  platform: NodeJS.Platform;
  arch: string;
  /** A Store build never asks GitHub (default `github`). */
  channel?: UpdateChannel;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<UpdateCheck> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const base = { current: options.current, checkedAt };
  if (!checksGitHub(options.channel ?? 'github'))
    return { ...base, status: 'failed', message: STORE_UPDATES_MESSAGE };
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${PRODUCT.id}-desktop/${options.current}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ...base, status: 'failed', message: `GitHub answered ${res.status}` };
    const releases = (await res.json()) as GitHubRelease[];
    if (!Array.isArray(releases))
      return { ...base, status: 'failed', message: 'GitHub answered something else' };
    const update = pickUpdate(releases, options.current, options.platform, options.arch);
    return update ? { ...base, status: 'available', update } : { ...base, status: 'up_to_date' };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * This app's update channel: the packaged package.json's `corehubChannel` (stamped `store` for
 * the MSIX), Electron's `process.windowsStore`, and COREHUB_CHANNEL (see updateChannel).
 */
export function appChannel(appPath: string, env: NodeJS.ProcessEnv = process.env): UpdateChannel {
  let metadata: unknown;
  try {
    const pkg = JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf8')) as {
      corehubChannel?: unknown;
    };
    metadata = pkg.corehubChannel;
  } catch {
    metadata = undefined;
  }
  const windowsStore = (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore;
  return updateChannel({ metadata, windowsStore, env: env.COREHUB_CHANNEL });
}

/**
 * How this copy was installed (see `packagingOf`): the channel, whether it is packaged, the
 * AppImage runtime's `APPIMAGE`, and `resources/package-type`, which electron-builder writes
 * into the .deb.
 */
export function appPackaging(input: {
  channel: UpdateChannel;
  packaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Packaging {
  let packageType: string | null = null;
  try {
    packageType = readFileSync(path.join(input.resourcesPath, 'package-type'), 'utf8').trim();
  } catch {
    packageType = null;
  }
  return packagingOf({
    platform: input.platform ?? process.platform,
    channel: input.channel,
    packaged: input.packaged,
    appImage: (input.env ?? process.env).APPIMAGE,
    packageType,
  });
}
