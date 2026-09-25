/**
 * The update check (ADR 0023): the repository's GitHub releases, read without a token, at most
 * once a day on its own and whenever the person asks. The result is a notice and a link to the
 * installer — nothing is downloaded or installed by the app.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PRODUCT } from '@corehub/contracts';
import {
  checksGitHub,
  pickUpdate,
  updateChannel,
  type GitHubRelease,
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
