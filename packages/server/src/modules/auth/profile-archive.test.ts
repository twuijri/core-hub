import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { ArchiveError, TarFilter, isCredentialFile, rewriteArchive } from './profile-archive.js';
import { tar, tarGz } from './testing/tar.js';

const root = mkdtempSync(path.join(tmpdir(), 'corehub-archive-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const file = (bytes: Buffer): string => {
  counter += 1;
  const target = path.join(root, `in-${counter}.tar.gz`);
  writeFileSync(target, bytes);
  return target;
};
const out = (): string => {
  counter += 1;
  return path.join(root, `out-${counter}.tar.gz`);
};

/** Unpacks with the system's own tar: the output must be a tar every tool reads. */
function unpack(archive: string): string {
  counter += 1;
  const dir = path.join(root, `x-${counter}`);
  mkdirSync(dir);
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  return dir;
}
const listing = (archive: string): string[] =>
  execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/\/$/, ''))
    .sort();

const KEY = 'sk-test-0123456789abcdefghij';

describe('rewriteArchive', () => {
  it('leaves credential files out at any depth, masks stored keys anywhere, keeps the rest byte for byte', async () => {
    const soul = 'I am the designer. مرحبًا.\n';
    const source = file(
      tarGz([
        { path: 'design' },
        { path: 'design/SOUL.md', content: soul },
        { path: 'design/.env', content: `OPENAI_API_KEY=${KEY}\n` },
        { path: 'design/skills' },
        { path: 'design/skills/tool/auth.json', content: '{"token":"x"}' },
        { path: 'design/memories/MEMORY.md', content: `remember ${KEY} and ${KEY}.` },
        // A key in a binary file (a SQLite page, say) is overwritten too.
        {
          path: 'design/state.db',
          content: Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY), Buffer.from([255])]),
        },
      ]),
    );
    const target = out();
    const report = await rewriteArchive(source, target, {
      drop: isCredentialFile,
      secrets: [KEY, 'short'],
    });

    expect(report.roots).toEqual(['design']);
    expect(report.removed.sort()).toEqual(['design/.env', 'design/skills/tool/auth.json']);
    expect(report.masked.sort()).toEqual(['design/memories/MEMORY.md', 'design/state.db']);
    expect(report.unsupported).toEqual([]);
    expect(report.unsafe).toEqual([]);

    expect(listing(target)).toEqual([
      'design',
      'design/SOUL.md',
      'design/memories/MEMORY.md',
      'design/skills',
      'design/state.db',
    ]);
    const dir = unpack(target);
    expect(readFileSync(path.join(dir, 'design/SOUL.md'), 'utf8')).toBe(soul);
    const memory = readFileSync(path.join(dir, 'design/memories/MEMORY.md'), 'utf8');
    expect(memory).not.toContain(KEY);
    expect(memory).toBe(`remember ${'*'.repeat(KEY.length)} and ${'*'.repeat(KEY.length)}.`);
    const db = readFileSync(path.join(dir, 'design/state.db'));
    expect(db.length).toBe(KEY.length + 4);
    expect(db.includes(Buffer.from(KEY))).toBe(false);
  });

  it('finds a key that straddles two chunks of the stream', async () => {
    // gunzip hands the filter 16 KiB chunks; after the 512-byte header the key starts five
    // bytes before the first edge.
    const filler = 'a'.repeat(16 * 1024 - 512 - 5);
    const body = `${filler}${KEY}${'b'.repeat(70_000)}${KEY}`;
    const target = out();
    const report = await rewriteArchive(
      file(tarGz([{ path: 'p/big.txt', content: body }])),
      target,
      { secrets: [KEY] },
    );
    expect(report.masked).toEqual(['p/big.txt']);
    const text = readFileSync(path.join(unpack(target), 'p/big.txt'), 'utf8');
    expect(text.length).toBe(body.length);
    expect(text).not.toContain(KEY);
  });

  it('masks the same way however the tar arrives, seven bytes at a time or all at once', async () => {
    const body = `x${KEY}y${KEY}`;
    const whole = tar([
      { path: 'p/.env', content: KEY },
      { path: 'p/a.txt', content: body },
    ]);
    const run = async (size: number) => {
      const filter = new TarFilter({ drop: isCredentialFile, secrets: [KEY] });
      const chunks: Buffer[] = [];
      filter.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise((resolve, reject) => {
        filter.on('end', resolve);
        filter.on('error', reject);
      });
      for (let at = 0; at < whole.length; at += size) filter.write(whole.subarray(at, at + size));
      filter.end();
      await done;
      return { bytes: Buffer.concat(chunks), report: filter.report() };
    };
    const small = await run(7);
    const large = await run(whole.length);
    expect(small.bytes.equals(large.bytes)).toBe(true);
    expect(small.report.masked).toEqual(['p/a.txt']);
    expect(small.report.removed).toEqual(['p/.env']);
    expect(small.bytes.includes(Buffer.from(KEY))).toBe(false);
    expect(small.bytes.length).toBe(whole.length - 1024);
  });

  it('follows GNU long names: a dropped long-named file takes its name entry with it', async () => {
    const deep = `p/${'folder-with-a-long-name/'.repeat(5)}`;
    const target = out();
    const report = await rewriteArchive(
      file(
        tarGz([
          { path: `${deep}notes.md`, content: 'kept' },
          { path: `${deep}.env`, content: `KEY=${KEY}` },
        ]),
      ),
      target,
      { drop: isCredentialFile },
    );
    expect(report.removed).toEqual([`${deep}.env`]);
    expect(listing(target)).toEqual([`${deep}notes.md`]);
  });

  it('reads what the system tar writes, in GNU and PAX formats', async () => {
    const tree = path.join(root, 'tree');
    mkdirSync(path.join(tree, 'work', 'memories'), { recursive: true });
    writeFileSync(path.join(tree, 'work', 'SOUL.md'), `soul ${KEY}`);
    writeFileSync(path.join(tree, 'work', '.env'), `K=${KEY}`);
    writeFileSync(path.join(tree, 'work', 'memories', 'ملاحظة.md'), 'عربي');
    for (const format of ['gnu', 'pax']) {
      const source = path.join(root, `system-${format}.tar.gz`);
      execFileSync('tar', [`--format=${format}`, '-czf', source, '-C', tree, 'work']);
      const target = out();
      const report = await rewriteArchive(source, target, {
        drop: isCredentialFile,
        secrets: [KEY],
      });
      expect(report.roots).toEqual(['work']);
      expect(report.removed).toEqual(['work/.env']);
      expect(report.masked).toEqual(['work/SOUL.md']);
      expect(listing(target)).toContain('work/memories/ملاحظة.md');
    }
  });

  it('says what is wrong with a file that is not a profile archive', async () => {
    const notGzip = file(Buffer.from('plain text, not an archive'));
    await expect(rewriteArchive(notGzip, null)).rejects.toMatchObject({ reason: 'not_gzip' });

    const notTar = file(gzipSync(Buffer.alloc(2048, 7)));
    await expect(rewriteArchive(notTar, null)).rejects.toMatchObject({ reason: 'not_tar' });

    const whole = tar([{ path: 'p/a.txt', content: 'x'.repeat(3000) }]);
    const cut = file(gzipSync(whole.subarray(0, 1024)));
    await expect(rewriteArchive(cut, null)).rejects.toBeInstanceOf(ArchiveError);

    const bomb = file(tarGz([{ path: 'p/zeros', content: Buffer.alloc(200_000) }]));
    await expect(rewriteArchive(bomb, null, { maxUnpackedBytes: 100_000 })).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('reports two roots, links and paths that climb out, without writing anything', async () => {
    const report = await rewriteArchive(
      file(
        tarGz([
          { path: 'one/a.md', content: 'a' },
          { path: 'two/b.md', content: 'b' },
          { path: 'one/link', type: '2', linkTarget: '/etc/passwd' },
          { path: 'one/../../escape.md', content: 'x' },
        ]),
      ),
      null,
    );
    expect(report.roots).toEqual(['one', 'two']);
    expect(report.unsupported).toEqual(['one/link']);
    expect(report.unsafe).toEqual(['one/../../escape.md']);
    expect(report.entries).toBe(4);
  });
});
