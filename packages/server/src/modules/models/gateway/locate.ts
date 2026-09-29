/**
 * Where this hub's CLIProxyAPI is (ADR 0029). The hub never runs one it found on `PATH`: only the
 * copy that ships with it, checked against its pinned SHA-256 when it was put there.
 *
 * 1. `COREHUB_CLIPROXY_BIN` — the desktop app points its embedded hub at the copy in its
 *    installer's resources;
 * 2. `/opt/corehub/bin/cli-proxy-api` — the container image;
 * 3. `~/.cache/corehub/cliproxy/<version>/<platform>/` — a developer's copy, put there by
 *    `pnpm cliproxy:fetch` (`scripts/cliproxy/fetch.mjs`).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** The pinned release; `scripts/cliproxy/pin.json` names the same (a unit test checks). */
export const CLIPROXY_VERSION = '8.0.4';

export const IMAGE_CLIPROXY_PATH = '/opt/corehub/bin/cli-proxy-api';

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function devCliproxyPath(
  home: string = homedir(),
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const name = platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
  return path.join(home, '.cache', 'corehub', 'cliproxy', CLIPROXY_VERSION, `${platform}-${arch}`, name);
}

/** The executable to run, or null when this hub has none. */
export function locateCliproxy(options: { configured: string | null; home?: string }): string | null {
  const candidates = [
    options.configured,
    IMAGE_CLIPROXY_PATH,
    devCliproxyPath(options.home ?? homedir()),
  ].filter((candidate): candidate is string => !!candidate);
  // A configured path that is missing is not replaced by another: the operator meant that one.
  if (options.configured) return executable(options.configured) ? options.configured : null;
  return candidates.find(executable) ?? null;
}
