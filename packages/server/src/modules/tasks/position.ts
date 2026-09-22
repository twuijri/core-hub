/**
 * Where a task sits in its column.
 *
 * The contract says `position` is "a fractional index the server keeps; clients never
 * compute it". This is that index: a short string of `a`..`z` that sorts
 * lexicographically, so moving a task between two others writes one row and never
 * renumbers a column.
 *
 * **`a` and `z` are bounds, not keys.** A key is always strictly between them, which is
 * what makes "put this one first" and "put this one last" always answerable: there is
 * room below every key and above every key, for ever. When two neighbours have no room
 * between them at one character, the key grows another — `b` and `c` become `bn` — and a
 * string that grows by one character per collision can never run out.
 */
const LOW = 'a'.charCodeAt(0);
const HIGH = 'z'.charCodeAt(0);

/**
 * A key strictly between `before` and `after`. `null` means "the end of the column":
 * `between(null, null)` opens an empty column, `between(last, null)` appends, and
 * `between(null, first)` puts a task at the top.
 */
export function between(before: string | null, after: string | null): string {
  let a = before ?? '';
  let b = after ?? '';
  // A reversed pair is a caller's mistake, not a reason to lose the move: treat it as
  // "after `before`", which is what a drag to the end would have meant.
  if (a !== '' && b !== '' && a >= b) b = '';

  let prefix = '';
  for (let i = 0; ; i += 1) {
    // A key that has run out is its lower bound; the other side is unbounded once the
    // prefixes have already parted.
    const x = i < a.length ? a.charCodeAt(i) : LOW;
    const y = i < b.length ? b.charCodeAt(i) : HIGH + 1;
    if (y - x > 1) return prefix + String.fromCharCode(Math.floor((x + y) / 2));
    // No room at this character: keep the lower side's and look one level deeper.
    prefix += String.fromCharCode(x);
    if (i >= a.length) a = '';
  }
}

/** The key that puts a task at the end of a column whose last key is `last`. */
export function append(last: string | null): string {
  return between(last, null);
}
