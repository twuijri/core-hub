/**
 * Line diffs for the files a run changed when the folder is not a git repository (contract
 * decision §49): the added and removed line counts, and the unified diff's hunks, from the
 * copy of a file kept at the run's start and the file at its end.
 *
 * Myers' O(ND) algorithm on lines, after the common head and tail are set aside. It is
 * bounded twice, because a run can rewrite a large file end to end: above `MAX_LINES` lines
 * a side, or `MAX_EDITS` edits apart, no diff is drawn and the counts come from comparing the
 * two files' lines as multisets — exact for additions and deletions that do not reorder
 * lines, and never more than the real counts.
 *
 * Lines are compared with their end of line, so a changed last newline is a changed line, and
 * one without a newline is marked as git marks it (`\ No newline at end of file`).
 */

/** The largest side, in lines, that is diffed rather than only counted. */
export const MAX_LINES = 50_000;
/** The most insertions plus deletions the diff looks for. */
export const MAX_EDITS = 2_000;
/** Lines of context around each change, as `git diff` shows by default. */
export const CONTEXT = 3;

const NO_NEWLINE = '\\ No newline at end of file';

/** A text's lines, each with its own end of line (the last may have none). */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

/** Git's test for a binary file: a NUL byte in the first 8000. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i += 1) if (bytes[i] === 0) return true;
  return false;
}

type Op = '=' | '-' | '+';

/** The edit script from `a` to `b`, or `null` when they are more than `maxEdits` apart. */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    // Only the diagonals step `d` reads (-d-1 … d+1): the saved frontiers stay O(D²) small.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk back through the saved frontiers.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const frontier = trace[d]!;
    const at = (diagonal: number) => frontier[diagonal + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x -= 1;
      y -= 1;
    }
    ops.push(down ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push('=');
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** Additions and deletions as a multiset difference: the fallback when no diff is drawn. */
function countApart(a: readonly string[], b: readonly string[]) {
  const seen = new Map<string, number>();
  for (const line of a) seen.set(line, (seen.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of b) {
    const left = seen.get(line) ?? 0;
    if (left > 0) seen.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of seen.values()) deletions += left;
  return { additions, deletions };
}

export interface LineDiff {
  additions: number;
  deletions: number;
  /** The hunks, from the first `@@`; `null` when the sides were too large or too far apart. */
  text: string | null;
  /** `text` was cut at a line to stay under `maxBytes`. */
  truncated: boolean;
}

/**
 * The diff from `before` to `after` (either `null` for a file that was not there), with at
 * most `maxBytes` of hunk text kept.
 */
export function diffTexts(before: string | null, after: string | null, maxBytes: number): LineDiff {
  const a = linesOf(before ?? '');
  const b = linesOf(after ?? '');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const tooLarge = a.length > MAX_LINES || b.length > MAX_LINES;
  // One side empty in the middle: every line there is an edit, nothing to search for.
  const middle = tooLarge
    ? null
    : midA.length === 0 || midB.length === 0
      ? [...Array<Op>(midA.length).fill('-'), ...Array<Op>(midB.length).fill('+')]
      : myers(midA, midB, MAX_EDITS);
  if (!middle) return { ...countApart(midA, midB), text: null, truncated: false };
  const ops: Op[] = [...Array<Op>(head).fill('='), ...middle, ...Array<Op>(tail).fill('=')];
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op === '+') additions += 1;
    else if (op === '-') deletions += 1;
  }
  const { text, truncated } = hunksOf(a, b, ops, maxBytes);
  return { additions, deletions, text, truncated };
}

interface Row {
  op: Op;
  /** 0-based line index in `a` (for `=` and `-`) and in `b` (for `=` and `+`). */
  ai: number;
  bi: number;
}

function hunksOf(
  a: readonly string[],
  b: readonly string[],
  ops: readonly Op[],
  maxBytes: number,
): { text: string; truncated: boolean } {
  const rows: Row[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    rows.push({ op, ai, bi });
    if (op !== '+') ai += 1;
    if (op !== '-') bi += 1;
  }
  // Group changed rows whose gap is small enough that their context would touch.
  const groups: Array<[number, number]> = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.op === '=') continue;
    let end = i;
    while (end + 1 < rows.length && rows[end + 1]!.op !== '=') end += 1;
    const last = groups.at(-1);
    if (last && i - last[1] - 1 <= 2 * CONTEXT) last[1] = end;
    else groups.push([i, end]);
    i = end;
  }
  let out = '';
  let bytes = 0;
  const encoder = new TextEncoder();
  const push = (line: string): boolean => {
    const size = encoder.encode(line).length;
    if (bytes + size > maxBytes) return false;
    out += line;
    bytes += size;
    return true;
  };
  for (const [first, last] of groups) {
    const start = Math.max(0, first - CONTEXT);
    const end = Math.min(rows.length - 1, last + CONTEXT);
    let oldLen = 0;
    let newLen = 0;
    for (let i = start; i <= end; i += 1) {
      if (rows[i]!.op !== '+') oldLen += 1;
      if (rows[i]!.op !== '-') newLen += 1;
    }
    const oldStart = oldLen === 0 ? rows[start]!.ai : rows[start]!.ai + 1;
    const newStart = newLen === 0 ? rows[start]!.bi : rows[start]!.bi + 1;
    const header = `@@ -${range(oldStart, oldLen)} +${range(newStart, newLen)} @@\n`;
    if (!push(header)) return { text: out, truncated: true };
    for (let i = start; i <= end; i += 1) {
      const row = rows[i]!;
      const line = row.op === '+' ? b[row.bi]! : a[row.ai]!;
      const prefix = row.op === '=' ? ' ' : row.op;
      const rendered = line.endsWith('\n')
        ? `${prefix}${line}`
        : `${prefix}${line}\n${NO_NEWLINE}\n`;
      if (!push(rendered)) return { text: out, truncated: true };
    }
  }
  return { text: out, truncated: false };
}

function range(start: number, length: number): string {
  return length === 1 ? String(start) : `${start},${length}`;
}
