/**
 * The few protobuf wire pieces Gemini Desktop's native service needs (DECISIONS §155): field
 * numbers only, no schema. The service's messages are not published; every number used here was
 * read from the owner's Gemini Desktop plugin (MIT, THIRD-PARTY-NOTICES.md) or from a live round
 * trip (`docs/research/gemini-desktop-2026-10.md`).
 */

export interface WireField {
  field: number;
  /** 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
  kind: 0 | 1 | 2 | 5;
  /** Set for kind 0. */
  int: bigint;
  /** Set for kinds 1, 2 and 5. */
  bytes: Buffer;
}

const EMPTY = Buffer.alloc(0);
/** A frame with more fields than this is not one of the service's answers. */
const MAX_FIELDS = 65_536;

function varint(value: bigint | number): Buffer {
  let n = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

/** A varint field. */
export function num(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

/** A length-delimited field: a nested message, a string or bytes. */
export function msg(field: number, value: Buffer | string = EMPTY): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}

/** One message's fields, in order. Throws on anything that is not well-formed protobuf. */
export function parseWire(data: Buffer): WireField[] {
  const out: WireField[] = [];
  let i = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= data.length || shift > 63n) throw new Error('invalid protobuf varint');
      const byte = data[i++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < data.length) {
    const tag = readVarint();
    const field = Number(tag >> 3n);
    const kind = Number(tag & 7n);
    if (field === 0) throw new Error('invalid protobuf tag');
    if (kind === 0) {
      out.push({ field, kind: 0, int: readVarint(), bytes: EMPTY });
    } else if (kind === 2) {
      const length = Number(readVarint());
      if (length > data.length - i) throw new Error('invalid protobuf length');
      out.push({ field, kind: 2, int: 0n, bytes: data.subarray(i, i + length) });
      i += length;
    } else if (kind === 1 || kind === 5) {
      const length = kind === 1 ? 8 : 4;
      if (data.length - i < length) throw new Error('truncated protobuf field');
      out.push({ field, kind, int: 0n, bytes: data.subarray(i, i + length) });
      i += length;
    } else {
      throw new Error('unsupported protobuf wire type');
    }
    if (out.length > MAX_FIELDS) throw new Error('protobuf frame contains too many fields');
  }
  return out;
}

/**
 * Every length-delimited value at a path of field numbers (`nested(frame, 1003, 1, 2, 1)`); a
 * level that does not parse contributes nothing, as an unknown field would.
 */
export function nested(data: Buffer, ...path: number[]): Buffer[] {
  let values = [data];
  for (const field of path) {
    const next: Buffer[] = [];
    for (const value of values) {
      let fields: WireField[];
      try {
        fields = parseWire(value);
      } catch {
        continue;
      }
      for (const item of fields) if (item.field === field && item.kind === 2) next.push(item.bytes);
    }
    values = next;
  }
  return values;
}

/** The first string at a path, or null. */
export function firstString(data: Buffer, ...path: number[]): string | null {
  const found = nested(data, ...path)[0];
  return found === undefined ? null : found.toString('utf8');
}
