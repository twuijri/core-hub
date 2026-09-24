// The names this client answered to before the product was renamed (Majlis → Core Hub,
// ADR 0017): `majlis` as the command, `MAJLIS_*` in the environment. Both still work; each
// run that relies on one says so once, on stderr, so a script's stdout never changes.
import { LEGACY, derived, readProductEnv } from '@corehub/contracts';
import path from 'node:path';

/** The variables this client reads, by their suffix after `COREHUB_`. */
export const CLI_ENV_SUFFIXES = ['CONFIG', 'LANG', 'DEBUG'] as const;

export interface LegacyEnv {
  /** The environment with each old name copied to its new one where the new one is unset. */
  env: NodeJS.ProcessEnv;
  /** The old names that were used. */
  deprecated: string[];
}

export function withLegacyEnv(env: NodeJS.ProcessEnv): LegacyEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const deprecated: string[] = [];
  for (const suffix of CLI_ENV_SUFFIXES) {
    const read = readProductEnv(env, suffix);
    if (read.legacyName && read.value !== undefined) {
      next[`${derived.envPrefix}${suffix}`] = read.value;
      deprecated.push(read.legacyName);
    }
  }
  return { env: next, deprecated };
}

/** Whether the command was started by its old name (the `majlis` alias in `package.json`). */
export function invokedByLegacyName(invokedAs: string | undefined): boolean {
  if (!invokedAs) return false;
  const base = path.basename(invokedAs).replace(/\.(c|m)?js$/, '');
  return base === LEGACY.cliName;
}

/** `MAJLIS_LANG` → `COREHUB_LANG`. */
export function renamedEnv(name: string): string {
  return name.startsWith(LEGACY.envPrefix)
    ? `${derived.envPrefix}${name.slice(LEGACY.envPrefix.length)}`
    : name;
}
