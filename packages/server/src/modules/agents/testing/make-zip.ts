/**
 * Builds zip archives for the skill-import tests and the e2e journey — including the broken
 * ones (a path that climbs, a symbolic link, an encrypted flag, a wrong checksum) that the
 * reader must refuse. A test helper, never shipped behaviour.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipInput {
  path: string;
  data: string | Buffer;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Unix mode bits to record (`0o755` for a script, `0o120777` for a symlink). */
  mode?: number;
  /** Extra general-purpose flags (`1` = encrypted). */
  flags?: number;
  /** Write a wrong CRC-32. */
  badCrc?: boolean;
}

export function makeZip(entries: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const name = Buffer.from(entry.path, 'utf8');
    const method = entry.stored ? 0 : 8;
    const body = method === 0 ? data : deflateRawSync(data);
    const crc = entry.badCrc ? (crc32(data) ^ 0xffff) >>> 0 : crc32(data);
    const flags = 0x0800 | (entry.flags ?? 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by Unix (3), so the mode bits in the external attributes are read.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
