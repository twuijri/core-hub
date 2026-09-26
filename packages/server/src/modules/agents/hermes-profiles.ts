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
 *
 * A display name is Hermes's too (`hermes_cli/profiles.py`, `set_profile_display_name`): a
 * presentation-only `display_name` in the profile's `profile.yaml`, at most 64 characters,
 * that Hermes shows beside the id (`hermes profile list`, `show`) and never uses to find the
 * profile. For `default` the hub runs `hermes profile rename default <name>`, which is
 * exactly that write — the id stays `default`. For a named profile Hermes's `rename` moves
 * the folder (and stops its gateway, rewrites its alias and Honcho host), so the hub writes
 * the same key itself and the folder stays where every channel, schedule and chat expects it.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isMap, parseDocument } from 'yaml';

/** Hermes's `_PROFILE_ID_RE`. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DELETED = '.deleted';

export type ProfileRunner = (
  argv: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export class HermesProfileError extends Error {}

/** Hermes's limit on a display name (`set_profile_display_name`). */
export const DISPLAY_NAME_MAX = 64;

export interface HermesProfiles {
  list(): Promise<string[]>;
  create(
    name: string,
    origin: { kind: 'blank' } | { kind: 'clone'; source: string },
  ): Promise<void>;
  /** Sets (or, with `''`, clears) the profile's display name; the id and folder stay. */
  setDisplayName(name: string, displayName: string): Promise<void>;
  /**
   * The profile's display name as Hermes reads it (`read_profile_meta`), `''` when it has
   * none or no such profile exists. A file read, no Python started.
   */
  displayName(name: string): string;
}

export function createHermesProfiles(options: {
  home: string;
  run: ProfileRunner;
}): HermesProfiles {
  return {
    async list() {
      return namedHermesProfiles(options.home);
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

    async setDisplayName(name, displayName) {
      const cleaned = displayName.trim();
      if (cleaned.length > DISPLAY_NAME_MAX) {
        throw new HermesProfileError(
          `Display name too long (${cleaned.length} chars, max ${DISPLAY_NAME_MAX}).`,
        );
      }
      if (name === 'default') {
        // Hermes's own command. `--` so a name that starts with a dash stays a name.
        const result = await options.run(['profile', 'rename', '--', 'default', cleaned]);
        if (result.code !== 0) {
          throw new HermesProfileError(
            lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`,
          );
        }
        return;
      }
      const dir = path.join(options.home, 'profiles', name);
      if (!PROFILE_ID.test(name) || !isDirectory(dir)) {
        throw new HermesProfileError(`Profile '${name}' does not exist.`);
      }
      writeDisplayName(dir, cleaned);
    },

    displayName(name) {
      if (name === 'default') return readDisplayName(options.home);
      if (!PROFILE_ID.test(name)) return '';
      return readDisplayName(path.join(options.home, 'profiles', name));
    },
  };
}

/**
 * `read_profile_meta(dir)["display_name"]` in our words: the `display_name` of the folder's
 * `profile.yaml`, trimmed; `''` when the file is missing, is not a mapping, or has none —
 * never an error, as Hermes never fails a listing over one profile's file. Longer than
 * Hermes's own limit is cut to it.
 */
export function readDisplayName(profileDir: string): string {
  let text: string;
  try {
    text = readFileSync(path.join(profileDir, 'profile.yaml'), 'utf8');
  } catch {
    return '';
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return '';
  const value = doc.get('display_name');
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, DISPLAY_NAME_MAX);
}

/**
 * `write_profile_meta(dir, display_name=…)` in our words: only `display_name` changes, every
 * other key (the description the kanban decomposer reads) stays, an empty name removes the
 * key, and the file is replaced in one rename so a crash never leaves half a file.
 */
export function writeDisplayName(profileDir: string, displayName: string): void {
  const file = path.join(profileDir, 'profile.yaml');
  // Nothing to clear in a profile that has no metadata yet.
  if (!displayName && !existsSync(file)) return;
  let doc = parseDocument('{}');
  if (existsSync(file)) {
    const read = parseDocument(readFileSync(file, 'utf8'));
    // Hermes reads a file that is not a mapping as empty, and so does this.
    if (read.errors.length === 0 && isMap(read.contents)) doc = read;
  }
  if (displayName) doc.set('display_name', displayName);
  else doc.delete('display_name');
  const staging = path.join(profileDir, `.profile.yaml.${process.pid}.tmp`);
  try {
    writeFileSync(staging, doc.toString(), 'utf8');
    renameSync(staging, file);
  } catch (error) {
    throw new HermesProfileError(
      `Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Hermes's named profiles under `home` (never `default`, which is `home` itself), deleted
 * ones left out — Hermes's own `_iter_named_profile_dirs` rule, as a directory read.
 */
export function namedHermesProfiles(home: string): string[] {
  const root = path.join(home, 'profiles');
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
