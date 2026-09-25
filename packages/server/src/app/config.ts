// The only file that reads process.env (a unit test enforces this). Invariant 5: the server
// starts with nothing beyond a data directory and an admin password; the rest is set from the UI.
import path from 'node:path';
import { z } from 'zod';

export const ENV_KEYS = [
  'DATA_DIR',
  'PORT',
  'DATABASE_URL',
  'HUB_ADMIN_PASSWORD',
  'COREHUB_VERSION',
  'COREHUB_SETUP_OPEN_MINUTES',
  'COREHUB_RESET_OWNER',
  'COREHUB_TASK_AUTO_START_MAX',
  'COREHUB_WEB_TERMINAL',
  'COREHUB_WEB_TERMINAL_IDLE_MINUTES',
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];
export type EnvSource = Partial<Record<EnvKey, string | undefined>> & {
  /** Old names (Majlis) a value was read under; the hub says so once at boot. */
  readonly deprecated?: readonly string[];
};

/**
 * The variables the hub still reads under the name they had before the product was renamed
 * (Majlis → Core Hub, ADR 0017). The new name wins when both are set. A stack upgraded by
 * replacing only its image keeps working; the log says which name to change.
 */
export const LEGACY_ENV_KEYS: Readonly<Partial<Record<EnvKey, string>>> = {
  COREHUB_VERSION: 'MAJLIS_VERSION',
};

const envSchema = z.object({
  DATA_DIR: z.string().trim().min(1).default('./data'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  DATABASE_URL: z
    .string()
    .trim()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// or postgresql:// URL')
    .optional(),
  HUB_ADMIN_PASSWORD: z
    .string()
    .min(8, 'HUB_ADMIN_PASSWORD must be at least 8 characters')
    .optional(),
  /**
   * The release this image is. The workspace's package.json files stay at 0.0.0 on
   * purpose — a release is a git tag, not a commit that bumps five files — so the image
   * build stamps the tag here (`packages/server/Dockerfile`) and the hub reports it on
   * /api/v1/health and /api/v1/meta. Empty outside an image: a working tree is no release.
   */
  COREHUB_VERSION: z.string().trim().optional(),
  /**
   * First run (ADR 0019): how long after the process starts with no owner `/setup` is open to
   * whoever arrives first, without the claim token. `0` is the strict mode — token only.
   */
  COREHUB_SETUP_OPEN_MINUTES: z.coerce
    .number()
    .int('COREHUB_SETUP_OPEN_MINUTES must be a whole number of minutes')
    .min(0, 'COREHUB_SETUP_OPEN_MINUTES must be 0 or more')
    .max(1440, 'COREHUB_SETUP_OPEN_MINUTES must be at most 1440 (one day)')
    .default(60),
  /**
   * Recovery (ADR 0019): `1` disables the owner account(s) on this boot and reopens first-run
   * setup — once; a marker in DATA_DIR stops it repeating while the variable stays set.
   */
  COREHUB_RESET_OWNER: z
    .enum(['0', '1', 'true', 'false'], {
      message: 'COREHUB_RESET_OWNER must be 1 (reset) or 0',
    })
    .optional(),
  /**
   * Tasks: how many runs the hub starts **on its own** (`auto_start`) at once in one profile.
   * A person's "assign and start" is never held back by it; an automatic start waits for a
   * free place instead (DECISIONS §47).
   */
  COREHUB_TASK_AUTO_START_MAX: z.coerce
    .number()
    .int('COREHUB_TASK_AUTO_START_MAX must be a whole number')
    .min(1, 'COREHUB_TASK_AUTO_START_MAX must be at least 1')
    .max(50, 'COREHUB_TASK_AUTO_START_MAX must be at most 50')
    .default(2),
  /**
   * The owner's web terminal (DECISIONS §70): a shell on this host, as the hub's own user,
   * reachable from the browser by the owner account only. Off unless this is `1`.
   */
  COREHUB_WEB_TERMINAL: z
    .enum(['0', '1', 'true', 'false'], {
      message: 'COREHUB_WEB_TERMINAL must be 1 (on) or 0 (off)',
    })
    .optional(),
  /** Minutes a web terminal session may sit with nobody typing before the hub closes it. */
  COREHUB_WEB_TERMINAL_IDLE_MINUTES: z.coerce
    .number()
    .int('COREHUB_WEB_TERMINAL_IDLE_MINUTES must be a whole number of minutes')
    .min(1, 'COREHUB_WEB_TERMINAL_IDLE_MINUTES must be at least 1')
    .max(1440, 'COREHUB_WEB_TERMINAL_IDLE_MINUTES must be at most 1440 (one day)')
    .default(15),
});

export type DatabaseConfig = { kind: 'sqlite'; file: string } | { kind: 'postgres'; url: string };

/**
 * The host environment, as opposed to the hub's configuration: `PATH` for finding an
 * installed agent CLI and the variables a spawned agent inherits. It is read here, and
 * only here, so the rule "config.ts is the only file that touches `process.env`" still
 * holds — a unit test enforces it.
 */
export interface HostEnv {
  path: string | undefined;
  pathExt: string | undefined;
  /** What a child process inherits. Never logged; never sent to a client. */
  inherited: NodeJS.ProcessEnv;
}

export function readHostEnv(env: NodeJS.ProcessEnv = process.env): HostEnv {
  return { path: env.PATH, pathExt: env.PATHEXT, inherited: env };
}

export interface HubConfig {
  dataDir: string;
  port: number;
  database: DatabaseConfig;
  /**
   * Consumed by the auth module on first boot only (when no owner account exists) and
   * ignored afterwards; it is never logged and never stored in clear text.
   */
  bootstrapAdminPassword: string | undefined;
  /** PATH and the variables spawned agents inherit (see `HostEnv`). */
  hostEnv: HostEnv;
  /** The stamped release version, or `undefined` for a working tree (`COREHUB_VERSION`). */
  version: string | undefined;
  /** Variables that were read under their old (Majlis) name; logged once at boot. */
  deprecatedEnv?: readonly string[];
  /** Minutes first-run setup stays open without the claim token (`0` = token only). */
  setupOpenMinutes: number;
  /** `COREHUB_RESET_OWNER=1`: disable the owner and reopen setup on this boot (once). */
  resetOwner: boolean;
  /** Runs started by `auto_start` at once per profile (`COREHUB_TASK_AUTO_START_MAX`, 2). */
  taskAutoStartMax: number;
  /** The owner's web terminal: off unless `COREHUB_WEB_TERMINAL=1` (DECISIONS §70). */
  webTerminal: WebTerminalConfig;
}

export interface WebTerminalConfig {
  enabled: boolean;
  /** Idle sessions close after this long (`COREHUB_WEB_TERMINAL_IDLE_MINUTES`, 15). */
  idleMs: number;
  /** Sessions open at once, hub-wide. Fixed: the owner asked for at most three. */
  maxSessions: number;
}

/** The web terminal's cap on sessions open at once (owner, 2026-09-25). */
export const WEB_TERMINAL_MAX_SESSIONS = 3;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(
  source: EnvSource = pickEnv(process.env),
  hostEnv: HostEnv = readHostEnv(),
): HubConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  const env = result.data;
  const dataDir = path.resolve(env.DATA_DIR);
  return {
    dataDir,
    port: env.PORT,
    database: env.DATABASE_URL
      ? { kind: 'postgres', url: env.DATABASE_URL }
      : { kind: 'sqlite', file: path.join(dataDir, 'hub.sqlite') },
    bootstrapAdminPassword: env.HUB_ADMIN_PASSWORD,
    version: env.COREHUB_VERSION,
    hostEnv,
    deprecatedEnv: source.deprecated ?? [],
    setupOpenMinutes: env.COREHUB_SETUP_OPEN_MINUTES,
    resetOwner: env.COREHUB_RESET_OWNER === '1' || env.COREHUB_RESET_OWNER === 'true',
    taskAutoStartMax: env.COREHUB_TASK_AUTO_START_MAX,
    webTerminal: {
      enabled: env.COREHUB_WEB_TERMINAL === '1' || env.COREHUB_WEB_TERMINAL === 'true',
      idleMs: env.COREHUB_WEB_TERMINAL_IDLE_MINUTES * 60_000,
      maxSessions: WEB_TERMINAL_MAX_SESSIONS,
    },
  };
}

/** Copy only the keys the hub is allowed to read. */
export function pickEnv(env: NodeJS.ProcessEnv): EnvSource {
  const picked: Partial<Record<EnvKey, string>> = {};
  const deprecated: string[] = [];
  for (const key of ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') {
      picked[key] = env[key];
      continue;
    }
    const legacy = LEGACY_ENV_KEYS[key];
    if (legacy && env[legacy] !== undefined && env[legacy] !== '') {
      picked[key] = env[legacy];
      deprecated.push(legacy);
    }
  }
  return deprecated.length > 0 ? { ...picked, deprecated } : picked;
}
