/**
 * The bytes, on disk, under `${DATA_DIR}/attachments/<workspace>/…`.
 *
 * Three rules hold everything together:
 *
 * 1. **Content addressed.** A stored file lives at `<workspace>/<aa>/<sha256>` where
 *    `aa` is the first two hex characters. Two uploads of the same bytes in the same
 *    workspace share one file; each has its own `attachments` row pointing at the same
 *    key, and the file is removed only with the last live row (`service.remove`). The
 *    key never contains anything the client chose, so a filename can never steer a write.
 * 2. **Never in memory.** Writing consumes a stream through a hash and a file handle at
 *    once; reading answers a `ReadStream` (with a byte range when the client asked for
 *    one). A 50 MB upload costs one 64 KiB buffer.
 * 3. **Temp then rename.** Bytes land in `<workspace>/.tmp/<ulid>` and are renamed into
 *    place only after the hash is known and the size passed the limit. A refused or
 *    interrupted upload leaves nothing but a temp file, which is removed on the way out.
 *
 * The store knows nothing about the database; `store.ts` owns the rows and `service.ts`
 * is the only place that uses both.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { newUlid } from '../../db/ids.js';
import { HubError } from '../../lib/errors.js';
import { SNIFF_BYTES } from './media.js';

export interface StoredBlob {
  /** Path relative to `<data>/attachments`; the `attachments.storage_key` column. */
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  /** The first bytes, kept for the media-type sniff — never the whole file. */
  head: Buffer;
  /** True when the same bytes were already stored in this workspace. */
  deduplicated: boolean;
}

export interface WriteOptions {
  /** Refuse (and delete the partial file) once this many bytes have been read. */
  maxBytes: number;
  /** What to say when the limit is hit; the route turns it into `413`. */
  onTooLarge?: () => Error;
}

/** A byte range as `Range: bytes=…` asked for it, already clamped to the file. */
export interface ByteRange {
  start: number;
  end: number;
}

export class BlobStore {
  /** `<data>/attachments`. */
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'attachments');
  }

  /** Absolute path of a stored key. Keys are ours, so no traversal is possible. */
  pathOf(storageKey: string): string {
    return path.join(this.root, storageKey);
  }

  private workspaceDir(workspace: string): string {
    // The workspace is a ULID from the database, never client text.
    return path.join(this.root, workspace);
  }

  /** A fresh temp path inside the workspace, on the same filesystem as its blobs. */
  openTemp(workspace: string): string {
    const dir = path.join(this.workspaceDir(workspace), '.tmp');
    mkdirSync(dir, { recursive: true });
    return path.join(dir, newUlid());
  }

  /**
   * Read `source` into a temp file, hashing as it goes, and move it into place.
   * Throws (after deleting the partial file) when `maxBytes` is exceeded.
   */
  async write(workspace: string, source: Readable, options: WriteOptions): Promise<StoredBlob> {
    const temp = this.openTemp(workspace);
    try {
      const measured = await this.drain(source, temp, options);
      return this.commit(workspace, temp, measured);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  /** Move an already-written temp file into place, hashing it on the way. */
  async commitFile(workspace: string, temp: string): Promise<StoredBlob> {
    const measured = await this.measure(temp);
    return this.commit(workspace, temp, measured);
  }

  /** Copy a file that exists elsewhere (an agent's output) into the store. */
  async ingest(workspace: string, filePath: string, options: WriteOptions): Promise<StoredBlob> {
    return this.write(workspace, createReadStream(filePath), options);
  }

  /**
   * Copy a file into the store under a key of its own rather than its hash: for a file kept
   * for a limited time (a profile export), whose bytes must not be shared with an upload of
   * the very same bytes — its expiry removes them whoever else holds that content.
   */
  async keepCopy(workspace: string, filePath: string, options: WriteOptions): Promise<StoredBlob> {
    const temp = this.openTemp(workspace);
    try {
      const measured = await this.drain(createReadStream(filePath), temp, options);
      const storageKey = path.posix.join(workspace, 'kept', newUlid());
      const target = this.pathOf(storageKey);
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(temp, target);
      return { storageKey, deduplicated: false, ...measured };
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  /** Append one chunk to an open upload's temp file; returns the new size. */
  async append(temp: string, source: Readable, at: number, limit: number): Promise<number> {
    const handle = createWriteStream(temp, { flags: at === 0 ? 'w' : 'r+', start: at });
    let written = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (at + written > limit) {
          callback(new HubError('payload_too_large', { details: { max_bytes: limit } }));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(source, count, handle);
    return at + written;
  }

  size(filePath: string): number {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  /** The bytes of a stored blob, whole or in one range. */
  read(storageKey: string, range?: ByteRange): Readable {
    const file = this.pathOf(storageKey);
    return range
      ? createReadStream(file, { start: range.start, end: range.end })
      : createReadStream(file);
  }

  exists(storageKey: string): boolean {
    return existsSync(this.pathOf(storageKey));
  }

  /**
   * Put a copy of a stored blob at `target` (the agent's input folder).
   *
   * A copy, not a link: the agent may edit or delete what it was handed, and the stored
   * bytes are what the download serves. The name is de-duplicated rather than
   * overwritten, so two attachments called `report.pdf` both arrive.
   */
  copyTo(storageKey: string, target: string): string {
    mkdirSync(path.dirname(target), { recursive: true });
    const extension = path.extname(target);
    const stem = target.slice(0, target.length - extension.length);
    let chosen = target;
    for (let n = 2; existsSync(chosen) && n < 1000; n += 1) chosen = `${stem}-${n}${extension}`;
    copyFileSync(this.pathOf(storageKey), chosen);
    return chosen;
  }

  /** Remove the bytes. The row stays so references still render (domain §attachment). */
  remove(storageKey: string): void {
    rmSync(this.pathOf(storageKey), { force: true });
  }

  discardTemp(temp: string): void {
    rmSync(temp, { force: true });
  }

  // -------------------------------------------------------------- internals

  private async drain(
    source: Readable,
    temp: string,
    options: WriteOptions,
  ): Promise<{ sha256: string; sizeBytes: number; head: Buffer }> {
    const hash = createHash('sha256');
    const heads: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > options.maxBytes) {
          callback(
            options.onTooLarge?.() ??
              new HubError('payload_too_large', { details: { max_bytes: options.maxBytes } }),
          );
          return;
        }
        hash.update(chunk);
        if (headLength < SNIFF_BYTES) {
          const slice = chunk.subarray(0, SNIFF_BYTES - headLength);
          heads.push(slice);
          headLength += slice.length;
        }
        callback(null, chunk);
      },
    });
    await pipeline(source, measure, createWriteStream(temp));
    return { sha256: hash.digest('hex'), sizeBytes: size, head: Buffer.concat(heads) };
  }

  private async measure(
    temp: string,
  ): Promise<{ sha256: string; sizeBytes: number; head: Buffer }> {
    const hash = createHash('sha256');
    const heads: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    for await (const chunk of createReadStream(temp) as AsyncIterable<Buffer>) {
      size += chunk.length;
      hash.update(chunk);
      if (headLength < SNIFF_BYTES) {
        const slice = chunk.subarray(0, SNIFF_BYTES - headLength);
        heads.push(slice);
        headLength += slice.length;
      }
    }
    return { sha256: hash.digest('hex'), sizeBytes: size, head: Buffer.concat(heads) };
  }

  private commit(
    workspace: string,
    temp: string,
    measured: { sha256: string; sizeBytes: number; head: Buffer },
  ): StoredBlob {
    const storageKey = path.posix.join(workspace, measured.sha256.slice(0, 2), measured.sha256);
    const target = this.pathOf(storageKey);
    mkdirSync(path.dirname(target), { recursive: true });
    const deduplicated = existsSync(target);
    if (deduplicated) rmSync(temp, { force: true });
    else renameSync(temp, target);
    return { storageKey, deduplicated, ...measured };
  }
}

/**
 * Parse one `Range: bytes=a-b` header against a known size.
 *
 * Returns `null` for "no range asked" **and** for a range that cannot be satisfied: the
 * contract documents `200` and `206` for this operation and nothing else, and HTTP lets
 * a server ignore a Range it does not like, so the whole file is the honest answer
 * rather than a status no client was told to expect. Only a single range is supported —
 * the contract promises `206` for audio and video seeking, which never asks for more.
 */
export function parseRange(header: unknown, size: number): ByteRange | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // `bytes=-500`: the last 500 bytes.
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}
