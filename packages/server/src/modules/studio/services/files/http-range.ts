/**
 * Single implementation of RFC 7233 byte-range parsing for Studio downloads.
 * File downloads and mobile app-update downloads must agree on what a resumed
 * download means, so the rule lives here instead of being written twice.
 *
 * Returns `null` when the client sent no Range header, `'invalid'` when the
 * header is unsatisfiable (the caller answers 416), or the resolved inclusive
 * start/end pair clamped to the known size.
 */
export type ParsedByteRange = { start: number; end: number }

export function parseByteRange(header: string | undefined, size: number): ParsedByteRange | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid'
  let start = match[1] === '' ? NaN : Number(match[1])
  let end = match[2] === '' ? size - 1 : Number(match[2])
  if (Number.isNaN(start)) {
    // suffix range: last N bytes
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
