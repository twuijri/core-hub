/**
 * What a Hermes process the hub starts must see in **every** profile it serves — its origin for
 * the hub's tools (§79) and, for the messaging gateway, the API server's key — carried where
 * Hermes reads it under one gateway (or one TUI) serving many profiles.
 *
 * What was observed in Hermes (MIT, v2026.9.14 to v0.21.6 — `agent/secret_scope.py`
 * §get_secret and §build_profile_secret_scope, `hermes_cli/managed_scope.py`,
 * `tools/mcp_tool_config.py` §_interpolate_env_vars and §_require_rendered_remote,
 * `gateway/config_env.py` §_api_server), in our words:
 * - a credential (any variable outside Hermes's short list of process-wide ones) is read from
 *   the scope of the profile a turn runs for: that profile's `.env`, its secret sources, and the
 *   administrator-managed `.env` of `HERMES_MANAGED_DIR` (else `/etc/hermes`), the last with
 *   precedence. The process environment is a fallback only for the process's own profile and
 *   never under the gateway's multiplexer;
 * - up to v2026.9.24 an MCP header naming a variable nobody set went out as written; from v0.21.6
 *   the server is refused instead ("… is not set in this profile's .env or secret source"), and
 *   under the multiplexer the root gateway's own `API_SERVER_KEY` from its environment no longer
 *   reaches its API server, which then never listens.
 *
 * So the hub gives each process it starts a managed folder of its own under its data directory:
 * a `.env` with `COREHUB_MCP_ORIGIN` (and, for the root gateway, `API_SERVER_KEY`), and the same
 * values in the environment as before. Every profile the process serves then resolves them, on
 * every Hermes the hub supports. An administrator's own managed scope (`HERMES_MANAGED_DIR` the
 * hub was started with, else `/etc/hermes`) is copied in first, so its policy still applies; the
 * hub's names come last. Nothing here is Hermes's code.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HUB_ORIGIN_ENV } from './hub-tools/block.js';

export const MANAGED_DIR_ENV = 'HERMES_MANAGED_DIR';
/** Hermes's POSIX default managed scope (`hermes_cli/managed_scope.py` §_DEFAULT_MANAGED_DIR). */
const SYSTEM_MANAGED_DIR = '/etc/hermes';

/** Which process: each gets its own folder, so one's values never reach another. */
export type HermesProcessRole = 'gateway' | 'profile-gateway' | 'tui' | 'dashboard';

/** The origin each role names in its calls to the hub's tools (§79); `dashboard` is neither. */
const ORIGIN: Record<HermesProcessRole, string> = {
  gateway: 'gateway',
  'profile-gateway': 'gateway',
  tui: 'hub',
  dashboard: 'dashboard',
};

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The administrator's managed scope this process would otherwise read, or null. */
export function inheritedManagedDir(
  inherited: NodeJS.ProcessEnv,
  systemDir = SYSTEM_MANAGED_DIR,
): string | null {
  const named = inherited[MANAGED_DIR_ENV]?.trim();
  if (named) return isDir(named) ? named : null;
  return process.platform !== 'win32' && isDir(systemDir) ? systemDir : null;
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Writes `file` when its text differs (no churn on every start), owner-only. */
function writeIfChanged(file: string, text: string): void {
  if (readOptional(file) === text) return;
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** A value as Hermes's `.env` reader takes it back unchanged (`agent/secret_scope.py`). */
function envValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
}

export interface ManagedEnvOptions {
  dataDir: string;
  role: HermesProcessRole;
  /** The environment the process would otherwise get: an administrator's scope is read from it. */
  inherited: NodeJS.ProcessEnv;
  /** More names every profile of this process must resolve (the root gateway's API key). */
  values?: Record<string, string>;
  /** Tests: where the administrator's system scope would be. */
  systemDir?: string;
}

/**
 * Prepares the role's managed folder and returns the variables to add to the process's
 * environment: the origin, the values, and `HERMES_MANAGED_DIR` pointing at the folder.
 */
export function hermesManagedEnv(options: ManagedEnvOptions): Record<string, string> {
  const origin = ORIGIN[options.role];
  const values: Record<string, string> = { [HUB_ORIGIN_ENV]: origin, ...(options.values ?? {}) };
  const dir = path.join(options.dataDir, 'hermes-managed', options.role);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const admin = inheritedManagedDir(options.inherited, options.systemDir);
  const adminEnv = admin && admin !== dir ? readOptional(path.join(admin, '.env')) : null;
  const adminConfig = admin && admin !== dir ? readOptional(path.join(admin, 'config.yaml')) : null;
  const lines = [
    '# Managed by Core Hub for the Hermes processes it starts; rewritten at every start.',
    ...(adminEnv ? [`# Copied from ${admin}/.env:`, adminEnv.trimEnd()] : []),
    ...Object.entries(values).map(([name, value]) => `${name}=${envValue(value)}`),
    '',
  ];
  writeIfChanged(path.join(dir, '.env'), lines.join('\n'));
  const config = path.join(dir, 'config.yaml');
  if (adminConfig !== null) writeIfChanged(config, adminConfig);
  else if (existsSync(config)) writeIfChanged(config, '');
  return { ...values, [MANAGED_DIR_ENV]: dir };
}
