/**
 * Hermes's profiles, as the hub's workspaces see them (ADR 0014).
 *
 * Listing reads the directory the way Hermes does (`hermes_cli/profiles.py`,
 * `_iter_named_profile_dirs`): every directory under `<home>/profiles/` whose name is a
 * valid profile id, is not `default`, and has no tombstone under `profiles/.deleted/`. It is
 * a directory read — no Python started on every page load — and `hermes profile list`
 * prints a table, not data.
 *
 * Creating runs Hermes itself, `hermes profile create`, so a profile is exactly what
 * Hermes would make: `--clone-from <source>` copies config, SOUL.md and skills (not
 * memory, sessions or messaging channels — Hermes's choice), and a blank one is Hermes's
 * fresh profile with its bundled skills. `--no-alias`: the hub never uses the wrapper
 * scripts, and a container has no PATH entry for them.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Hermes's `_PROFILE_ID_RE`. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DELETED = '.deleted';

export type ProfileRunner = (
  argv: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export class HermesProfileError extends Error {}

export interface HermesProfiles {
  list(): Promise<string[]>;
  create(
    name: string,
    origin: { kind: 'blank' } | { kind: 'clone'; source: string },
  ): Promise<void>;
}

export function createHermesProfiles(options: {
  home: string;
  run: ProfileRunner;
}): HermesProfiles {
  const root = path.join(options.home, 'profiles');
  return {
    async list() {
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        return []; // no named profile yet
      }
      return entries
        .filter(
          (name) =>
            name !== 'default' &&
            PROFILE_ID.test(name) &&
            isDirectory(path.join(root, name)) &&
            !existsSync(path.join(root, DELETED, name)),
        )
        .sort();
    },

    async create(name, origin) {
      const argv = ['profile', 'create', name, '--no-alias'];
      if (origin.kind === 'clone') argv.push('--clone-from', origin.source);
      const result = await options.run(argv);
      if (result.code !== 0) {
        throw new HermesProfileError(
          lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`,
        );
      }
    },
  };
}

/** Runs `hermes <argv>` against one home, with the whole environment given. */
export function hermesProfileRunner(options: {
  command: string;
  home: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): ProfileRunner {
  return (argv) =>
    new Promise((resolve) => {
      execFile(
        options.command,
        [...argv],
        {
          env: { ...options.env, HERMES_HOME: options.home },
          cwd: options.home,
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Hermes says why on its last line (`Error: Profile 'x' already exists …`). */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}

/**
 * A profile as an archive (ADR 0014 stage 2), through Hermes's own dashboard API (ADR
 * 0015): `POST /api/profiles/{name}/export` with an `output` path, and `POST
 * /api/profiles/import` with an `archive` path and a `name` (`hermes_cli/web_routers/
 * profiles.py`). Paths are exchanged, not bytes: the server shares the hub's filesystem.
 *
 * What Hermes puts in the archive is Hermes's decision (`hermes_cli/profiles.py`
 * §export_profile): a named profile's whole folder without `.env` and `auth.json`; the
 * default profile's known files only (config, SOUL, memory, skills, cron, sessions …); and
 * in both, secret-shaped text force-redacted. The hub checks the result again before it
 * hands it out (`auth/profile-archive.ts`).
 */
export interface HermesProfileArchives {
  /** Answers the path Hermes wrote. */
  export(name: string, output: string): Promise<string>;
  import(archive: string, name: string): Promise<void>;
}

/** Long enough for a profile with a large chat history; Hermes's own verbs are seconds. */
export const PROFILE_ARCHIVE_TIMEOUT_MS = 10 * 60_000;

export function createHermesProfileArchives(
  request: <T>(
    method: string,
    path: string,
    body: unknown,
    options: { timeoutMs?: number },
  ) => Promise<T>,
): HermesProfileArchives {
  const timeout = { timeoutMs: PROFILE_ARCHIVE_TIMEOUT_MS };
  return {
    async export(name, output) {
      const answer = await request<{ ok?: boolean; archive?: string }>(
        'POST',
        `/api/profiles/${encodeURIComponent(name)}/export`,
        { output },
        timeout,
      );
      return typeof answer?.archive === 'string' && answer.archive ? answer.archive : output;
    },
    async import(archive, name) {
      await request('POST', '/api/profiles/import', { archive, name }, timeout);
    },
  };
}
