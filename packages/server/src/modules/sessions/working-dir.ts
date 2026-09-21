/**
 * Where a session's work lives on disk.
 *
 * One rule, enforced here and nowhere else: every session works inside
 * `${DATA_DIR}/workspaces/<workspace>` and nothing above it. A client may name
 * an existing folder under that root or a new one; it may not name `/etc`, nor
 * `../../etc`, nor a symlink that leads there. A path that resolves outside the
 * root is refused with the contract's envelope (`400 validation_failed`) — never
 * silently rewritten, because a person who typed the wrong path should be told.
 *
 * The functions are small and synchronous on purpose: `sessions.create` is the
 * only caller and it must decide before it mints a row.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { HubError } from '../../lib/errors.js';

/** The directory every session of one workspace works in, or under. */
export function workspaceRoot(dataDir: string, profile: string): string {
  return path.join(dataDir, 'workspaces', profile);
}

function refuse(reason: string, details: Record<string, unknown>): never {
  throw new HubError('validation_failed', {
    details: { field: 'working_dir', reason, ...details },
  });
}

/** Create the workspace root if it is not there yet and answer its real path. */
export function ensureRoot(root: string): string {
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

/**
 * The absolute path a `working_dir` names, or a refusal.
 *
 * `requested` may be absolute (it must then be the root or inside it) or
 * relative (joined to the root). Resolution happens against the root's *real*
 * path, and every existing segment between the root and the target is checked
 * with `lstat`: a symlink anywhere on the way is refused rather than followed,
 * so a link planted inside the root cannot lead a run out of it.
 */
export function resolveWorkingDir(root: string, requested: string): string {
  const raw = requested.trim();
  if (raw === '') refuse('empty', { root });
  if (raw.includes('\0')) refuse('invalid', { root });
  const realRoot = ensureRoot(root);
  const target = path.resolve(realRoot, raw);
  if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
    refuse('outside_root', { root: realRoot });
  }
  const relative = path.relative(realRoot, target);
  let walked = realRoot;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    walked = path.join(walked, segment);
    let entry;
    try {
      entry = lstatSync(walked);
    } catch {
      break; // Does not exist yet: everything below it will be created by us.
    }
    if (entry.isSymbolicLink()) refuse('symlink', { root: realRoot });
    if (!entry.isDirectory()) refuse('not_a_directory', { root: realRoot });
  }
  return target;
}

/**
 * Resolve, create and answer the directory this session works in. The generated
 * fallback is the session's own id, which is unique per workspace by
 * construction, so two sessions never share a folder by accident.
 */
export function ensureWorkingDir(root: string, requested: string | null, fallback: string): string {
  const target = resolveWorkingDir(root, requested ?? fallback);
  mkdirSync(target, { recursive: true });
  // One last look after creation: a race that replaced a segment with a link
  // must not leave a run pointing outside the root.
  const real = realpathSync(target);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    refuse('outside_root', { root: realRoot });
  }
  return real;
}

export interface WorkingDirEntry {
  name: string;
  path: string;
}

/** The folders directly under the root, newest activity first. */
export function listWorkingDirs(root: string): { root: string; items: WorkingDirEntry[] } {
  const realRoot = ensureRoot(root);
  const named: Array<WorkingDirEntry & { at: number }> = [];
  for (const entry of readdirSync(realRoot, { withFileTypes: true })) {
    // `isDirectory()` is false for a link to one, and we do not follow links out.
    if (!entry.isDirectory()) continue;
    const full = path.join(realRoot, entry.name);
    let at = 0;
    try {
      at = statSync(full).mtimeMs;
    } catch {
      at = 0;
    }
    named.push({ name: entry.name, path: full, at });
  }
  named.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  return { root: realRoot, items: named.map(({ name, path: full }) => ({ name, path: full })) };
}
