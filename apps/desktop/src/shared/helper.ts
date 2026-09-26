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

/** A tool as a program described it, kept so the hub can list it without starting the program. */
export interface ProgramToolSnapshot {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The person's choices for one program on this computer (ADR 0025). */
export interface ProgramSettings {
  /** The profiles (slugs) whose agents may use it; empty: it is off, the default. */
  profiles: string[];
  /** Values for its settings, each sealed by the OS keychain where there is one (`sealText`). */
  values: Record<string, string>;
  /** Its tools as it last listed them; null until it ran once. */
  tools: ProgramToolSnapshot[] | null;
}

export const PROGRAM_LIMIT = 50;
const PROFILE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  /** Programs on this computer, by id: each off until the person picks its profiles. */
  programs: Record<string, ProgramSettings>;
  /** The folder the app made for Core Hub's own files (`~/Core Hub`), while it is shared. */
  defaultFolder: string | null;
}

export const FOLDER_LIMIT = 20;

/** 32 random bytes as hex, from the Web Crypto every runtime here has. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function defaultHelper(makeToken: () => string): HelperConfig {
  return {
    enabled: false,
    folders: [],
    allowOpen: false,
    token: makeToken(),
    port: null,
    programs: {},
    defaultFolder: null,
  };
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
  const defaultFolder =
    typeof r.defaultFolder === 'string' && folders.some((f) => f.path === r.defaultFolder)
      ? r.defaultFolder
      : null;
  return {
    enabled: r.enabled === true,
    folders,
    allowOpen: r.allowOpen === true,
    token: typeof r.token === 'string' && /^[0-9a-f]{64}$/.test(r.token) ? r.token : base.token,
    port:
      typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65_535
        ? port
        : null,
    programs: parsePrograms(r.programs),
    defaultFolder,
  };
}

function parsePrograms(raw: unknown): Record<string, ProgramSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ProgramSettings> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, PROGRAM_LIMIT)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const profiles = Array.isArray(v.profiles)
      ? [...new Set(v.profiles.filter((p): p is string => typeof p === 'string' && PROFILE_SLUG.test(p)))]
      : [];
    const values: Record<string, string> = {};
    if (v.values && typeof v.values === 'object' && !Array.isArray(v.values)) {
      for (const [key, sealed] of Object.entries(v.values as Record<string, unknown>)) {
        if (typeof sealed === 'string' && key.length <= 128) values[key] = sealed;
      }
    }
    const tools = Array.isArray(v.tools)
      ? v.tools
          .filter(
            (t): t is { name: string; description?: unknown; input_schema?: unknown } =>
              !!t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string',
          )
          .slice(0, 200)
          .map((t) => ({
            name: t.name.slice(0, 128),
            description: typeof t.description === 'string' ? t.description.slice(0, 2000) : '',
            input_schema:
              t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema)
                ? (t.input_schema as Record<string, unknown>)
                : { type: 'object' },
          }))
      : null;
    out[id] = { profiles, values, tools };
  }
  return out;
}

/** Where the app makes its own folder: `~/Core Hub` (Windows: `%USERPROFILE%\Core Hub`). */
export function defaultFolderPath(home: string, name: string, api: typeof path = path): string {
  return api.join(home, name);
}

/**
 * The helper was switched on with nothing shared: share the app's own folder, writable, as the
 * place for Core Hub's files (owner, 2026-09-26; ADR 0022 as amended). Anything shared already
 * is left as it is.
 */
export function withDefaultFolder(config: HelperConfig, folder: string): HelperConfig {
  if (config.folders.length > 0) return config;
  return { ...config, folders: [{ path: folder, write: true }], defaultFolder: folder };
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
