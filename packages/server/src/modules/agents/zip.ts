/**
 * A small, strict zip reader for skill packs — enough of the format for what people upload
 * (stored and deflated entries), and nothing that could write outside the folder it is given.
 *
 * Why not a dependency: a pack is a few files, read once, and the checks that matter here —
 * no climbing out with `..`, no absolute paths, no symbolic links, no encrypted entries, a
 * ceiling on what the archive may expand to — are ones this file must make itself anyway,
 * whatever library read the bytes. `node:zlib` does the inflating.
 *
 * Read from the central directory, the zip's own index; every entry's local header is checked
 * against it and every file's CRC-32 is verified, so a truncated or tampered archive is
 * refused rather than half-read.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Normalised path, `/`-separated, never absolute and never climbing. */
  path: string;
  data: Buffer;
  /** Unix mode bits when the archive recorded them (the executable bit of a script). */
  mode: number | null;
}

export interface ZipLimits {
  /** Most entries an archive may hold. */
  maxEntries: number;
  /** Most bytes one file may expand to. */
  maxFileBytes: number;
  /** Most bytes the whole archive may expand to. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export class ZipError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly file: string | null = null,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** True when the bytes open like a zip (a local header, or an empty archive's end record). */
export function looksLikeZip(data: Buffer): boolean {
  if (data.length < 4) return false;
  const sig = data.readUInt32LE(0);
  return sig === LOCAL || sig === EOCD;
}

/** Folders and files an archiver adds that are nobody's content. */
function isNoise(path: string): boolean {
  const parts = path.split('/');
  return (
    parts[0] === '__MACOSX' ||
    parts.some((part) => part === '.DS_Store' || part === 'Thumbs.db' || part === 'desktop.ini')
  );
}

/**
 * A path from inside the archive, made safe or refused: backslashes read as separators, `.`
 * segments dropped, and anything absolute, climbing, empty or carrying control characters is
 * an error — never silently rewritten into something that lands elsewhere.
 */
export function safeEntryPath(raw: string): string {
  const unified = raw.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(unified)) {
    throw new ZipError('pack_path_unsafe', `the pack has a file name with control characters`);
  }
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new ZipError('pack_path_unsafe', `"${raw}" is an absolute path`, raw);
  }
  const parts = unified.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new ZipError('pack_path_unsafe', `"${raw}" climbs out of the pack`, raw);
  }
  return parts.join('/');
}

export function readZip(data: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const end = findEnd(data);
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  const offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError('pack_unsupported', 'ZIP64 archives are not supported; a skill pack is small');
  }
  if (count > limits.maxEntries) {
    throw new ZipError('pack_too_large', `the pack holds ${count} entries (at most ${limits.maxEntries})`);
  }
  if (offset + size > end) throw new ZipError('pack_corrupt', 'the archive index is out of bounds');

  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError('pack_corrupt', 'the archive index is damaged');
    }
    const madeBy = data.readUInt16LE(at + 4);
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const compressed = data.readUInt32LE(at + 20);
    const declared = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const external = data.readUInt32LE(at + 38);
    const localAt = data.readUInt32LE(at + 42);
    const rawName = data
      .subarray(at + 46, at + 46 + nameLength)
      .toString(flags & 0x0800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extraLength + commentLength;

    const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\');
    const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0xffff : null;
    if (unixMode !== null && (unixMode & 0o170000) === 0o120000) {
      throw new ZipError('pack_path_unsafe', `"${rawName}" is a symbolic link`, rawName);
    }
    const path = safeEntryPath(rawName);
    if (isDirectory || path === '' || isNoise(path)) continue;
    if (flags & 0x0001) {
      throw new ZipError('pack_unsupported', `"${path}" is encrypted`, path);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError('pack_unsupported', `"${path}" uses compression method ${method}`, path);
    }
    if (declared > limits.maxFileBytes) {
      throw new ZipError(
        'pack_too_large',
        `"${path}" expands to ${declared} bytes (at most ${limits.maxFileBytes})`,
        path,
      );
    }
    if (seen.has(path)) throw new ZipError('pack_corrupt', `"${path}" appears twice`, path);
    seen.add(path);

    if (localAt + 30 > data.length || data.readUInt32LE(localAt) !== LOCAL) {
      throw new ZipError('pack_corrupt', `"${path}" has no local header`, path);
    }
    const start = localAt + 30 + data.readUInt16LE(localAt + 26) + data.readUInt16LE(localAt + 28);
    if (start + compressed > data.length) {
      throw new ZipError('pack_corrupt', `"${path}" is cut short`, path);
    }
    const raw = data.subarray(start, start + compressed);
    let body: Buffer;
    try {
      body =
        method === 0
          ? Buffer.from(raw)
          : inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes });
    } catch (error) {
      throw new ZipError(
        'pack_corrupt',
        `"${path}" could not be inflated: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }
    if (body.length !== declared || crc32(body) !== crc) {
      throw new ZipError('pack_corrupt', `"${path}" does not match its checksum`, path);
    }
    total += body.length;
    if (total > limits.maxTotalBytes) {
      throw new ZipError(
        'pack_too_large',
        `the pack expands to more than ${limits.maxTotalBytes} bytes`,
      );
    }
    out.push({ path, data: body, mode: unixMode === null ? null : unixMode & 0o777 });
  }
  return out;
}

function findEnd(data: Buffer): number {
  // The end record is 22 bytes plus a comment of up to 65,535.
  const floor = Math.max(0, data.length - 22 - 0xffff);
  for (let at = data.length - 22; at >= floor; at -= 1) {
    if (data.readUInt32LE(at) === EOCD) return at;
  }
  throw new ZipError('pack_corrupt', 'this is not a complete zip archive');
}
