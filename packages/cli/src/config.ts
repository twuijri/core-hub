// The token store: `$XDG_CONFIG_HOME/corehub/config.json` (or `~/.config/corehub/config.json`),
// directory 0700, file 0600, written atomically. Secrets never travel on the command line.
import { LEGACY, derived } from '@corehub/contracts';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';

export interface StoredUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
}

export interface StoredSession {
  /** Hub origin, e.g. `https://hub.example`. */
  server: string;
  /** Workspace slug sent as `X-Hub-Profile`. */
  profile: string;
  /** Bearer: the access JWT of a web session, or a `hub_at_…` app token. */
  token: string;
  token_kind: 'session' | 'app';
  refresh_token: string | null;
  /** When `token` stops working; the client refreshes or renews before that. */
  expires_at: string | null;
  user: StoredUser;
}

export interface ConfigFile {
  version: 1;
  /** Stable id this computer presents when pairing, so re-pairing updates the same device row. */
  device_key: string | null;
  session: StoredSession | null;
}

const EMPTY: ConfigFile = { version: 1, device_key: null, session: null };

export function defaultConfigPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  if (env.COREHUB_CONFIG && env.COREHUB_CONFIG.trim() !== '') return path.resolve(env.COREHUB_CONFIG);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, derived.configDir, 'config.json');
}

/**
 * Where the same file lived before the rename (`$XDG_CONFIG_HOME/majlis/config.json`), or
 * null when the path was chosen explicitly — an explicit file is never swapped for another.
 */
export function legacyConfigPath(env: NodeJS.ProcessEnv, home: string = homedir()): string | null {
  if (env.COREHUB_CONFIG && env.COREHUB_CONFIG.trim() !== '') return null;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, LEGACY.configDir, 'config.json');
}

export class ConfigStore {
  /**
   * `legacyFile` is where a client from before the rename kept the same file. The first read
   * that finds no file here moves that one in (ADR 0017), so an upgrade does not sign anyone
   * out or forget the device.
   */
  constructor(
    readonly file: string,
    readonly legacyFile: string | null = null,
  ) {}

  read(): ConfigFile {
    if (!existsSync(this.file)) this.adoptLegacy();
    if (!existsSync(this.file)) return { ...EMPTY };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new CliError('errors.config_invalid', { file: this.file });
    }
    if (!parsed || typeof parsed !== 'object')
      throw new CliError('errors.config_invalid', { file: this.file });
    const config = parsed as Partial<ConfigFile>;
    return {
      version: 1,
      device_key: typeof config.device_key === 'string' ? config.device_key : null,
      session: isSession(config.session) ? config.session : null,
    };
  }

  write(config: ConfigFile): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  private adoptLegacy(): void {
    if (!this.legacyFile || this.legacyFile === this.file || !existsSync(this.legacyFile)) return;
    let text: string;
    try {
      text = readFileSync(this.legacyFile, 'utf8');
      JSON.parse(text);
    } catch {
      // Not ours to judge: an unreadable old file stays where it is, and this one starts empty.
      return;
    }
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    // The token must not stay in two places.
    unlinkSync(this.legacyFile);
  }

  session(): StoredSession | null {
    return this.read().session;
  }

  saveSession(session: StoredSession): void {
    this.write({ ...this.read(), session });
  }

  clearSession(): void {
    this.write({ ...this.read(), session: null });
  }

  /** Created once and kept across sign-outs. */
  deviceKey(): string {
    const config = this.read();
    if (config.device_key) return config.device_key;
    const key = randomUUID();
    this.write({ ...config, device_key: key });
    return key;
  }
}

function isSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.server === 'string' &&
    typeof s.profile === 'string' &&
    typeof s.token === 'string' &&
    (s.token_kind === 'session' || s.token_kind === 'app') &&
    (s.refresh_token === null || typeof s.refresh_token === 'string') &&
    (s.expires_at === null || typeof s.expires_at === 'string') &&
    !!s.user &&
    typeof s.user === 'object'
  );
}
