/**
 * The two folders one run exchanges files through.
 *
 *   <session.working_dir>/.majlis/runs/<run id>/in    what the person attached
 *   <session.working_dir>/.majlis/runs/<run id>/out   what the agent wrote back
 *
 * Why per run, and why hidden:
 *
 * - **Per run** is what makes "what did this turn produce" answerable at all. A shared
 *   folder would make the hub re-offer yesterday's file on every reply, or force it to
 *   diff the whole working directory — the thing this module exists not to do.
 * - **Hidden** (`.majlis/`) keeps a working directory that is also a git checkout
 *   readable: the agent's own files stay where the person put them.
 *
 * The output side is watched, not scanned: `fs.watch` on that one folder tells us a
 * name appeared, and a single `readdir` at the end of the run reconciles it. The whole
 * tree is never walked, on any event. The caps below are applied at collection and
 * what they refused is reported, never silently dropped — `collect()` answers both.
 */
import { derived } from '@majlis/contracts';
import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/**
 * What one turn may hand back.
 *
 * These are `sessions`' policy, not `knowledge`'s: they decide how much of a run's
 * output is *offered* on the reply. `knowledge` keeps its own ceiling on a single
 * stored file, and refuses independently — a module never trusts another's limit.
 */
export const MAX_PRODUCED_FILES = 20;
export const MAX_PRODUCED_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PRODUCED_TOTAL_BYTES = 100 * 1024 * 1024;
/** How deep the output folder is read; deeper files are named in the refusal. */
export const MAX_PRODUCED_DEPTH = 3;

/** The folder name under a working directory that belongs to the hub. */
export const RUN_FILES_DIR = derived.runFilesDir;

export interface RunFolders {
  /** Where the person's attachments were copied. */
  in: string;
  /** Where the agent is told to write anything it wants the person to have. */
  out: string;
}

export function runFolders(workingDir: string, runId: string): RunFolders {
  const base = path.join(workingDir, RUN_FILES_DIR, 'runs', runId);
  return { in: path.join(base, 'in'), out: path.join(base, 'out') };
}

/** Create both folders. Returns them; throws only when the disk refuses. */
export function ensureRunFolders(workingDir: string, runId: string): RunFolders {
  const folders = runFolders(workingDir, runId);
  mkdirSync(folders.in, { recursive: true });
  mkdirSync(folders.out, { recursive: true });
  return folders;
}

export interface ProducedFile {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the output folder, `/`-separated. */
  relativePath: string;
  sizeBytes: number;
}

export interface ProducedRefusal {
  relativePath: string;
  reason: 'too_many' | 'too_large' | 'total_too_large' | 'too_deep';
  sizeBytes: number;
}

export interface ProducedFiles {
  files: ProducedFile[];
  refused: ProducedRefusal[];
}

export interface OutputCaps {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
}

/**
 * Watches one run's output folder for the life of the run.
 *
 * `fs.watch` is a hint, not the source of truth: it is not recursive on Linux, it can
 * coalesce events and it can be unavailable entirely. So it is used for exactly one
 * thing — noticing early that the run has already produced more than it may — and the
 * answer always comes from `collect()`.
 */
export class OutputWatcher {
  private watcher: FSWatcher | null = null;
  private readonly seen = new Set<string>();
  private overflowed = false;

  constructor(
    readonly directory: string,
    private readonly caps: OutputCaps = {},
  ) {}

  private get maxFiles(): number {
    return this.caps.maxFiles ?? MAX_PRODUCED_FILES;
  }

  start(): this {
    try {
      this.watcher = watch(this.directory, { persistent: false }, (_event, filename) => {
        if (typeof filename !== 'string' || filename === '') return;
        this.seen.add(filename);
        if (this.seen.size > this.maxFiles) this.overflowed = true;
      });
      this.watcher.on('error', () => this.stop());
    } catch {
      // No watcher on this platform or the folder went away: `collect()` still answers.
      this.watcher = null;
    }
    return this;
  }

  /** Names the watcher noticed while the run was live (diagnostics and the cap hint). */
  noticed(): string[] {
    return [...this.seen];
  }

  /** True as soon as more names appeared than a run may hand back. */
  get sawTooMany(): boolean {
    return this.overflowed;
  }

  stop(): void {
    try {
      this.watcher?.close();
    } catch {
      // Closing twice is fine.
    }
    this.watcher = null;
  }

  /** One read of the folder, capped. Stops the watcher. */
  collect(): ProducedFiles {
    this.stop();
    return collectOutputs(this.directory, this.caps);
  }
}

/**
 * Read one output folder, newest last, applying the caps.
 *
 * Symbolic links are skipped: an agent that links to `/etc/shadow` must not have the
 * hub copy it into a downloadable attachment.
 */
export function collectOutputs(directory: string, caps: OutputCaps = {}): ProducedFiles {
  const maxFiles = caps.maxFiles ?? MAX_PRODUCED_FILES;
  const maxFileBytes = caps.maxFileBytes ?? MAX_PRODUCED_FILE_BYTES;
  const maxTotalBytes = caps.maxTotalBytes ?? MAX_PRODUCED_TOTAL_BYTES;
  const maxDepth = caps.maxDepth ?? MAX_PRODUCED_DEPTH;

  const found: ProducedFile[] = [];
  const refused: ProducedRefusal[] = [];

  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) {
          refused.push({ relativePath, reason: 'too_deep', sizeBytes: 0 });
          continue;
        }
        walk(full, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let sizeBytes: number;
      try {
        sizeBytes = statSync(full).size;
      } catch {
        continue;
      }
      found.push({ path: full, relativePath, sizeBytes });
    }
  };
  walk(directory, '', 1);

  const files: ProducedFile[] = [];
  let total = 0;
  for (const file of found) {
    if (files.length >= maxFiles) {
      refused.push({
        relativePath: file.relativePath,
        reason: 'too_many',
        sizeBytes: file.sizeBytes,
      });
      continue;
    }
    if (file.sizeBytes > maxFileBytes) {
      refused.push({
        relativePath: file.relativePath,
        reason: 'too_large',
        sizeBytes: file.sizeBytes,
      });
      continue;
    }
    if (total + file.sizeBytes > maxTotalBytes) {
      refused.push({
        relativePath: file.relativePath,
        reason: 'total_too_large',
        sizeBytes: file.sizeBytes,
      });
      continue;
    }
    total += file.sizeBytes;
    files.push(file);
  }
  return { files, refused };
}
