// The token store: `$XDG_CONFIG_HOME/majlis/config.json` (or `~/.config/majlis/config.json`),
// directory 0700, file 0600, written atomically. Secrets never travel on the command line.
import { derived } from '@majlis/contracts';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  if (env.MAJLIS_CONFIG && env.MAJLIS_CONFIG.trim() !== '') return path.resolve(env.MAJLIS_CONFIG);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, derived.configDir, 'config.json');
}

export class ConfigStore {
  constructor(readonly file: string) {}

  read(): ConfigFile {
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
