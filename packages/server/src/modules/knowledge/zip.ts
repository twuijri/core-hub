/**
 * A streaming zip writer, just big enough for "download this folder".
 *
 * Why not a library: the format needed here is small and fixed — deflated file entries with
 * a data descriptor, directory entries, UTF-8 names, one central directory — and the callers
 * cap an archive far below the 4 GiB / 65 535-entry limits where ZIP64 would begin
 * (`WORKSPACE_FILE_LIMITS`). Writing it ourselves keeps a dependency, its licence notice and
 * its update churn out of the image for about a hundred lines (APPNOTE.TXT 6.3.x).
 *
 * Each file is read once: its bytes are deflated as they stream, and the CRC-32 and both
 * sizes follow in the data descriptor (general-purpose bit 3), so nothing is buffered whole.
 */
import { createReadStream } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

export interface ZipItem {
  /** The name inside the archive, `/`-separated; a folder ends with `/`. */
  name: string;
  /** Absolute path of a file to read; absent for a folder entry. */
  source?: string;
  modifiedAt: Date;
}

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION = 20;

interface Written {
  name: Buffer;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  directory: boolean;
}

/** MS-DOS time and date, which the zip format still speaks; clamped to 1980. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getFullYear(), 1980);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

function localHeader(entry: Written): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  // CRC and sizes are zero here and follow in the data descriptor (bit 3), except for a
  // folder, which has none of either.
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.name]);
}

function dataDescriptor(entry: Written): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(entry.crc >>> 0, 4);
  descriptor.writeUInt32LE(entry.compressed, 8);
  descriptor.writeUInt32LE(entry.size, 12);
  return descriptor;
}

function centralHeader(entry: Written): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  // Made by: UNIX (3), so the external attributes below are read as a mode.
  header.writeUInt16LE((3 << 8) | VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  const mode = entry.directory ? 0o040755 : 0o100644;
  header.writeUInt32LE(((mode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

/**
 * The archive as a stream. Items are written in the order given; an error reading one file
 * destroys the stream with that error (the client sees a cut download, never a zip that
 * silently lacks a file).
 */
export function zipStream(items: readonly ZipItem[]): Readable {
  const out = new PassThrough();
  let offset = 0;
  const push = async (chunk: Buffer) => {
    offset += chunk.length;
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
  };

  const run = async () => {
    const written: Written[] = [];
    for (const item of items) {
      const directory = item.source === undefined;
      const { time, date } = dosTime(item.modifiedAt);
      const entry: Written = {
        name: Buffer.from(item.name, 'utf8'),
        method: directory ? METHOD_STORE : METHOD_DEFLATE,
        flags: FLAG_UTF8 | (directory ? 0 : FLAG_DATA_DESCRIPTOR),
        time,
        date,
        crc: 0,
        compressed: 0,
        size: 0,
        offset,
        directory,
      };
      await push(localHeader(entry));
      if (!directory) {
        const deflate = createDeflateRaw();
        const source = createReadStream(item.source as string);
        source.on('data', (chunk) => {
          const bytes = chunk as Buffer;
          entry.crc = crc32(bytes, entry.crc);
          entry.size += bytes.length;
        });
        source.on('error', (error) => deflate.destroy(error));
        source.pipe(deflate);
        for await (const chunk of deflate) {
          const bytes = chunk as Buffer;
          entry.compressed += bytes.length;
          await push(bytes);
        }
        await push(dataDescriptor(entry));
      }
      written.push(entry);
    }
    const start = offset;
    for (const entry of written) await push(centralHeader(entry));
    await push(endOfCentralDirectory(written.length, offset - start, start));
    out.end();
  };

  run().catch((error: unknown) => out.destroy(error as Error));
  return out;
}
