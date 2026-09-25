/**
 * The git a task needs: a worktree of its project's repository on a branch of its own.
 *
 * Every call is `git` with an argument array (`execFile`), never a shell string, so a title,
 * a branch or a path can never become a command. What git says when it refuses is kept word
 * for word: the worktree row shows git's own message, which is what a person can act on.
 *
 * Where things live: a project's repository and every worktree made from it are inside the
 * profile's own folder, `${DATA_DIR}/workspaces/<profile>` — the one folder a session of that
 * profile may work in (`sessions/working-dir.ts`), so the task's run can be given the
 * worktree as its working directory and nothing outside the profile is ever touched.
 */
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

/** How long one git command may take before it is given up on. */
const GIT_TIMEOUT_MS = 60_000;
/** The longest message a worktree row keeps. */
const MESSAGE_MAX = 2_000;
/** What sessions write inside a working directory (`sessions/run-files.ts`). */
const RUN_FILES = '.corehub/';

export interface GitOutcome {
  ok: boolean;
  stdout: string;
  /** git's own words when it refused (stderr), else the process error. */
  message: string;
}

export type Git = (args: readonly string[], cwd?: string) => Promise<GitOutcome>;

/**
 * `git` with an argument array. Never prompts (a credential prompt would hang the hub), and
 * never throws: a refusal is an outcome with git's message.
 */
export function createGit(env: NodeJS.ProcessEnv): Git {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    // Messages in one language, so the row says what git said and nothing else translated.
    LC_ALL: 'C',
  };
  return (args, cwd) =>
    new Promise((resolve) => {
      execFile(
        'git',
        [...args],
        { cwd, env: childEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '');
          if (!error) {
            resolve({ ok: true, stdout: out, message: '' });
            return;
          }
          const said = String(stderr ?? '').trim() || error.message;
          resolve({ ok: false, stdout: out, message: said.slice(-MESSAGE_MAX) });
        },
      );
    });
}

/** `${DATA_DIR}/workspaces/<profile>`, created if missing, as its real path. */
export function profileRoot(dataDir: string, profile: string): string {
  const root = path.join(dataDir, 'workspaces', profile);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

export type RepoCheck =
  | { ok: true; path: string; branch: string | null }
  | { ok: false; reason: 'outside_root' | 'not_found' | 'symlink' | 'not_a_git_repo'; message: string };

/**
 * A project's repository path, checked: inside the profile's folder (a relative path is
 * taken from it), an existing directory reached without a symbolic link, and inside a git
 * work tree. Answers the absolute path and the branch checked out there.
 */
export async function checkRepository(git: Git, root: string, asked: string): Promise<RepoCheck> {
  const raw = asked.trim();
  const target = path.resolve(root, raw);
  if (raw === '' || raw.includes('\0') || (target !== root && !target.startsWith(root + path.sep))) {
    return { ok: false, reason: 'outside_root', message: `must be inside ${root}` };
  }
  let walked = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    walked = path.join(walked, segment);
    let entry;
    try {
      entry = lstatSync(walked);
    } catch {
      return { ok: false, reason: 'not_found', message: `${target} does not exist` };
    }
    if (entry.isSymbolicLink()) {
      return { ok: false, reason: 'symlink', message: `${walked} is a symbolic link` };
    }
  }
  if (!statSync(target).isDirectory()) {
    return { ok: false, reason: 'not_found', message: `${target} is not a folder` };
  }
  const inside = await git(['-C', target, 'rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: 'not_a_git_repo', message: inside.message || 'not a git work tree' };
  }
  const head = await git(['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { ok: true, path: target, branch: head.ok ? head.stdout.trim() || null : null };
}

/** A branch or base name git could mistake for an option, or that is not a name at all. */
export function unsafeRef(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name === '' || name.startsWith('-') || /[\s\u0000-\u001f\u007f~^:?*[\\]/.test(name);
}

/** "Settings page" → "settings-page"; words git cannot carry in a branch are dropped. */
export function slugOf(title: string, max = 40): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * The branch a task works on and the folder its worktree lives in: `task/hub-12-settings-page`
 * and `<root>/worktrees/hub-12-settings-page`. The short id is the task's number in its
 * project; a key git cannot carry falls back to the end of the task's id.
 */
export function worktreeNames(
  root: string,
  task: { id: string; number: number; title: string },
  projectKey: string,
): { branch: string; path: string } {
  const short = /^[A-Za-z0-9]+$/.test(projectKey)
    ? `${projectKey.toLowerCase()}-${task.number}`
    : task.id.slice(-8).toLowerCase();
  const slug = slugOf(task.title);
  const name = slug ? `${short}-${slug}` : short;
  return { branch: `task/${name}`, path: path.join(root, 'worktrees', name) };
}

/**
 * Make the worktree: on the branch when it already exists (a worktree removed earlier keeps
 * its branch, and a new one continues it), else on a new branch from `base`.
 */
export async function addWorktree(
  git: Git,
  input: { repo: string; path: string; branch: string; base: string },
): Promise<GitOutcome> {
  mkdirSync(path.dirname(input.path), { recursive: true });
  const exists = await git([
    '-C',
    input.repo,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${input.branch}`,
  ]);
  const added = exists.ok
    ? await git(['-C', input.repo, 'worktree', 'add', input.path, input.branch])
    : await git(['-C', input.repo, 'worktree', 'add', '-b', input.branch, input.path, input.base]);
  if (added.ok) await excludeRunFiles(git, input.repo);
  return added;
}

/**
 * Remove the worktree and keep its branch. A folder somebody already deleted is not an
 * error: git is told to forget it (`prune`), which is what removing it would have done.
 */
export async function removeWorktree(
  git: Git,
  input: { repo: string | null; path: string },
): Promise<GitOutcome> {
  if (!existsSync(input.path)) {
    if (input.repo && existsSync(input.repo)) await git(['-C', input.repo, 'worktree', 'prune']);
    return { ok: true, stdout: '', message: '' };
  }
  const repo = input.repo && existsSync(input.repo) ? input.repo : input.path;
  return git(['-C', repo, 'worktree', 'remove', '--force', input.path]);
}

/** How the worktree stands: files changed, and commits ahead of / behind its base. */
export async function worktreeStats(
  git: Git,
  input: { path: string; base: string | null },
): Promise<{ changedFiles: number; ahead: number; behind: number; head: string | null } | null> {
  if (!existsSync(input.path)) return null;
  const status = await git(['-C', input.path, 'status', '--porcelain']);
  if (!status.ok) return null;
  const changedFiles = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
  let ahead = 0;
  let behind = 0;
  if (input.base && !unsafeRef(input.base)) {
    const counts = await git([
      '-C',
      input.path,
      'rev-list',
      '--left-right',
      '--count',
      `${input.base}...HEAD`,
    ]);
    if (counts.ok) {
      const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
      behind = Number.isFinite(left) ? left! : 0;
      ahead = Number.isFinite(right) ? right! : 0;
    }
  }
  const head = await git(['-C', input.path, 'rev-parse', 'HEAD']);
  return { changedFiles, ahead, behind, head: head.ok ? head.stdout.trim() : null };
}

/**
 * The files a session writes for a run (`.corehub/`) are the hub's, not the task's work:
 * the repository's local exclude list (never a tracked file) is told to ignore them, so a
 * worktree is not "dirty" only because a run happened in it.
 */
async function excludeRunFiles(git: Git, repo: string): Promise<void> {
  const common = await git(['-C', repo, 'rev-parse', '--git-common-dir']);
  if (!common.ok) return;
  const dir = path.resolve(repo, common.stdout.trim());
  const file = path.join(dir, 'info', 'exclude');
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current.split('\n').some((line) => line.trim() === RUN_FILES)) return;
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${RUN_FILES}\n`);
  } catch {
    // Only a convenience: a worktree that shows the run files is still a working worktree.
  }
}
