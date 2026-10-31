/**
 * Reading a zip on a web server without downloading all of it (ADR 0032 §3).
 *
 * Ollama's Windows release is one 1.5 GB zip that carries the libraries of every graphics card
 * family. A zip keeps its index (the central directory) at the end, so with HTTP `Range` the hub
 * reads the index first — a few KB — and then fetches only the entries this computer needs.
 *
 * What protects the bytes: the download is over TLS from the vendor's release, and each entry is
 * checked against the CRC-32 and size its index records. The release's SHA-256 is of the whole
 * zip, so it cannot be checked when only part of it is fetched; ADR 0032 records that trade.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { crc32, createInflateRaw } from 'node:zlib';
import { HubError } from '../../../lib/errors.js';

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  directory: boolean;
}

export interface RemoteZip {
  /** The address after redirects, so every range request goes straight to the file. */
  url: string;
  size: number;
  entries: ZipEntry[];
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function failure(message: string): HubError {
  return new HubError('service_unavailable', { message });
}

async function range(
  fetchImpl: typeof fetch,
  url: string,
  start: number,
  end: number,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw failure(
      `could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw failure(`${url} did not answer a range request (HTTP ${response.status})`);
  }
  return response;
}

async function rangeBytes(
  fetchImpl: typeof fetch,
  url: string,
  start: number,
  end: number,
  timeoutMs: number,
): Promise<Buffer> {
  const response = await range(fetchImpl, url, start, end, timeoutMs);
  return Buffer.from(await response.arrayBuffer());
}

/** Reads the index of the zip at `url` with two or three small range requests. */
export async function openRemoteZip(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs = 60_000,
): Promise<RemoteZip> {
  // One byte, to learn the final address and the total size from `Content-Range`.
  const probe = await range(fetchImpl, url, 0, 0, timeoutMs);
  await probe.arrayBuffer();
  const total = Number(/\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1] ?? NaN);
  if (!Number.isFinite(total) || total < 22) throw failure(`${url} gave no usable size`);
  const finalUrl = probe.url || url;

  const tailLength = Math.min(total, 65_557);
  const tail = await rangeBytes(fetchImpl, finalUrl, total - tailLength, total - 1, timeoutMs);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw failure(`${url} is not a zip`);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) {
      throw failure(`${url} is a zip64 file without its locator`);
    }
    const at = Number(tail.readBigUInt64LE(locator + 8));
    const record = await rangeBytes(fetchImpl, finalUrl, at, at + 55, timeoutMs);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw failure(`${url} has a broken zip64 index`);
    count = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  if (cdSize > 64 * 1024 * 1024 || cdOffset + cdSize > total) {
    throw failure(`${url} has an index the hub will not read`);
  }
  const directory = await rangeBytes(
    fetchImpl,
    finalUrl,
    cdOffset,
    cdOffset + cdSize - 1,
    timeoutMs,
  );
  return { url: finalUrl, size: total, entries: parseCentralDirectory(directory, count) };
}

export function parseCentralDirectory(buffer: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) {
      throw failure('the zip index ends early');
    }
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    let compressedSize = buffer.readUInt32LE(at + 20);
    let size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    let localHeaderOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    // Zip64: the extra field carries, in order, only the values the header marked as too big.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = Number(buffer.readBigUInt64LE(field));
          field += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(buffer.readBigUInt64LE(field));
          field += 8;
        }
        if (localHeaderOffset === 0xffffffff) {
          localHeaderOffset = Number(buffer.readBigUInt64LE(field));
        }
      }
      extra += 4 + length;
    }
    entries.push({
      name: name.replace(/\\/g, '/'),
      method,
      crc32: crc,
      compressedSize,
      size,
      localHeaderOffset,
      directory: name.endsWith('/'),
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** `dest/name`, or null when the name would land outside `dest`. */
export function safeTarget(dest: string, name: string): string | null {
  if (name === '' || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((part) => part === '..')) return null;
  const target = path.resolve(dest, ...parts.filter((part) => part !== '' && part !== '.'));
  const root = path.resolve(dest);
  return target.startsWith(root + path.sep) ? target : null;
}

/** Fetches one entry into `dest`, refusing it unless its size and CRC-32 match the index. */
export async function extractRemoteEntry(
  fetchImpl: typeof fetch,
  zip: RemoteZip,
  entry: ZipEntry,
  dest: string,
  onBytes: (bytes: number) => void,
  timeoutMs: number,
): Promise<void> {
  const target = safeTarget(dest, entry.name);
  if (!target) throw failure(`refusing ${entry.name}: it would land outside the install folder`);
  if (entry.directory) {
    await mkdir(target, { recursive: true });
    return;
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw failure(`${entry.name} uses a compression the hub does not read (${entry.method})`);
  }
  const header = await rangeBytes(
    fetchImpl,
    zip.url,
    entry.localHeaderOffset,
    entry.localHeaderOffset + 29,
    timeoutMs,
  );
  if (header.readUInt32LE(0) !== LOCAL) throw failure(`${entry.name} has a broken header`);
  const dataStart =
    entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  await mkdir(path.dirname(target), { recursive: true });
  if (entry.compressedSize === 0) {
    await pipeline(Readable.from([]), createWriteStream(target));
  } else {
    const response = await range(
      fetchImpl,
      zip.url,
      dataStart,
      dataStart + entry.compressedSize - 1,
      timeoutMs,
    );
    let crc = 0;
    let written = 0;
    const check = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        crc = crc32(chunk, crc);
        written += chunk.length;
        done(null, chunk);
      },
    });
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        onBytes(chunk.length);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
        counted,
        ...(entry.method === 8 ? [createInflateRaw()] : []),
        check,
        createWriteStream(target),
      );
    } catch (error) {
      await rm(target, { force: true });
      throw failure(
        `could not fetch ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (written !== entry.size || crc >>> 0 !== entry.crc32 >>> 0) {
      await rm(target, { force: true });
      throw new HubError('internal', {
        message: `refusing ${entry.name}: it does not match the zip's own record of it`,
        details: { reason: 'checksum_mismatch' },
      });
    }
  }
}
