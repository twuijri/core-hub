/**
 * The path rules of the profile's working files (contract decision §65), against a real
 * directory tree: what may be reached, what is refused, and what every operation does to
 * the disk. The HTTP around them is `workspace-files-api.test.ts`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubError } from '../../lib/errors.js';
import { WORKSPACE_FILE_LIMITS, WorkspaceFiles, etagOf, isTextName } from './workspace-files.js';
import { zipStream } from './zip.js';

let data: string;
let root: string;
let files: WorkspaceFiles;

beforeEach(() => {
  // The shape of a real DATA_DIR: the root is one profile's folder, and its neighbours are
  // exactly what must never be reached from it.
  data = mkdtempSync(path.join(tmpdir(), 'corehub-wsfiles-'));
  root = path.join(data, 'workspaces', 'work');
  mkdirSync(path.join(data, 'keys'), { recursive: true });
  writeFileSync(path.join(data, 'keys', 'master.key'), 'secret');
  mkdirSync(path.join(data, 'hermes'), { recursive: true });
  writeFileSync(path.join(data, 'hermes', '.env'), 'OPENAI_API_KEY=sk-live');
  mkdirSync(path.join(data, 'workspaces', 'other'), { recursive: true });
  writeFileSync(path.join(data, 'workspaces', 'other', 'theirs.txt'), 'not yours');
  files = new WorkspaceFiles(root);
  mkdirSync(path.join(root, 'session-1', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'session-1', 'notes.md'), '# Notes\n');
  writeFileSync(path.join(root, 'session-1', 'src', 'app.ts'), 'export const a = 1;\n');
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

/** The refusal an operation throws, as the wire would carry it. */
function refusal(run: () => unknown): { code: string; reason?: string } {
  try {
    run();
  } catch (error) {
    if (!(error instanceof HubError)) throw error;
    const details = (error.details ?? {}) as { reason?: string };
    return { code: error.code, ...(details.reason ? { reason: details.reason } : {}) };
  }
  throw new Error('expected a refusal');
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; reason?: string }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof HubError)) throw error;
    const details = (error.details ?? {}) as { reason?: string };
    return { code: error.code, ...(details.reason ? { reason: details.reason } : {}) };
  }
  throw new Error('expected a refusal');
}

describe('workspace files: the boundary', () => {
  it('refuses a `..` that climbs out, in every operation', () => {
    const outside = { code: 'validation_failed', reason: 'outside_root' };
    expect(refusal(() => files.list('..'))).toEqual(outside);
    expect(refusal(() => files.list('../..'))).toEqual(outside);
    expect(refusal(() => files.open('../../keys/master.key'))).toEqual(outside);
    expect(refusal(() => files.readText('session-1/../../other/theirs.txt'))).toEqual(outside);
    expect(refusal(() => files.writeText('../../hermes/.env', 'x', null))).toEqual(outside);
    expect(refusal(() => files.mkdir('../escape'))).toEqual(outside);
    expect(refusal(() => files.move('session-1/notes.md', '../../keys/stolen.md'))).toEqual(
      outside,
    );
    expect(refusal(() => files.copy('../../keys/master.key', 'copied.key'))).toEqual(outside);
    expect(refusal(() => files.remove('../other'))).toEqual(outside);
    expect(refusal(() => files.archive('../../keys'))).toEqual(outside);
    // Nothing moved on the way.
    expect(readFileSync(path.join(data, 'keys', 'master.key'), 'utf8')).toBe('secret');
    expect(existsSync(path.join(data, 'workspaces', 'other', 'theirs.txt'))).toBe(true);
  });

  it('refuses absolute paths, even ones that point inside the root', () => {
    const absolute = { code: 'validation_failed', reason: 'absolute' };
    expect(refusal(() => files.list('/etc'))).toEqual(absolute);
    expect(refusal(() => files.open(path.join(data, 'keys', 'master.key')))).toEqual(absolute);
    expect(refusal(() => files.list(path.join(root, 'session-1')))).toEqual(absolute);
    expect(refusal(() => files.writeText('/tmp/x.txt', 'x', null))).toEqual(absolute);
    expect(refusal(() => files.list('C:\\Windows'))).toEqual(absolute);
  });

  it('refuses a NUL byte', () => {
    expect(refusal(() => files.open('session-1/notes.md\0.png'))).toEqual({
      code: 'validation_failed',
      reason: 'invalid',
    });
  });

  it('refuses a symlink that leads outside, as a folder on the way or as the file', () => {
    symlinkSync(path.join(data, 'keys'), path.join(root, 'keys-link'));
    symlinkSync(path.join(data, 'hermes', '.env'), path.join(root, 'session-1', 'env-link'));
    symlinkSync(path.join(data, 'workspaces', 'other'), path.join(root, 'other-profile'));
    const escape = { code: 'validation_failed', reason: 'symlink_outside' };
    expect(refusal(() => files.list('keys-link'))).toEqual(escape);
    expect(refusal(() => files.open('keys-link/master.key'))).toEqual(escape);
    expect(refusal(() => files.readText('session-1/env-link'))).toEqual(escape);
    expect(refusal(() => files.open('session-1/env-link'))).toEqual(escape);
    expect(refusal(() => files.list('other-profile'))).toEqual(escape);
    expect(refusal(() => files.writeText('other-profile/theirs.txt', 'mine', null))).toEqual(
      escape,
    );
    expect(refusal(() => files.writeText('keys-link/new.key', 'x', null))).toEqual(escape);
    expect(refusal(() => files.mkdir('keys-link/inner'))).toEqual(escape);
    expect(refusal(() => files.copy('session-1/env-link', 'env-copy'))).toEqual(escape);
    expect(refusal(() => files.move('session-1/notes.md', 'keys-link/notes.md'))).toEqual(escape);
    expect(refusal(() => files.remove('keys-link/master.key'))).toEqual(escape);
    // Writing *through* the link itself is refused, not followed.
    expect(refusal(() => files.writeText('session-1/env-link', 'x', '"x"'))).toEqual({
      code: 'validation_failed',
      reason: 'symlink',
    });
    expect(readFileSync(path.join(data, 'hermes', '.env'), 'utf8')).toBe('OPENAI_API_KEY=sk-live');
    expect(readdirSync(path.join(data, 'keys'))).toEqual(['master.key']);
  });

  it('lists an escaping link as a link that cannot be opened, and a link inside as its target', () => {
    symlinkSync(path.join(data, 'keys'), path.join(root, 'keys-link'));
    symlinkSync(path.join(root, 'session-1'), path.join(root, 'current'));
    const listed = files.list('');
    const byName = new Map(listed.entries.map((entry) => [entry.name, entry]));
    expect(byName.get('keys-link')).toMatchObject({ kind: 'link', link: true, size_bytes: null });
    expect(byName.get('current')).toMatchObject({ kind: 'directory', link: true });
    // A link inside the root is followed for reading.
    expect(files.list('current').entries.map((entry) => entry.name)).toEqual(['src', 'notes.md']);
  });

  it('deletes and moves a link as a link, never what it points at', () => {
    symlinkSync(path.join(data, 'keys'), path.join(root, 'keys-link'));
    files.move('keys-link', 'renamed-link');
    expect(lstatSync(path.join(root, 'renamed-link')).isSymbolicLink()).toBe(true);
    files.remove('renamed-link');
    expect(existsSync(path.join(root, 'renamed-link'))).toBe(false);
    expect(readFileSync(path.join(data, 'keys', 'master.key'), 'utf8')).toBe('secret');
  });

  it('leaves links out of a zip and out of a folder copy', () => {
    symlinkSync(path.join(data, 'keys'), path.join(root, 'session-1', 'keys-link'));
    const names = files.archive('session-1').items.map((item) => item.name);
    expect(names).not.toContain('keys-link');
    expect(names).not.toContain('keys-link/');
    files.copy('session-1', 'session-copy');
    expect(existsSync(path.join(root, 'session-copy', 'keys-link'))).toBe(false);
    expect(existsSync(path.join(root, 'session-copy', 'src', 'app.ts'))).toBe(true);
  });

  it('refuses to delete or move the root itself', () => {
    expect(refusal(() => files.remove(''))).toEqual({ code: 'validation_failed', reason: 'root' });
    expect(refusal(() => files.remove('.'))).toEqual({ code: 'validation_failed', reason: 'root' });
    expect(refusal(() => files.move('', 'elsewhere'))).toEqual({
      code: 'validation_failed',
      reason: 'root',
    });
  });

  it('refuses a folder moved or copied into itself', () => {
    const into = { code: 'validation_failed', reason: 'into_itself' };
    expect(refusal(() => files.move('session-1', 'session-1/src/inner'))).toEqual(into);
    expect(refusal(() => files.copy('session-1', 'session-1/src/inner'))).toEqual(into);
  });
});

describe('workspace files: the caps', () => {
  it('refuses to open or save a text file over the edit cap', () => {
    const big = 'a'.repeat(WORKSPACE_FILE_LIMITS.maxEditBytes + 1);
    writeFileSync(path.join(root, 'big.txt'), big);
    expect(refusal(() => files.readText('big.txt'))).toEqual({ code: 'payload_too_large' });
    expect(refusal(() => files.writeText('new.txt', big, null))).toEqual({
      code: 'payload_too_large',
    });
    expect(existsSync(path.join(root, 'new.txt'))).toBe(false);
    expect(files.describe('big.txt').editable).toBe(false);
  });

  it('refuses an upload over the cap and leaves nothing behind', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    const count = Math.ceil(WORKSPACE_FILE_LIMITS.maxUploadBytes / chunk.length) + 1;
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < count; i += 1) yield chunk;
      })(),
    );
    expect(await refusalOf(() => files.upload('session-1', 'huge.bin', body, false))).toEqual({
      code: 'payload_too_large',
    });
    expect(readdirSync(path.join(root, 'session-1')).sort()).toEqual(['notes.md', 'src']);
  });

  it('refuses a zip or a folder copy over the entry cap before it starts', () => {
    const crowd = path.join(root, 'crowd');
    mkdirSync(crowd);
    for (let i = 0; i <= WORKSPACE_FILE_LIMITS.maxArchiveEntries; i += 1) {
      writeFileSync(path.join(crowd, `f${String(i)}`), '');
    }
    expect(refusal(() => files.archive('crowd'))).toEqual({ code: 'payload_too_large' });
    expect(refusal(() => files.copy('crowd', 'crowd-2'))).toEqual({ code: 'payload_too_large' });
    expect(existsSync(path.join(root, 'crowd-2'))).toBe(false);
  });

  it('lists at most 5000 entries and says so', () => {
    const many = path.join(root, 'many');
    mkdirSync(many);
    for (let i = 0; i < 5003; i += 1) writeFileSync(path.join(many, `n${String(i)}`), '');
    const listed = files.list('many');
    expect(listed.entries).toHaveLength(5000);
    expect(listed.truncated).toBe(true);
  });
});

describe('workspace files: create, read, update, delete', () => {
  it('lists folders first, then files by name, with sizes and times', () => {
    const listed = files.list('session-1');
    expect(listed.path).toBe('session-1');
    expect(listed.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['src', 'directory'],
      ['notes.md', 'file'],
    ]);
    expect(listed.entries[1]).toMatchObject({
      path: 'session-1/notes.md',
      size_bytes: 8,
      mime: 'text/markdown',
      editable: true,
      link: false,
    });
  });

  it('makes the root on first use: an empty profile has an empty folder', () => {
    const fresh = new WorkspaceFiles(path.join(data, 'workspaces', 'brand-new'));
    expect(fresh.list('')).toMatchObject({ path: '', entries: [], truncated: false });
  });

  it('reads text with an etag and saves only against the etag it read', () => {
    const read = files.readText('session-1/notes.md');
    expect(read).toMatchObject({ path: 'session-1/notes.md', content: '# Notes\n' });
    expect(read.etag).toBe(etagOf(Buffer.from('# Notes\n')));

    const saved = files.writeText('session-1/notes.md', '# Notes\n\nmore\n', read.etag);
    expect(saved.etag).not.toBe(read.etag);
    expect(readFileSync(path.join(root, 'session-1', 'notes.md'), 'utf8')).toBe(
      '# Notes\n\nmore\n',
    );

    // An agent writes the file after the editor opened it: the old etag no longer saves.
    writeFileSync(path.join(root, 'session-1', 'notes.md'), 'the agent wrote this');
    try {
      files.writeText('session-1/notes.md', 'my stale text', saved.etag);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(HubError);
      expect((error as HubError).code).toBe('conflict');
      expect((error as HubError).details).toMatchObject({
        reason: 'changed',
        etag: etagOf(Buffer.from('the agent wrote this')),
      });
    }
    expect(readFileSync(path.join(root, 'session-1', 'notes.md'), 'utf8')).toBe(
      'the agent wrote this',
    );
  });

  it('creates a new text file with a null etag, and refuses one that exists', () => {
    const made = files.writeText('session-1/todo.txt', 'one\n', null);
    expect(made.path).toBe('session-1/todo.txt');
    expect(refusal(() => files.writeText('session-1/todo.txt', 'two\n', null))).toEqual({
      code: 'conflict',
      reason: 'exists',
    });
    expect(refusal(() => files.writeText('session-1/gone.txt', 'x', '"old"'))).toEqual({
      code: 'conflict',
      reason: 'changed',
    });
  });

  it('refuses to open a binary file in the editor', () => {
    writeFileSync(path.join(root, 'image.txt'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(refusal(() => files.readText('image.txt'))).toEqual({
      code: 'unsupported_media_type',
      reason: 'binary',
    });
    expect(refusal(() => files.readText('latin1.txt'))).toEqual({
      code: 'unsupported_media_type',
      reason: 'not_utf8',
    });
  });

  it('uploads into a folder, refuses a clash, and overwrites only when asked', async () => {
    const first = await files.upload(
      'session-1',
      'data.csv',
      Readable.from([Buffer.from('a,b\n')]),
      false,
    );
    expect(first).toMatchObject({ path: 'session-1/data.csv', size_bytes: 4, kind: 'file' });
    expect(
      await refusalOf(() =>
        files.upload('session-1', 'data.csv', Readable.from([Buffer.from('c')]), false),
      ),
    ).toEqual({ code: 'conflict', reason: 'exists' });
    await files.upload('session-1', 'data.csv', Readable.from([Buffer.from('c,d\n')]), true);
    expect(readFileSync(path.join(root, 'session-1', 'data.csv'), 'utf8')).toBe('c,d\n');
    // A folder of that name is never replaced by a file.
    expect(
      await refusalOf(() =>
        files.upload('session-1', 'src', Readable.from([Buffer.from('x')]), true),
      ),
    ).toEqual({ code: 'conflict', reason: 'exists' });
    // The name is the file's own, never a path.
    const named = await files.upload(
      '',
      '../../keys/evil.key',
      Readable.from([Buffer.from('x')]),
      false,
    );
    expect(named.path).toBe('evil.key');
    expect(existsSync(path.join(data, 'keys', 'evil.key'))).toBe(false);
    expect(
      await refusalOf(() =>
        files.upload('missing', 'a.txt', Readable.from([Buffer.from('x')]), false),
      ),
    ).toEqual({ code: 'not_found' });
  });

  it('makes folders with their parents, and refuses one that exists', () => {
    const made = files.mkdir('reports/2026/q3');
    expect(made).toMatchObject({ path: 'reports/2026/q3', kind: 'directory' });
    expect(refusal(() => files.mkdir('reports/2026'))).toEqual({
      code: 'conflict',
      reason: 'exists',
    });
    expect(refusal(() => files.mkdir('session-1/notes.md/inner'))).toEqual({
      code: 'validation_failed',
      reason: 'not_a_directory',
    });
  });

  it('renames, moves and copies, never over something that exists', () => {
    expect(files.move('session-1/notes.md', 'session-1/readme.md').path).toBe(
      'session-1/readme.md',
    );
    expect(files.move('session-1/readme.md', 'readme.md').path).toBe('readme.md');
    expect(files.copy('readme.md', 'session-1/readme-copy.md').path).toBe(
      'session-1/readme-copy.md',
    );
    expect(readFileSync(path.join(root, 'session-1', 'readme-copy.md'), 'utf8')).toBe('# Notes\n');
    expect(refusal(() => files.move('readme.md', 'session-1/readme-copy.md'))).toEqual({
      code: 'conflict',
      reason: 'exists',
    });
    expect(refusal(() => files.copy('readme.md', 'session-1'))).toEqual({
      code: 'conflict',
      reason: 'exists',
    });
    expect(refusal(() => files.move('readme.md', 'no-such-folder/readme.md'))).toEqual({
      code: 'not_found',
    });
    const copied = files.copy('session-1', 'session-2');
    expect(copied).toMatchObject({ path: 'session-2', kind: 'directory' });
    expect(readFileSync(path.join(root, 'session-2', 'src', 'app.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
  });

  it('deletes a file, and a folder with everything in it', () => {
    files.remove('session-1/notes.md');
    expect(existsSync(path.join(root, 'session-1', 'notes.md'))).toBe(false);
    files.remove('session-1');
    expect(existsSync(path.join(root, 'session-1'))).toBe(false);
    expect(refusal(() => files.remove('session-1'))).toEqual({ code: 'not_found' });
  });

  it('knows which names are for the editor', () => {
    expect(isTextName('app.ts')).toBe(true);
    expect(isTextName('Makefile')).toBe(true);
    expect(isTextName('.gitignore')).toBe(true);
    expect(isTextName('photo.png')).toBe(false);
    expect(isTextName('report.pdf')).toBe(false);
  });
});

describe('workspace files: the zip', () => {
  /** The entries of a zip as a reader would see them, bytes inflated. */
  function unzip(zip: Buffer): Map<string, Buffer | null> {
    const out = new Map<string, Buffer | null>();
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    for (let i = 0; i < count; i += 1) {
      expect(zip.readUInt32LE(at)).toBe(0x02014b50);
      const method = zip.readUInt16LE(at + 10);
      const crc = zip.readUInt32LE(at + 16);
      const compressed = zip.readUInt32LE(at + 20);
      const nameLength = zip.readUInt16LE(at + 28);
      const offset = zip.readUInt32LE(at + 42);
      const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      const localName = zip.readUInt16LE(offset + 26);
      const start = offset + 30 + localName;
      if (name.endsWith('/')) out.set(name, null);
      else {
        const raw = zip.subarray(start, start + compressed);
        const bytes = method === 8 ? inflateRawSync(raw) : raw;
        expect(crc).toBeGreaterThanOrEqual(0);
        out.set(name, bytes);
      }
      at += 46 + nameLength;
    }
    return out;
  }

  it('zips a folder with its sub-folders and UTF-8 names, readable back', async () => {
    writeFileSync(path.join(root, 'session-1', 'ملاحظات.txt'), 'نص عربي');
    const archive = files.archive('session-1');
    expect(archive.name).toBe('session-1');
    const chunks: Buffer[] = [];
    for await (const chunk of zipStream(archive.items)) chunks.push(chunk as Buffer);
    const entries = unzip(Buffer.concat(chunks));
    expect([...entries.keys()].sort()).toEqual(
      ['notes.md', 'src/', 'src/app.ts', 'ملاحظات.txt'].sort(),
    );
    expect(entries.get('src/app.ts')?.toString()).toBe('export const a = 1;\n');
    expect(entries.get('ملاحظات.txt')?.toString()).toBe('نص عربي');
  });
});
