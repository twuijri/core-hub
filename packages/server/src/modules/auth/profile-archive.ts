/**
 * A Hermes profile archive, read and rewritten by the hub on its way through (ADR 0014
 * stage 2).
 *
 * Hermes writes a profile as a gzip-compressed tar with one top-level folder named after
 * the profile (`hermes_cli/archive_safe.py` §make_targz, GNU format). The hub never trusts
 * that blindly in either direction:
 *
 * - **On export** it copies the archive entry by entry, leaving out every credential file
 *   (`.env`, `auth.json` — Hermes already does, this is the second lock) and overwriting
 *   every provider key the hub stores wherever its bytes appear, in any file (ADR 0010: a
 *   key typed into the hub never leaves it in an archive). The overwrite keeps the length,
 *   so every tar header stays valid.
 * - **On import** it reads the upload once to say, before Hermes is asked, whether it is a
 *   profile archive at all: gzip, tar, one top-level folder, only folders and regular files
 *   (Hermes's extractor refuses links and devices), no absolute or `..` paths.
 *
 * Everything streams — gunzip, one tar block at a time, gzip — so an archive the size of a
 * profile's chat history is never held in memory. A tar is a run of 512-byte blocks: a
 * header, the entry's bytes padded to a block, and two zero blocks at the end. GNU long
 * names (`L`/`K`) and PAX headers (`x`/`g`) are metadata entries that describe the next one;
 * they travel with it, or are dropped with it.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const BLOCK = 512;
/** The byte a masked secret is overwritten with. */
const MASK = 0x2a; // '*'
/** A metadata entry (long name, PAX record) larger than this is not a profile archive. */
const MAX_META_BYTES = 1024 * 1024;
/** How many paths a report lists before it stops counting names (the count stays exact). */
const REPORT_LIMIT = 100;
/** The credential files Hermes leaves out of a named profile's export (`profiles.py`). */
export const CREDENTIAL_FILES: ReadonlySet<string> = new Set(['.env', 'auth.json']);

export type ArchiveProblem = 'not_gzip' | 'not_tar' | 'truncated' | 'too_large';

/** The file is not an archive the hub can read; `reason` says which way. */
export class ArchiveError extends Error {
  constructor(
    readonly reason: ArchiveProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchiveRules {
  /** Entries to leave out, by their path inside the archive. */
  drop?: (path: string) => boolean;
  /** Values to overwrite wherever their bytes appear. Shorter than 8 characters are ignored. */
  secrets?: readonly string[];
  /** Refuse an archive whose entries add up to more than this (a gzip bomb). */
  maxUnpackedBytes?: number;
}

export interface ArchiveReport {
  /** The distinct first path segments, sorted: a profile archive has exactly one. */
  roots: string[];
  entries: number;
  unpackedBytes: number;
  /** Entries left out by `drop`. */
  removed: string[];
  /** Entries in which a secret was overwritten. */
  masked: string[];
  /** Entries that are neither a folder nor a regular file (links, devices, fifos). */
  unsupported: string[];
  /** Entries whose path is absolute or climbs out with `..`. */
  unsafe: string[];
}

/** `.env` or `auth.json` at any depth: the files Hermes treats as credentials. */
export function isCredentialFile(entryPath: string): boolean {
  const base = entryPath.split('/').filter(Boolean).at(-1) ?? '';
  return CREDENTIAL_FILES.has(base);
}

/**
 * Reads `source` (a `.tar.gz`), applies `rules`, and writes the result to `target` as a
 * `.tar.gz` — or only reads it, when `target` is null. Throws `ArchiveError` when the file
 * is not a gzip-compressed tar or ends in the middle of an entry.
 */
export async function rewriteArchive(
  source: string,
  target: string | null,
  rules: ArchiveRules = {},
): Promise<ArchiveReport> {
  const filter = new TarFilter(rules);
  const gunzip = createGunzip();
  try {
    if (target) {
      await pipeline(
        createReadStream(source),
        gunzip,
        filter,
        createGzip(),
        createWriteStream(target, { mode: 0o600 }),
      );
    } else {
      await pipeline(createReadStream(source), gunzip, filter, discard());
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('Z_')) {
      throw new ArchiveError('not_gzip', 'the file is not gzip-compressed');
    }
    throw error;
  }
  return filter.report();
}

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

type State = 'header' | 'meta' | 'data' | 'skip' | 'end';

interface Pending {
  path: string | null;
}

/** The tar-level half of `rewriteArchive`: uncompressed tar in, uncompressed tar out. */
export class TarFilter extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private state: State = 'header';
  /** Bytes still to consume in `data`, `skip` or `meta` (padding included). */
  private remaining = 0;
  /** Of `remaining`, how many are the entry's own bytes (the rest is padding). */
  private content = 0;
  private metaType = '';
  private metaChunks: Buffer[] = [];
  /** A metadata entry's raw blocks, held until the entry they describe is kept or dropped. */
  private held: Buffer[] = [];
  private next: Pending = { path: null };
  private path = '';
  private masker: Masker | null = null;
  private readonly secrets: Buffer[];
  private readonly roots = new Set<string>();
  private readonly lists = {
    removed: [] as string[],
    masked: [] as string[],
    unsupported: [] as string[],
    unsafe: [] as string[],
  };
  private entries = 0;
  private unpacked = 0;

  constructor(private readonly rules: ArchiveRules) {
    super();
    this.secrets = [...new Set(rules.secrets ?? [])]
      .filter((value) => value.length >= 8)
      .map((value) => Buffer.from(value, 'utf8'));
  }

  report(): ArchiveReport {
    return {
      roots: [...this.roots].sort(),
      entries: this.entries,
      unpackedBytes: this.unpacked,
      removed: this.lists.removed,
      masked: this.lists.masked,
      unsupported: this.lists.unsupported,
      unsafe: this.lists.unsafe,
    };
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.pump();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.state === 'end' || (this.state === 'header' && this.buffer.length === 0)) {
      if (this.buffer.length > 0) this.push(this.buffer);
      if (this.entries === 0 && this.state !== 'end') {
        callback(new ArchiveError('not_tar', 'the archive is empty'));
        return;
      }
      callback();
      return;
    }
    callback(new ArchiveError('truncated', 'the archive ends in the middle of an entry'));
  }

  private consume(count: number): Buffer {
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  private pump(): void {
    for (;;) {
      if (this.state === 'end') {
        if (this.buffer.length > 0) this.push(this.consume(this.buffer.length));
        return;
      }
      if (this.state === 'header') {
        if (this.buffer.length < BLOCK) return;
        this.header(Buffer.from(this.consume(BLOCK)));
        continue;
      }
      if (this.buffer.length === 0 && this.remaining > 0) return;
      if (this.state === 'meta') {
        const part = this.consume(Math.min(this.remaining, this.buffer.length));
        this.remaining -= part.length;
        this.metaChunks.push(Buffer.from(part));
        if (this.remaining === 0) this.endMeta();
        continue;
      }
      if (this.state === 'skip') {
        const part = this.consume(Math.min(this.remaining, this.buffer.length));
        this.remaining -= part.length;
        if (this.remaining === 0) this.state = 'header';
        continue;
      }
      // data: the entry's bytes (masked when there are secrets), then its padding as is.
      const part = this.consume(Math.min(this.remaining, this.buffer.length));
      const own = Math.min(part.length, Math.max(this.content, 0));
      if (own > 0) {
        const bytes = part.subarray(0, own);
        this.push(this.masker ? this.masker.feed(bytes) : Buffer.from(bytes));
        this.content -= own;
        if (this.content === 0) this.endData();
      }
      if (part.length > own) this.push(Buffer.from(part.subarray(own)));
      this.remaining -= part.length;
      if (this.remaining === 0) {
        if (this.content > 0) this.endData();
        this.state = 'header';
      }
    }
  }

  private endData(): void {
    if (!this.masker) return;
    this.push(this.masker.flush());
    if (this.masker.hits > 0) note(this.lists.masked, this.path);
    this.masker = null;
  }

  private header(block: Buffer): void {
    if (block.every((byte) => byte === 0)) {
      // End of archive: the zero blocks (and whatever padding follows) pass through.
      this.state = 'end';
      this.push(block);
      return;
    }
    if (!checksumMatches(block)) {
      throw new ArchiveError('not_tar', 'the file is not a tar archive');
    }
    const type = String.fromCharCode(block[156] ?? 0);
    const size = readSize(block.subarray(124, 136));
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (size > MAX_META_BYTES) {
        throw new ArchiveError('not_tar', 'a metadata entry in the archive is too large');
      }
      this.metaType = type;
      this.metaChunks = [];
      this.held.push(block);
      this.state = 'meta';
      this.remaining = padded;
      this.content = size;
      if (padded === 0) this.endMeta();
      return;
    }

    const path = normalise(this.next.path ?? headerName(block));
    this.next = { path: null };
    this.entries += 1;
    this.unpacked += size;
    if (this.rules.maxUnpackedBytes !== undefined && this.unpacked > this.rules.maxUnpackedBytes) {
      throw new ArchiveError('too_large', 'the archive unpacks to more than the hub accepts');
    }
    const segments = path.split('/').filter(Boolean);
    if (segments[0]) this.roots.add(segments[0]);
    if (path.startsWith('/') || segments.includes('..')) note(this.lists.unsafe, path);
    // '0' and NUL are regular files, '7' a contiguous file (also regular), '5' a folder.
    if (!['0', '\0', '7', '5'].includes(type)) note(this.lists.unsupported, path);

    const regular = type === '0' || type === '\0' || type === '7';
    if (this.rules.drop?.(path)) {
      note(this.lists.removed, path);
      this.held = [];
      this.state = 'skip';
      this.remaining = regular ? padded : 0;
      if (this.remaining === 0) this.state = 'header';
      return;
    }
    for (const kept of this.held) this.push(kept);
    this.held = [];
    this.push(block);
    this.path = path;
    this.masker = regular && this.secrets.length > 0 ? new Masker(this.secrets) : null;
    this.state = 'data';
    this.remaining = regular ? padded : 0;
    this.content = regular ? size : 0;
    if (this.remaining === 0) {
      this.endData();
      this.state = 'header';
    }
  }

  private endMeta(): void {
    const data = Buffer.concat(this.metaChunks);
    this.held.push(data);
    const own = data.subarray(0, this.content);
    if (this.metaType === 'L') {
      this.next = { path: cString(own) };
    } else if (this.metaType === 'x') {
      const path = paxPath(own);
      if (path !== null) this.next = { path };
    }
    // 'K' (a long link target) and 'g' (global PAX) name nothing the hub looks at.
    this.metaChunks = [];
    this.state = 'header';
  }
}

/**
 * Overwrites every occurrence of any secret in a stream of chunks, keeping the length. The
 * last `longest - 1` bytes are held back each time, so a secret split across two chunks is
 * still found when the next one arrives.
 */
class Masker {
  hits = 0;
  private carry: Buffer = Buffer.alloc(0);
  private readonly keep: number;

  constructor(private readonly secrets: readonly Buffer[]) {
    this.keep = Math.max(...secrets.map((secret) => secret.length)) - 1;
  }

  feed(bytes: Buffer): Buffer {
    const combined = Buffer.concat([this.carry, bytes]);
    this.mask(combined);
    if (combined.length <= this.keep) {
      this.carry = combined;
      return Buffer.alloc(0);
    }
    const cut = combined.length - this.keep;
    this.carry = Buffer.from(combined.subarray(cut));
    return combined.subarray(0, cut);
  }

  flush(): Buffer {
    const out = this.carry;
    this.carry = Buffer.alloc(0);
    return out;
  }

  private mask(buffer: Buffer): void {
    for (const secret of this.secrets) {
      let at = buffer.indexOf(secret);
      while (at !== -1) {
        buffer.fill(MASK, at, at + secret.length);
        this.hits += 1;
        at = buffer.indexOf(secret, at + secret.length);
      }
    }
  }
}

function note(list: string[], path: string): void {
  if (list.length < REPORT_LIMIT) list.push(path);
}

/** The header's checksum: the sum of its bytes with the checksum field read as spaces. */
function checksumMatches(block: Buffer): boolean {
  const stored = readOctal(block.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function readOctal(field: Buffer): number | null {
  const text = cString(field).trim();
  if (!/^[0-7]+$/.test(text)) return null;
  return Number.parseInt(text, 8);
}

/** A size is octal ASCII, or big-endian binary when the first byte's high bit is set. */
function readSize(field: Buffer): number {
  const first = field[0] ?? 0;
  if (first & 0x80) {
    let value = first & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const value = readOctal(field);
  if (value === null) throw new ArchiveError('not_tar', 'an entry in the archive has no size');
  return value;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

/** `name`, prefixed with the ustar `prefix` field when the header is POSIX ustar. */
function headerName(block: Buffer): string {
  const name = cString(block.subarray(0, 100));
  const magic = block.subarray(257, 263).toString('latin1');
  if (magic === 'ustar\0') {
    const prefix = cString(block.subarray(345, 500));
    if (prefix) return `${prefix}/${name}`;
  }
  return name;
}

/** The `path` record of a PAX header (`<length> path=<value>\n`), or null. */
function paxPath(data: Buffer): string | null {
  let offset = 0;
  let found: string | null = null;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('latin1'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') found = record.slice(equals + 1);
    offset += length;
  }
  return found;
}

function normalise(path: string): string {
  let out = path.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/\/+$/, '');
}
