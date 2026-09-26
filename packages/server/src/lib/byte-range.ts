/**
 * One `Range: bytes=…` over a file of a known size (RFC 9110 §14), for the reads a media element
 * makes as it plays and seeks (DECISIONS §92).
 *
 * - `bytes=a-b`, `bytes=a-` and `bytes=-n` (the last n bytes) are one range; `b` past the end is
 *   cut to the end.
 * - A range that starts at or past the end — or asks for the last zero bytes — cannot be
 *   satisfied: `416` with `Content-Range: bytes *\/<size>`.
 * - Anything else — no header, another unit, several ranges, garbage — is ignored and the whole
 *   file is sent, as the RFC lets a server do; a browser never sends those for media.
 */
import { HubError } from './errors.js';

export type ByteRangeAnswer =
  | { kind: 'all' }
  | { kind: 'part'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function byteRangeOf(header: unknown, size: number): ByteRangeAnswer {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'all' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'all' };
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return { kind: 'all' };
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last)) return { kind: 'all' };
  // `bytes=500-100` is not a range at all: ignored, the whole file.
  if (match[2] !== '' && last < start) return { kind: 'all' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'part', start, end: Math.min(last, size - 1) };
}

/** The contract's `RangeNotSatisfiable`. */
export function rangeNotSatisfiable(size: number): HubError {
  return new HubError('bad_request', {
    status: 416,
    messageKey: 'knowledge.range_not_satisfiable',
    details: { reason: 'range_not_satisfiable', size_bytes: size },
    headers: { 'content-range': `bytes */${size}` },
  });
}

/**
 * The status, the length headers and the read window for one answer — or the `416` thrown.
 * `end` is inclusive, as `fs.createReadStream` takes it.
 */
export function rangeReply(
  header: unknown,
  size: number,
): { status: 200 | 206; headers: Record<string, string>; start: number; end: number } {
  const range = byteRangeOf(header, size);
  if (range.kind === 'unsatisfiable') throw rangeNotSatisfiable(size);
  const headers: Record<string, string> = { 'accept-ranges': 'bytes' };
  if (range.kind === 'all') {
    headers['content-length'] = String(size);
    return { status: 200, headers, start: 0, end: Math.max(0, size - 1) };
  }
  headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  headers['content-length'] = String(range.end - range.start + 1);
  return { status: 206, headers, start: range.start, end: range.end };
}
