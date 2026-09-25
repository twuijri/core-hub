/**
 * The files a run changed in its working folder (contract decision §49).
 *
 * The run's start is recorded before the agent is handed the turn, and compared with the
 * folder when the run ends; what differs is written with the run (`run_file_changes`), with
 * its diff, so the answer stays what *this* run did whatever happens to the files later.
 *
 * Two ways to see the start, chosen per run:
 *
 * - **git** — the working folder is inside a git repository or worktree (a task's session
 *   works in its task's worktree). The folder is written to a git tree through a *copy* of the
 *   index (`GIT_INDEX_FILE`), so the person's own index, branch and stash are never touched:
 *   tracked changes and untracked files are included, ignored files are not. Untracked files
 *   over `gitUntrackedMaxBytes` are not hashed into the repository — they are compared by size
 *   and time instead, and their diff is `too_large`. The end is written the same way, and the
 *   two trees are compared by git (`--numstat`, renames with `-M`, one patch per file).
 * - **snapshot** — no git. The folder is read to a bounded depth and count (size and time of
 *   every file), and small text files are kept in memory to diff against. A file a tool call
 *   names that the start did not keep is kept when the call starts (`touch`), if it is still
 *   as it was. The end is read again and each change diffed here (`line-diff.ts`).
 *
 * Both skip the hub's own run folders (`.corehub`) and never follow a symbolic link. Every git
 * call is an argument array with a timeout and an output cap; nothing is run through a shell.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffTexts, isBinary } from './line-diff.js';
import { RUN_FILES_DIR } from './run-files.js';

const KiB = 1024;
const MiB = 1024 * KiB;

export interface ChangeCaps {
  /** Files kept per run (the first by path); the totals still count every one. */
  maxFiles: number;
  /** One file's diff text, cut at a line above it. */
  diffMaxBytes: number;
  /** All the diff text of one run; files past it are `too_large`. */
  runDiffMaxBytes: number;
  /** The largest file diffed in the hub (snapshot); larger ones are counted as changed only. */
  contentMaxBytes: number;
  /** How deep and how wide a snapshot reads the folder. */
  snapshotMaxDepth: number;
  snapshotMaxEntries: number;
  /** A file kept at the start to diff against, and all of them together. */
  preimageMaxBytes: number;
  preimageTotalBytes: number;
  /** Held back for the files tool calls name during the run (`touch`). */
  preimageTouchBytes: number;
  /** Changed files a snapshot counts lines for; past it, files are listed without counts. */
  countMaxFiles: number;
  /** Untracked files larger than this are not written into the repository's objects. */
  gitUntrackedMaxBytes: number;
  /** One git call. */
  gitTimeoutMs: number;
}

export const CHANGE_CAPS: ChangeCaps = {
  maxFiles: 200,
  diffMaxBytes: 256 * KiB,
  runDiffMaxBytes: 2 * MiB,
  contentMaxBytes: 1 * MiB,
  snapshotMaxDepth: 8,
  snapshotMaxEntries: 10_000,
  preimageMaxBytes: 256 * KiB,
  preimageTotalBytes: 8 * MiB,
  preimageTouchBytes: 4 * MiB,
  countMaxFiles: 1000,
  gitUntrackedMaxBytes: 2 * MiB,
  gitTimeoutMs: 20_000,
};

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';
export type DiffState = 'available' | 'binary' | 'too_large' | 'unavailable';

export interface FileChange {
  path: string;
  oldPath: string | null;
  change: FileChangeKind;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  diffState: DiffState;
  diff: string | null;
  diffTruncated: boolean;
}

export interface RunChangesRecord {
  source: 'git' | 'snapshot';
  complete: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  files: FileChange[];
}

export interface ChangeTracker {
  readonly source: 'git' | 'snapshot';
  /** A tool call is about to work on these files (as the agent named them). */
  touch(paths: readonly string[]): void;
  /** Compare the folder now with the start. */
  finish(): Promise<RunChangesRecord>;
}

/** Before the diff text is drawn: a producer, called only for the files kept. */
interface Candidate extends Omit<FileChange, 'diff' | 'diffTruncated'> {
  produce?: (maxBytes: number) => Promise<{ text: string; truncated: boolean } | null>;
}

/**
 * Record the working folder as the run starts it. `null` when there is nothing to record
 * (the folder is gone); a git failure falls back to a snapshot.
 */
export async function startChangeTracking(
  workingDir: string,
  options: { caps?: Partial<ChangeCaps>; now?: () => number } = {},
): Promise<ChangeTracker | null> {
  const caps = { ...CHANGE_CAPS, ...options.caps };
  let root: string;
  try {
    root = realpathSync(workingDir);
  } catch {
    return null;
  }
  const viaGit = await GitTracker.start(root, caps);
  if (viaGit) return viaGit;
  return SnapshotTracker.start(root, caps, options.now ?? Date.now);
}

// ---------------------------------------------------------------- shared

/** Sort, keep the first `maxFiles`, draw their diffs within the run's budget, sum. */
async function recordOf(
  source: 'git' | 'snapshot',
  complete: boolean,
  candidates: Candidate[],
  caps: ChangeCaps,
): Promise<RunChangesRecord> {
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let additions = 0;
  let deletions = 0;
  for (const candidate of candidates) {
    additions += candidate.additions ?? 0;
    deletions += candidate.deletions ?? 0;
  }
  const kept = candidates.slice(0, caps.maxFiles);
  const files: FileChange[] = [];
  let budget = caps.runDiffMaxBytes;
  for (const { produce, ...candidate } of kept) {
    let diff: string | null = null;
    let diffTruncated = false;
    let diffState = candidate.diffState;
    if (diffState === 'available') {
      const limit = Math.min(caps.diffMaxBytes, budget);
      const drawn = produce && limit > 0 ? await produce(limit) : null;
      if (drawn && drawn.truncated && drawn.text === '') {
        diffState = 'too_large'; // not even one line fitted what was left
      } else if (drawn) {
        diff = drawn.text;
        diffTruncated = drawn.truncated;
        budget -= Buffer.byteLength(drawn.text);
      } else {
        diffState = limit > 0 ? 'unavailable' : 'too_large';
      }
    }
    files.push({ ...candidate, diffState, diff, diffTruncated });
  }
  return {
    source,
    complete,
    filesChanged: candidates.length,
    additions,
    deletions,
    truncated: candidates.length > kept.length,
    files,
  };
}

/** A path under `root` as `/`-separated relative, or `null` when it is not inside. */
function relativeInside(root: string, requested: string): string | null {
  const text = requested.trim();
  if (text === '' || text.includes('\0')) return null;
  const absolute = path.resolve(root, text);
  if (!absolute.startsWith(root + path.sep)) return null;
  return path.relative(root, absolute).split(path.sep).join('/');
}

function sha1(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

// ---------------------------------------------------------------- git

interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** Output went past `maxBytes` and the process was stopped. */
  overflow: boolean;
}

/**
 * One git call: an argument array, never a shell; bounded in time and in output. The
 * repository's fsmonitor is off (it would run a program the repository names), paths are
 * printed as they are, and git never prompts.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: { env?: Record<string, string>; input?: string; maxBytes?: number; timeoutMs: number },
): Promise<GitResult> {
  const maxBytes = options.maxBytes ?? 16 * MiB;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          ...options.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: 'spawn failed', overflow: false });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.concat(chunks), stderr, overflow });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, overflow });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

function split0(buffer: Buffer): string[] {
  const text = buffer.toString('utf8');
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

interface Stat {
  size: number;
  mtimeMs: number;
}

interface GitSnapshot {
  tree: string;
  /** Untracked files left out of the tree for their size, compared by stat instead. */
  big: Map<string, Stat>;
}

const EXCLUDE_RUN_FILES = `:(exclude)${RUN_FILES_DIR}`;

class GitTracker implements ChangeTracker {
  readonly source = 'git' as const;

  private constructor(
    private readonly root: string,
    private readonly indexPath: string,
    private readonly start: GitSnapshot,
    private readonly caps: ChangeCaps,
  ) {}

  static async start(root: string, caps: ChangeCaps): Promise<GitTracker | null> {
    const call = (args: string[]) => runGit(root, args, { timeoutMs: caps.gitTimeoutMs });
    const top = await call(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return null;
    const topDir = top.stdout.toString('utf8').trim();
    // A folder the repository ignores (a data folder inside a checkout) has nothing git
    // would see: read it as a folder instead.
    const inside = path.relative(topDir, root);
    if (inside !== '' && !inside.startsWith('..')) {
      const ignored = await call([
        'check-ignore',
        '-q',
        '--',
        `${inside.split(path.sep).join('/')}/`,
      ]);
      if (ignored.code === 0) return null;
    }
    const index = await call(['rev-parse', '--git-path', 'index']);
    if (index.code !== 0) return null;
    const indexPath = path.resolve(root, index.stdout.toString('utf8').trim());
    const start = await gitSnapshot(root, indexPath, caps);
    return start ? new GitTracker(root, indexPath, start, caps) : null;
  }

  touch(): void {
    // Git sees the whole folder at both ends; nothing to keep in advance.
  }

  async finish(): Promise<RunChangesRecord> {
    const { root, caps } = this;
    const end = await gitSnapshot(root, this.indexPath, caps);
    if (!end) throw new Error('git: the folder could not be written as a tree at the end');
    const base = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-z',
      '-M',
      '--relative',
      this.start.tree,
      end.tree,
    ];
    const [names, counts] = await Promise.all([
      runGit(root, [...base, '--name-status'], { timeoutMs: caps.gitTimeoutMs }),
      runGit(root, [...base, '--numstat'], { timeoutMs: caps.gitTimeoutMs }),
    ]);
    if (names.code !== 0 || counts.code !== 0 || names.overflow || counts.overflow) {
      throw new Error(`git diff failed: ${names.stderr || counts.stderr}`);
    }
    const byPath = new Map<string, Candidate>();
    const tokens = split0(names.stdout);
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++] ?? '';
      const letter = status[0];
      if (letter === 'R' || letter === 'C') {
        const oldPath = tokens[i++] ?? '';
        const newPath = tokens[i++] ?? '';
        byPath.set(
          newPath,
          candidate(newPath, letter === 'R' ? oldPath : null, letter === 'R' ? 'renamed' : 'added'),
        );
        continue;
      }
      const file = tokens[i++] ?? '';
      const change: FileChangeKind =
        letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
      byPath.set(file, candidate(file, null, change));
    }
    const numbers = split0(counts.stdout);
    for (let i = 0; i < numbers.length;) {
      const [added = '', removed = '', named = ''] = (numbers[i++] ?? '').split('\t');
      let file = named;
      if (named === '') {
        i += 1; // the old path of a rename
        file = numbers[i++] ?? '';
      }
      const entry = byPath.get(file);
      if (!entry) continue;
      if (added === '-' || removed === '-') {
        entry.binary = true;
        entry.diffState = 'binary';
        entry.additions = null;
        entry.deletions = null;
      } else {
        entry.additions = Number(added) || 0;
        entry.deletions = Number(removed) || 0;
      }
    }
    this.reconcileBig(byPath, end.big);
    for (const entry of byPath.values()) {
      if (entry.diffState !== 'available') continue;
      entry.produce = (maxBytes) => this.patch(end.tree, entry, maxBytes);
    }
    return recordOf('git', true, [...byPath.values()], caps);
  }

  /** Files too large to hash: a tree says they vanished or appeared; their stat says what. */
  private reconcileBig(byPath: Map<string, Candidate>, endBig: Map<string, Stat>): void {
    const startBig = this.start.big;
    const large = (file: string, change: FileChangeKind): Candidate => ({
      ...candidate(file, null, change),
      additions: null,
      deletions: null,
      diffState: 'too_large',
    });
    for (const [file, entry] of byPath) {
      if (entry.change === 'deleted' && endBig.has(file)) byPath.set(file, large(file, 'modified'));
      else if (entry.change === 'added' && startBig.has(file))
        byPath.set(file, large(file, 'modified'));
    }
    for (const [file, stat] of endBig) {
      if (byPath.has(file)) continue;
      const before = startBig.get(file);
      if (!before) byPath.set(file, large(file, 'added'));
      else if (before.size !== stat.size || before.mtimeMs !== stat.mtimeMs)
        byPath.set(file, large(file, 'modified'));
    }
    for (const file of startBig.keys()) {
      if (byPath.has(file) || endBig.has(file)) continue;
      if (!statOf(path.join(this.root, file))) byPath.set(file, large(file, 'deleted'));
    }
  }

  private async patch(
    endTree: string,
    entry: Candidate,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean } | null> {
    const specs = [`:(literal)${entry.path}`];
    if (entry.oldPath) specs.push(`:(literal)${entry.oldPath}`);
    const result = await runGit(
      this.root,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-M',
        '--relative',
        '-U3',
        this.start.tree,
        endTree,
        '--',
        ...specs,
      ],
      { timeoutMs: this.caps.gitTimeoutMs, maxBytes: maxBytes + 64 * KiB },
    );
    if (result.code !== 0 && !result.overflow) return null;
    const text = result.stdout.toString('utf8');
    const at = text.startsWith('@@') ? 0 : text.indexOf('\n@@');
    if (at < 0) return { text: '', truncated: false }; // a rename with nothing else changed
    return capText(text.slice(at === 0 ? 0 : at + 1), maxBytes, result.overflow);
  }
}

function candidate(file: string, oldPath: string | null, change: FileChangeKind): Candidate {
  return {
    path: file,
    oldPath,
    change,
    additions: 0,
    deletions: 0,
    binary: false,
    diffState: 'available',
  };
}

/** Keep whole lines up to `maxBytes`. */
function capText(
  text: string,
  maxBytes: number,
  cut: boolean,
): { text: string; truncated: boolean } {
  if (!cut && Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  const end = bytes.lastIndexOf(0x0a);
  return { text: bytes.subarray(0, end + 1).toString('utf8'), truncated: true };
}

function statOf(file: string): Stat | null {
  try {
    const stats = lstatSync(file);
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * The folder as a git tree, through a copy of the index: `add -A` on the copy stages every
 * change under the folder (deletions too), `write-tree` names the result. The repository's own
 * index is only read.
 */
async function gitSnapshot(
  root: string,
  indexPath: string,
  caps: ChangeCaps,
): Promise<GitSnapshot | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'corehub-changes-'));
  try {
    const temporaryIndex = path.join(dir, 'index');
    try {
      await copyFile(indexPath, temporaryIndex);
    } catch {
      // No index yet (a repository without a first commit): git starts an empty one.
    }
    const env = { GIT_INDEX_FILE: temporaryIndex };
    const others = await runGit(
      root,
      ['ls-files', '-z', '--others', '--exclude-standard', '--', '.', EXCLUDE_RUN_FILES],
      { env, timeoutMs: caps.gitTimeoutMs, maxBytes: 32 * MiB },
    );
    if (others.code !== 0 || others.overflow) return null;
    const big = new Map<string, Stat>();
    for (const file of split0(others.stdout)) {
      const stat = statOf(path.join(root, file));
      if (stat && stat.size > caps.gitUntrackedMaxBytes) big.set(file, stat);
    }
    const specs = ['.', EXCLUDE_RUN_FILES, ...[...big.keys()].map((f) => `:(exclude,literal)${f}`)];
    const added = await runGit(
      root,
      ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { env, input: `${specs.join('\0')}\0`, timeoutMs: caps.gitTimeoutMs },
    );
    // `--ignore-errors` answers 1 when a file could not be read; the rest is still staged.
    if (added.code !== 0 && added.code !== 1) return null;
    const tree = await runGit(root, ['write-tree'], { env, timeoutMs: caps.gitTimeoutMs });
    if (tree.code !== 0) return null;
    return { tree: tree.stdout.toString('utf8').trim(), big };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- snapshot

const SNAPSHOT_SKIP = new Set(['.git', RUN_FILES_DIR, 'node_modules', '__pycache__']);

interface Kept {
  /** The bytes of a text file; `null` for a binary one (its hash still pairs a rename). */
  text: string | null;
  hash: string;
}

/** Every regular file under `root`, bounded; `complete` is false when a cap was hit. */
function readFolder(
  root: string,
  caps: ChangeCaps,
): { files: Map<string, Stat>; complete: boolean } {
  const files = new Map<string, Stat>();
  let seen = 0;
  let complete = true;
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= caps.snapshotMaxEntries) {
        complete = false;
        return;
      }
      seen += 1;
      if (entry.isSymbolicLink() || SNAPSHOT_SKIP.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= caps.snapshotMaxDepth) complete = false;
        else walk(full, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statOf(full);
      if (stat) files.set(relative, stat);
    }
  };
  walk(root, '', 1);
  return { files, complete };
}

function readSmall(file: string, maxBytes: number): Buffer | null {
  const stat = statOf(file);
  if (!stat || stat.size > maxBytes) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

class SnapshotTracker implements ChangeTracker {
  readonly source = 'snapshot' as const;
  private readonly kept = new Map<string, Kept>();
  /** What is left to keep copies with: at the start, and for `touch` during the run. */
  private readonly budget: { start: number; touch: number };

  private constructor(
    private readonly root: string,
    private readonly caps: ChangeCaps,
    private readonly startedAt: number,
    private readonly files: Map<string, Stat>,
    private readonly complete: boolean,
  ) {
    this.budget = { start: caps.preimageTotalBytes, touch: caps.preimageTouchBytes };
  }

  static start(root: string, caps: ChangeCaps, now: () => number): SnapshotTracker {
    const startedAt = now();
    const { files, complete } = readFolder(root, caps);
    const tracker = new SnapshotTracker(root, caps, startedAt, files, complete);
    // The most recently changed first: the likeliest to be changed again.
    const order = [...files.entries()].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
    for (const [file, stat] of order) {
      if (tracker.budget.start <= 0) break;
      if (stat.size <= caps.preimageMaxBytes) tracker.keep(file, 'start');
    }
    return tracker;
  }

  /** Keep a copy of `file` as it is now, within the pool's budget. */
  private keep(file: string, pool: 'start' | 'touch'): void {
    if (this.kept.has(file)) return;
    const bytes = readSmall(path.join(this.root, file), this.caps.preimageMaxBytes);
    if (!bytes || bytes.length > this.budget[pool]) return;
    const binary = isBinary(bytes);
    this.kept.set(file, { text: binary ? null : bytes.toString('utf8'), hash: sha1(bytes) });
    this.budget[pool] -= bytes.length;
  }

  touch(paths: readonly string[]): void {
    for (const requested of paths) {
      const file = relativeInside(this.root, requested);
      if (!file || this.kept.has(file)) continue;
      if (file.split('/').some((part) => SNAPSHOT_SKIP.has(part))) continue;
      const now = statOf(path.join(this.root, file));
      if (!now) continue; // not there yet: the run creates it
      const before = this.files.get(file);
      if (before) {
        // Kept only while it is still what the start saw.
        if (before.size === now.size && before.mtimeMs === now.mtimeMs) this.keep(file, 'touch');
      } else if (!this.complete && now.mtimeMs < this.startedAt) {
        // Beyond what the start read, and older than the run: it was there before.
        this.files.set(file, now);
        this.keep(file, 'touch');
      }
    }
  }

  async finish(): Promise<RunChangesRecord> {
    const { root, caps } = this;
    const end = readFolder(root, caps);
    const deleted: string[] = [];
    const modified: string[] = [];
    const added: string[] = [];
    for (const [file, before] of this.files) {
      const after = end.files.get(file) ?? (end.complete ? null : statOf(path.join(root, file)));
      if (!after) deleted.push(file);
      else if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) modified.push(file);
    }
    for (const [file, after] of end.files) {
      if (this.files.has(file)) continue;
      // With a partial start, only what changed during the run can be called new.
      if (this.complete || after.mtimeMs >= this.startedAt - 2000) added.push(file);
    }

    const readNow = (file: string) => readSmall(path.join(root, file), caps.contentMaxBytes);
    const candidates: Candidate[] = [];
    // A deleted file whose exact bytes appeared under another name was moved.
    const addedBytes = new Map<string, Buffer | null>();
    const byHash = new Map<string, string>();
    for (const file of added) {
      const bytes = readNow(file);
      addedBytes.set(file, bytes);
      if (bytes) byHash.set(sha1(bytes), file);
    }
    const renamedTo = new Set<string>();
    for (const file of deleted) {
      const before = this.kept.get(file);
      const target = before ? byHash.get(before.hash) : undefined;
      if (target && !renamedTo.has(target)) {
        renamedTo.add(target);
        const binary = before!.text === null;
        candidates.push({
          path: target,
          oldPath: file,
          change: 'renamed',
          additions: binary ? null : 0,
          deletions: binary ? null : 0,
          binary,
          diffState: binary ? 'binary' : 'available',
          produce: async () => ({ text: '', truncated: false }),
        });
        continue;
      }
      candidates.push(this.compare(file, 'deleted', before ?? null, null, false));
    }
    for (const file of modified) {
      candidates.push(
        this.compare(file, 'modified', this.kept.get(file) ?? null, readNow(file), true),
      );
    }
    for (const file of added) {
      if (renamedTo.has(file)) continue;
      candidates.push(this.compare(file, 'added', null, addedBytes.get(file) ?? null, true));
    }
    return recordOf('snapshot', this.complete, candidates, caps);
  }

  private counted = 0;

  /** One change, counted and diffed here when both sides are text the hub holds. */
  private compare(
    file: string,
    change: 'added' | 'modified' | 'deleted',
    before: Kept | null,
    after: Buffer | null,
    exists: boolean,
  ): Candidate {
    const base = { path: file, oldPath: null, change };
    const binary = (before !== null && before.text === null) || (after !== null && isBinary(after));
    if (binary) {
      return { ...base, additions: null, deletions: null, binary: true, diffState: 'binary' };
    }
    const beforeKnown = change === 'added' || before !== null;
    const afterKnown = !exists || after !== null;
    if (!beforeKnown || !afterKnown) {
      return {
        ...base,
        additions: null,
        deletions: null,
        binary: false,
        diffState: afterKnown ? 'unavailable' : 'too_large',
      };
    }
    if (this.counted >= this.caps.countMaxFiles) {
      return { ...base, additions: null, deletions: null, binary: false, diffState: 'too_large' };
    }
    this.counted += 1;
    const oldText = before?.text ?? null;
    // Counted now, drawn later for the kept files only: the text is read again then rather
    // than held for every changed file.
    const counted = diffTexts(oldText, after ? after.toString('utf8') : null, 0);
    return {
      ...base,
      additions: counted.additions,
      deletions: counted.deletions,
      binary: false,
      diffState: counted.text === null ? 'too_large' : 'available',
      produce: async (maxBytes) => {
        const now = exists
          ? readSmall(path.join(this.root, file), this.caps.contentMaxBytes)
          : null;
        if (exists && !now) return null;
        const drawn = diffTexts(oldText, now ? now.toString('utf8') : null, maxBytes);
        return drawn.text === null ? null : { text: drawn.text, truncated: drawn.truncated };
      },
    };
  }
}
