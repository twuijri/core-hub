/**
 * A minimal tar writer for tests and the e2e hub: enough to build a profile archive the way
 * Hermes lays one out (one top-level folder, GNU long names), and a few malformed ones.
 * Never used by the running hub, which only reads archives (`../profile-archive.ts`).
 */
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  path: string;
  /** File content; omit for a folder. */
  content?: string | Buffer;
  /** `0` file (default with content), `5` folder (default without), `2` symlink. */
  type?: '0' | '5' | '2';
  linkTarget?: string;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, type: string, linkTarget = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 99), 0, 'utf8');
  block.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'latin1');
  block.write(octal(0, 8), 108, 'latin1');
  block.write(octal(0, 8), 116, 'latin1');
  block.write(octal(size, 12), 124, 'latin1');
  block.write(octal(1_700_000_000, 12), 136, 'latin1');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 'latin1');
  block.write(linkTarget.slice(0, 99), 157, 'utf8');
  // GNU magic, as Hermes's `tarfile.GNU_FORMAT` writes it.
  block.write('ustar  \0', 257, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

/** An uncompressed tar of `entries`, long names as GNU `L` entries. */
export function tar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? (entry.content === undefined ? '5' : '0');
    const name = type === '5' && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    const data =
      entry.content === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content, 'utf8');
    if (Buffer.byteLength(name) > 99) {
      const long = Buffer.from(`${name}\0`, 'utf8');
      parts.push(header('././@LongLink', long.length, 'L'), ...padded(long));
    }
    parts.push(header(name, type === '0' ? data.length : 0, type, entry.linkTarget ?? ''));
    if (type === '0' && data.length > 0) parts.push(...padded(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** `tar(entries)`, gzip-compressed: what `hermes profile export` writes. */
export function tarGz(entries: readonly TarEntry[]): Buffer {
  return gzipSync(tar(entries));
}
