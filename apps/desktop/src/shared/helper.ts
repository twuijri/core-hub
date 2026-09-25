/**
 * The local helper's settings and its one safety rule: a path is used only if, once every
 * symbolic link is resolved, it is inside a folder the person chose (ADR 0022).
 */
import path from 'node:path';

export interface HelperFolder {
  /** Absolute, as the person picked it. */
  path: string;
  /** Read only unless this is true. */
  write: boolean;
}

export interface HelperConfig {
  /** Off until the person turns it on (ADR 0009: optional, off by default). */
  enabled: boolean;
  folders: HelperFolder[];
  /** Whether the helper may open files (in the chosen folders) and web links on this computer. */
  allowOpen: boolean;
  /** The bearer token an MCP client must present; 32 random bytes, hex. */
  token: string;
  /** Kept so the address given to Hermes stays valid across launches. */
  port: number | null;
}

export const FOLDER_LIMIT = 20;

/** 32 random bytes as hex, from the Web Crypto every runtime here has. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function defaultHelper(makeToken: () => string): HelperConfig {
  return { enabled: false, folders: [], allowOpen: false, token: makeToken(), port: null };
}

export function parseHelper(raw: unknown, makeToken: () => string): HelperConfig {
  const base = defaultHelper(makeToken);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const folders = Array.isArray(r.folders)
    ? r.folders
        .filter(
          (f): f is { path: string; write?: unknown } =>
            !!f &&
            typeof f === 'object' &&
            typeof (f as { path?: unknown }).path === 'string' &&
            path.isAbsolute((f as { path: string }).path),
        )
        .map((f) => ({ path: path.normalize(f.path), write: f.write === true }))
        .filter((f, i, all) => all.findIndex((o) => o.path === f.path) === i)
        .slice(0, FOLDER_LIMIT)
    : [];
  const port = r.port;
  return {
    enabled: r.enabled === true,
    folders,
    allowOpen: r.allowOpen === true,
    token: typeof r.token === 'string' && /^[0-9a-f]{64}$/.test(r.token) ? r.token : base.token,
    port:
      typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65_535
        ? port
        : null,
  };
}

export type Resolved =
  | { ok: true; path: string; folder: HelperFolder }
  | { ok: false; reason: 'outside' | 'missing' | 'read_only' };

/** Whether `child` is `parent` or below it (both already resolved). */
export function isInside(parent: string, child: string, api: typeof path = path): boolean {
  const rel = api.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

/**
 * Where a requested path really is, and which chosen folder allows it.
 *
 * `realpath` resolves links; for a file that does not exist yet (a write), its parent folder
 * is resolved instead and the name appended, so a link can never smuggle a write outside.
 */
export function resolveInside(
  folders: readonly HelperFolder[],
  requested: string,
  options: {
    realpath: (p: string) => string | null;
    forWrite?: boolean;
    api?: typeof path;
  },
): Resolved {
  const api = options.api ?? path;
  if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0'))
    return { ok: false, reason: 'outside' };
  const absolute = api.resolve(requested);
  let real = options.realpath(absolute);
  if (real === null) {
    if (!options.forWrite) return { ok: false, reason: 'missing' };
    const parent = options.realpath(api.dirname(absolute));
    if (parent === null) return { ok: false, reason: 'missing' };
    real = api.join(parent, api.basename(absolute));
  }
  let best: HelperFolder | null = null;
  for (const folder of folders) {
    const root = options.realpath(folder.path);
    if (root === null || !isInside(root, real, api)) continue;
    // The most specific folder decides (a read-only folder inside a writable one stays read-only).
    if (!best || folder.path.length > best.path.length) best = folder;
  }
  if (!best) return { ok: false, reason: 'outside' };
  if (options.forWrite && !best.write) return { ok: false, reason: 'read_only' };
  return { ok: true, path: real, folder: best };
}
