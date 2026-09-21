// The only file that reads process.env (a unit test enforces this). Invariant 5: the server
// starts with nothing beyond a data directory and an admin password; the rest is set from the UI.
import path from 'node:path';
import { z } from 'zod';

export const ENV_KEYS = ['DATA_DIR', 'PORT', 'DATABASE_URL', 'HUB_ADMIN_PASSWORD'] as const;
export type EnvKey = (typeof ENV_KEYS)[number];
export type EnvSource = Partial<Record<EnvKey, string | undefined>>;

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
}

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
    hostEnv,
  };
}

/** Copy only the keys the hub is allowed to read. */
export function pickEnv(env: NodeJS.ProcessEnv): EnvSource {
  const picked: EnvSource = {};
  for (const key of ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') picked[key] = env[key];
  }
  return picked;
}
