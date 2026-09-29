/**
 * What a coding agent the hub starts is given of the hub's own environment (DECISIONS §139).
 *
 * Until 2026-09-30 an ACP agent inherited the hub's whole environment: whatever the hub was
 * started with — the database URL, the first-owner password, push keys, any secret an operator
 * put in the container — reached every third-party CLI and every package script it ran. Now a
 * child gets an **allow-list**: a small base every program needs (where it lives, who it runs
 * as, its language, its temporary folder, the proxy and certificate settings of the network it
 * is on), plus the variables its own catalog entry names — the keys it reads (`credentials`)
 * and the settings it documents (`hostEnv`, e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GOOSE_*`).
 * The hub's own variables are never passed, whatever a pattern says (`NEVER_PASSED`).
 *
 * What the hub itself hands the agent — the profile's shared provider keys, the agent's own
 * settings `env` — is added on top by the caller and is not filtered: that is the hub's decision,
 * not something inherited by accident.
 *
 * A name is exact (`HOME`) or a prefix ending in `*` (`LC_*`). On Windows variable names are
 * case-insensitive, and are matched so (`Path`, `SystemRoot`).
 */
import type { CatalogEntry } from '../catalog/types.js';

/** What every program is given, whatever it is. */
export const BASE_HOST_ENV: readonly string[] = [
  // Where things are, and who runs them.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'XDG_*',
  // Language, time and terminal.
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TZ',
  'TERM',
  'COLORTERM',
  // The network the host is on: its proxy and the certificates it trusts.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // npm's cache and registry, for an agent that starts an MCP server with `npx`.
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_REGISTRY',
  'npm_config_cache',
  'npm_config_registry',
  // The desktop session (the desktop app): a browser to open for a sign-in, the SSH agent `git`
  // pushes with.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  // Windows: what a program there cannot start without.
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/**
 * Never passed on, whatever an entry names: the hub's own settings and secrets (and the names
 * they had before the product was renamed), a database, and a chat channel's tokens — Hermes's
 * business, not a coding agent's.
 */
export const NEVER_PASSED: readonly string[] = [
  'COREHUB_*',
  'MAJLIS_*',
  'HUB_*',
  'DATABASE_*',
  'TELEGRAM_*',
  'DATA_DIR',
  'PORT',
];

function matcher(patterns: readonly string[], platform: string): (name: string) => boolean {
  const fold = platform === 'win32';
  const norm = (value: string) => (fold ? value.toUpperCase() : value);
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) prefixes.push(norm(pattern.slice(0, -1)));
    else exact.add(norm(pattern));
  }
  return (name) => {
    const key = norm(name);
    return exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
  };
}

/**
 * The part of `inherited` a child may have: the base, plus `names` (exact names or `PREFIX_*`),
 * less what is never passed. Empty values are kept as they were.
 */
export function pickHostEnv(
  inherited: NodeJS.ProcessEnv,
  names: readonly string[] = [],
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  const allowed = matcher([...BASE_HOST_ENV, ...names], platform);
  const refused = matcher(NEVER_PASSED, platform);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (allowed(name) && !refused(name)) out[name] = value;
  }
  return out;
}

/** The host variables an agent's catalog entry says it reads: its keys and its own settings. */
export function hostEnvNames(
  entry: Pick<CatalogEntry, 'credentials' | 'hostEnv'> | undefined,
): string[] {
  if (!entry) return [];
  return [...(entry.hostEnv ?? []), ...Object.values(entry.credentials)];
}
