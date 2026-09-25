/**
 * The files a run changed (decision §49), recorded both ways against real folders: a real
 * temporary git repository (and a worktree of one), and a plain folder with no git. Each
 * case creates, modifies, deletes and renames, and the caps are held.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startChangeTracking, type RunChangesRecord } from './run-changes.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-changes-'));
  folders.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
}

function write(dir: string, file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

/** A file's time pushed into the past, so a change within the same millisecond still shows. */
function age(dir: string, file: string): void {
  const past = new Date(Date.now() - 60_000);
  utimesSync(path.join(dir, file), past, past);
}

function byPath(record: RunChangesRecord) {
  return Object.fromEntries(record.files.map((f) => [f.path, f]));
}

const LINES = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('run changes in a git repository', () => {
  function repo(): string {
    const dir = folder();
    git(dir, 'init', '-q');
    write(dir, 'app.ts', LINES(10));
    write(dir, 'old-name.md', '# عنوان\n\nنص ثابت يكفي ليُعرف بعد النقل.\nسطر آخر.\n');
    write(dir, 'gone.txt', 'bye\n');
    write(dir, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    write(dir, '.gitignore', 'build/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    return dir;
  }

  it('records create, modify, delete, rename and binary against the run start', async () => {
    const dir = repo();
    // Uncommitted before the run: the run's start is the folder as it is, not HEAD.
    write(dir, 'draft.md', 'before the run\n');
    const indexBefore = readFileSync(path.join(dir, '.git', 'index'));

    const tracker = await startChangeTracking(dir);
    expect(tracker?.source).toBe('git');

    write(dir, 'app.ts', LINES(10).replace('line 3\n', 'line three\n') + 'line 11\n');
    write(dir, 'src/new.ts', 'export const a = 1;\nexport const b = 2;\n');
    rmSync(path.join(dir, 'gone.txt'));
    renameSync(path.join(dir, 'old-name.md'), path.join(dir, 'new-name.md'));
    write(dir, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 9, 9, 9]));
    write(dir, 'build/out.js', 'ignored\n');
    write(dir, '.corehub/runs/r1/out/report.txt', 'the hub’s own folder\n');

    const record = await tracker!.finish();
    const files = byPath(record);
    expect(Object.keys(files).sort()).toEqual([
      'app.ts',
      'gone.txt',
      'logo.png',
      'new-name.md',
      'src/new.ts',
    ]);
    expect(files['app.ts']).toMatchObject({ change: 'modified', additions: 2, deletions: 1 });
    expect(files['app.ts']!.diff).toContain('-line 3\n+line three\n');
    expect(files['app.ts']!.diff!.startsWith('@@ -1,')).toBe(true);
    expect(files['src/new.ts']).toMatchObject({ change: 'added', additions: 2, deletions: 0 });
    expect(files['gone.txt']).toMatchObject({ change: 'deleted', additions: 0, deletions: 1 });
    expect(files['new-name.md']).toMatchObject({
      change: 'renamed',
      oldPath: 'old-name.md',
      additions: 0,
      deletions: 0,
    });
    expect(files['logo.png']).toMatchObject({
      change: 'modified',
      binary: true,
      diffState: 'binary',
      additions: null,
      diff: null,
    });
    expect(record).toMatchObject({
      source: 'git',
      complete: true,
      filesChanged: 5,
      additions: 4,
      deletions: 2,
      truncated: false,
    });
    // The person's own index was only read.
    expect(readFileSync(path.join(dir, '.git', 'index'))).toEqual(indexBefore);
    expect(git(dir, 'status', '--porcelain')).toContain('?? draft.md');
  });

  it('works in a worktree, and in a folder inside the repository', async () => {
    const dir = repo();
    const tree = path.join(folder(), 'task-1');
    git(dir, 'worktree', 'add', '-q', '-b', 'task-1', tree);
    const tracker = await startChangeTracking(tree);
    expect(tracker?.source).toBe('git');
    write(tree, 'app.ts', 'rewritten\n');
    const record = await tracker!.finish();
    expect(byPath(record)['app.ts']).toMatchObject({ additions: 1, deletions: 10 });

    // A sub-folder: paths are relative to it, and changes beside it are not its run's.
    write(dir, 'pkg/a.txt', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pkg');
    const inner = await startChangeTracking(path.join(dir, 'pkg'));
    write(dir, 'pkg/a.txt', 'a\nb\n');
    write(dir, 'app.ts', 'outside\n');
    const innerRecord = await inner!.finish();
    expect(innerRecord.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('keeps large untracked files out of the repository and still reports them', async () => {
    const dir = repo();
    write(dir, 'data.bin', Buffer.alloc(4096, 1));
    age(dir, 'data.bin');
    const tracker = await startChangeTracking(dir, { caps: { gitUntrackedMaxBytes: 1024 } });
    write(dir, 'data.bin', Buffer.alloc(5000, 2));
    write(dir, 'huge.csv', 'x,'.repeat(1000));
    const record = await tracker!.finish();
    const files = byPath(record);
    expect(files['data.bin']).toMatchObject({ change: 'modified', diffState: 'too_large' });
    expect(files['huge.csv']).toMatchObject({ change: 'added', diffState: 'too_large' });
    // Neither was hashed into the repository's objects.
    for (const file of ['huge.csv', 'data.bin']) {
      const hashed = git(dir, 'hash-object', '--', file).trim();
      expect(() => git(dir, 'cat-file', '-e', hashed)).toThrow();
    }
  });

  it('holds the caps: files per run, diff bytes per file and per run', async () => {
    const dir = repo();
    const tracker = await startChangeTracking(dir, {
      caps: { maxFiles: 3, diffMaxBytes: 200, runDiffMaxBytes: 300 },
    });
    for (let i = 0; i < 5; i += 1) write(dir, `many/f${i}.txt`, LINES(40, `f${i}`));
    const record = await tracker!.finish();
    expect(record.filesChanged).toBe(5);
    expect(record.additions).toBe(200);
    expect(record.truncated).toBe(true);
    expect(record.files.map((f) => f.path)).toEqual(['many/f0.txt', 'many/f1.txt', 'many/f2.txt']);
    const [first, second, third] = record.files;
    expect(first).toMatchObject({ diffState: 'available', diffTruncated: true });
    expect(Buffer.byteLength(first!.diff!)).toBeLessThanOrEqual(200);
    expect(first!.diff!.endsWith('\n')).toBe(true);
    expect(second!.diffTruncated).toBe(true);
    expect(Buffer.byteLength(second!.diff!)).toBeLessThanOrEqual(
      300 - Buffer.byteLength(first!.diff!),
    );
    expect(third).toMatchObject({ diffState: 'too_large', diff: null });
  });

  it('reads a folder the repository ignores as a plain folder', async () => {
    const dir = repo();
    write(dir, 'build/keep.txt', 'one\n');
    const tracker = await startChangeTracking(path.join(dir, 'build'));
    expect(tracker?.source).toBe('snapshot');
  });
});

describe('run changes without git', () => {
  it('records create, modify, delete and rename from the start snapshot', async () => {
    const dir = folder();
    write(dir, 'notes.md', 'one\ntwo\nthree\n');
    write(dir, 'data.csv', 'a,b\n1,2\n');
    write(dir, 'old.txt', 'moved content that is unique\n');
    write(dir, 'bin.dat', Buffer.from([1, 0, 2, 3]));
    for (const file of ['notes.md', 'data.csv', 'old.txt', 'bin.dat']) age(dir, file);

    const tracker = await startChangeTracking(dir);
    expect(tracker?.source).toBe('snapshot');

    write(dir, 'notes.md', 'one\n2\nthree\nfour\n');
    rmSync(path.join(dir, 'data.csv'));
    renameSync(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));
    write(dir, 'sub/created.py', 'print("مرحبا")\n');
    write(dir, 'bin.dat', Buffer.from([1, 0, 9]));
    write(dir, '.corehub/runs/r/in/x.txt', 'hub\n');

    const record = await tracker!.finish();
    const files = byPath(record);
    expect(Object.keys(files).sort()).toEqual([
      'bin.dat',
      'data.csv',
      'new.txt',
      'notes.md',
      'sub/created.py',
    ]);
    expect(files['notes.md']).toMatchObject({ change: 'modified', additions: 2, deletions: 1 });
    expect(files['notes.md']!.diff).toBe('@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n');
    expect(files['data.csv']).toMatchObject({ change: 'deleted', additions: 0, deletions: 2 });
    expect(files['new.txt']).toMatchObject({ change: 'renamed', oldPath: 'old.txt' });
    expect(files['sub/created.py']).toMatchObject({ change: 'added', additions: 1 });
    expect(files['sub/created.py']!.diff).toBe('@@ -0,0 +1 @@\n+print("مرحبا")\n');
    expect(files['bin.dat']).toMatchObject({ binary: true, diffState: 'binary' });
    expect(record).toMatchObject({ source: 'snapshot', complete: true, filesChanged: 5 });
  });

  it('keeps a file a tool call names when the start could not, and says when none was kept', async () => {
    const dir = folder();
    write(dir, 'big.txt', LINES(50));
    write(dir, 'other.txt', LINES(50));
    write(dir, 'huge.txt', LINES(50));
    for (const file of ['big.txt', 'other.txt', 'huge.txt']) age(dir, file);
    // Nothing kept at the start: only a tool call's `touch` keeps a copy.
    const tracker = await startChangeTracking(dir, {
      caps: { preimageTotalBytes: 0, preimageTouchBytes: 500 },
    });
    tracker!.touch(['big.txt', path.join(dir, 'huge.txt'), '../outside.txt']);
    write(dir, 'big.txt', LINES(50).replace('line 7\n', 'line seven\n'));
    write(dir, 'other.txt', LINES(51));
    write(dir, 'huge.txt', 'short\n');
    const files = byPath(await tracker!.finish());
    expect(files['big.txt']).toMatchObject({ additions: 1, deletions: 1, diffState: 'available' });
    expect(files['big.txt']!.diff).toContain('-line 7\n+line seven\n');
    // Not named by a tool call, or over what was left to keep: changed, but no diff.
    expect(files['other.txt']).toMatchObject({ additions: null, diffState: 'unavailable' });
    expect(files['huge.txt']).toMatchObject({ additions: null, diffState: 'unavailable' });
  });

  it('holds the caps: a partial start, files per run, content size', async () => {
    const dir = folder();
    write(dir, 'top.txt', 'top\n');
    write(dir, 'deep/a.txt', 'a\n');
    age(dir, 'top.txt');
    age(dir, 'deep/a.txt');
    const tracker = await startChangeTracking(dir, {
      caps: { snapshotMaxDepth: 1, maxFiles: 3, contentMaxBytes: 50 },
    });
    // The start did not read `deep/`; a tool call naming a file there keeps it.
    tracker!.touch(['deep/a.txt']);
    write(dir, 'deep/a.txt', 'a\nb\n');
    write(dir, 'created.txt', 'new\n');
    write(dir, 'large.txt', 'x'.repeat(200));
    write(dir, 'z-last.txt', 'z\n');
    const record = await tracker!.finish();
    expect(record.complete).toBe(false);
    expect(record.filesChanged).toBe(4);
    expect(record.truncated).toBe(true);
    const files = byPath(record);
    expect(Object.keys(files)).toEqual(['created.txt', 'deep/a.txt', 'large.txt']);
    expect(files['deep/a.txt']).toMatchObject({ change: 'modified', additions: 1, deletions: 0 });
    expect(files['large.txt']).toMatchObject({ change: 'added', diffState: 'too_large' });
    expect(files['created.txt']).toMatchObject({ change: 'added', additions: 1 });
  });
});
