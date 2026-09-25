/**
 * Mentions in the room composer.
 *
 * The hub never reads `@name` out of a person's text (DECISIONS §23): the client sends the
 * seats it means as structured `mentions`. So this file is where a name typed after `@`
 * becomes a seat: the suggestion list while typing, the text a pick leaves behind, and the
 * mentions a finished message carries.
 */

export interface MentionSeat {
  id: string;
  name: string;
}

export type Mention = { kind: 'seat'; seat_id: string } | { kind: 'all'; seat_id: null };

/** A letter, a digit or `_` in any script: what continues a name. */
const WORD = /[\p{L}\p{N}_]/u;

/**
 * The `@…` being typed just before the caret, when there is one: its start and the letters
 * typed so far. An `@` in the middle of a word (an e-mail address) is not a mention.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const previous = at > 0 ? before[at - 1] : '';
  if (previous && WORD.test(previous)) return null;
  const query = before.slice(at + 1);
  // A mention ends at a line break; a name may hold spaces, but not two in a row.
  if (/\n/.test(query) || /\s\s/.test(query) || query.length > 60) return null;
  return { start: at, query };
}

/** Seats whose name starts with (or, failing that, contains) what was typed, ignoring case. */
export function suggest(seats: readonly MentionSeat[], query: string): MentionSeat[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...seats];
  const starts = seats.filter((seat) => seat.name.toLocaleLowerCase().startsWith(needle));
  const contains = seats.filter(
    (seat) => !starts.includes(seat) && seat.name.toLocaleLowerCase().includes(needle),
  );
  return [...starts, ...contains];
}

/** The text after picking `name` for the `@…` that starts at `start`, and the new caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`,
    caret: start + inserted.length,
  };
}

/**
 * The mentions a message carries: every seat whose `@name` stands in the text as a whole
 * name (not the start of a longer word), and `@all` when the room allows it. Longer names
 * are matched first, so `@Code Reviewer` is not also read as `@Code`.
 */
export function mentionsIn(
  text: string,
  seats: readonly MentionSeat[],
  allowAll: boolean,
): Mention[] {
  const found: Mention[] = [];
  const taken: Array<[number, number]> = [];
  const byLength = [...seats].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLocaleLowerCase();
  const standsAlone = (index: number, length: number) => {
    const before = index > 0 ? text[index - 1] : '';
    const after = text[index + length] ?? '';
    return !(before && WORD.test(before)) && !(after && WORD.test(after));
  };
  for (const seat of byLength) {
    const needle = `@${seat.name}`.toLocaleLowerCase();
    let from = 0;
    for (;;) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      from = index + needle.length;
      const overlaps = taken.some(([a, b]) => index < b && index + needle.length > a);
      if (overlaps || !standsAlone(index, needle.length)) continue;
      taken.push([index, index + needle.length]);
      if (!found.some((m) => m.kind === 'seat' && m.seat_id === seat.id)) {
        found.push({ kind: 'seat', seat_id: seat.id });
      }
    }
  }
  if (allowAll) {
    const index = lower.search(/@all(?![\p{L}\p{N}_])/u);
    if (index >= 0 && standsAlone(index, 4)) found.unshift({ kind: 'all', seat_id: null });
  }
  return found;
}
