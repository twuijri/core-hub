/**
 * The plugin's own files, in its data folder under the harness profile (ADR 0033 §2):
 *
 * - `link.json` — the hub, the person's app token and the device the pairing made. The token
 *   goes nowhere else: not into the harness's config patch, not to a page, not into a log.
 * - `device-key` — the id this computer registers with, kept across unlink and relink so the hub
 *   updates the same device row.
 * - `conversations.json` — which hub conversation follows which harness session (§6).
 *
 * Every file is written whole (a temporary file, then a rename) and readable only by the
 * person (`0600`, the folder `0700`). On Windows the modes are advisory; the folder sits in the
 * person's own profile.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface StoredUser {
  id: string;
  username: string;
  display_name: string;
}

export interface StoredLink {
  version: 1;
  hub: string;
  token: string;
  /** When the app token lapses; renewed before (see `hub.ts`). */
  token_expires_at: string | null;
  device_id: string;
  user: StoredUser;
  profiles: string[];
  default_profile: string;
  linked_at: string;
}

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

const LINK_FILE = 'link.json';
const DEVICE_KEY_FILE = 'device-key';
const CONVERSATIONS_FILE = 'conversations.json';
const CONVERSATIONS_MAX = 500;

/** Writes `text` to `file` so a crash never leaves half a file, readable by the person only. */
export function writePrivate(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, text, { encoding: 'utf8', mode: FILE_MODE });
  chmodSync(temp, FILE_MODE);
  renameSync(temp, file);
  chmodSync(file, FILE_MODE);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A stored link, or null when the file is missing, unreadable or not one of ours. */
export function parseLink(raw: unknown): StoredLink | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const user = r.user as Record<string, unknown> | undefined;
  if (
    r.version !== 1 ||
    !isString(r.hub) ||
    !isString(r.token) ||
    !isString(r.device_id) ||
    !user ||
    !isString(user.id) ||
    !isString(user.username)
  )
    return null;
  const profiles = Array.isArray(r.profiles) ? r.profiles.filter(isString) : [];
  return {
    version: 1,
    hub: r.hub,
    token: r.token,
    token_expires_at: isString(r.token_expires_at) ? r.token_expires_at : null,
    device_id: r.device_id,
    user: {
      id: user.id,
      username: user.username,
      display_name: isString(user.display_name) ? user.display_name : user.username,
    },
    profiles,
    default_profile: isString(r.default_profile) ? r.default_profile : (profiles[0] ?? 'default'),
    linked_at: isString(r.linked_at) ? r.linked_at : new Date(0).toISOString(),
  };
}

export class PluginStore {
  constructor(readonly dir: string) {}

  get linkFile(): string {
    return path.join(this.dir, LINK_FILE);
  }

  link(): StoredLink | null {
    return parseLink(readJson(this.linkFile));
  }

  saveLink(link: StoredLink): void {
    writePrivate(this.linkFile, `${JSON.stringify(link, null, 2)}\n`);
  }

  /** Forgets the hub and the token; the device key stays (a relink updates the same device). */
  forgetLink(): void {
    rmSync(this.linkFile, { force: true });
    rmSync(path.join(this.dir, CONVERSATIONS_FILE), { force: true });
  }

  /** The stable id this computer registers with; made once. */
  deviceKey(): string {
    const file = path.join(this.dir, DEVICE_KEY_FILE);
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{32,128}$/.test(existing)) return existing;
    } catch {
      // Not made yet.
    }
    const key = randomBytes(32).toString('hex');
    writePrivate(file, `${key}\n`);
    return key;
  }

  /** The hub conversation that follows a harness session, if one was started. */
  conversation(harnessSession: string): { session_id: string; profile: string } | null {
    const all = readJson(path.join(this.dir, CONVERSATIONS_FILE));
    if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
    const entry = (all as Record<string, unknown>)[harnessSession];
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    return isString(e.session_id) && isString(e.profile)
      ? { session_id: e.session_id, profile: e.profile }
      : null;
  }

  saveConversation(harnessSession: string, value: { session_id: string; profile: string }): void {
    const file = path.join(this.dir, CONVERSATIONS_FILE);
    const all = readJson(file);
    const map: Record<string, unknown> =
      all && typeof all === 'object' && !Array.isArray(all) ? { ...(all as object) } : {};
    delete map[harnessSession];
    map[harnessSession] = { ...value, at: new Date().toISOString() };
    const keys = Object.keys(map);
    for (const old of keys.slice(0, Math.max(0, keys.length - CONVERSATIONS_MAX))) delete map[old];
    writePrivate(file, `${JSON.stringify(map, null, 2)}\n`);
  }

  /** Whether the link file is readable by anyone but the person (POSIX only). */
  linkFileTooOpen(): boolean {
    if (process.platform === 'win32' || !existsSync(this.linkFile)) return false;
    return (statSync(this.linkFile).mode & 0o077) !== 0;
  }
}
