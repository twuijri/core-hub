/**
 * Text cut into parts a speech provider accepts in one request (DECISIONS §87).
 *
 * Groq's Orpheus takes at most 200 characters, far below a reply read aloud. So the text is
 * cut, in order of preference, at the end of a sentence (Latin, Arabic and CJK stops, and line
 * breaks), then at a clause (commas, semicolons), then between words — and only a single word
 * longer than the limit is ever cut inside itself. Parts keep their order; nothing is dropped
 * but the whitespace between them.
 */

/** Ends a sentence: `.`, `!`, `?`, `…`, Arabic `؟` and `۔`, CJK `。！？`, and line breaks. */
const SENTENCE = /[^.!?…؟۔。！？\n]+(?:[.!?…؟۔。！？]+|\n+|$)/gu;
/** Ends a clause: Latin and Arabic commas and semicolons, CJK `，、；`. */
const CLAUSE = /[^,;،؛，、；]+(?:[,;،؛，、；]+|$)/gu;

function pieces(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? [text]).map((piece) => piece.trim()).filter(Boolean);
}

/** Packs consecutive pieces into parts no longer than `max`, joined by a space. */
function pack(parts: string[], max: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (!current) {
      current = part;
    } else if (current.length + 1 + part.length <= max) {
      current = `${current} ${part}`;
    } else {
      out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return out;
}

/** One piece that is still too long: clauses, then words, then (a single long word) characters. */
function breakDown(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  const clauses = pieces(piece, CLAUSE);
  if (clauses.length > 1)
    return pack(
      clauses.flatMap((clause) => breakDown(clause, max)),
      max,
    );
  const words = piece.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return pack(
      words.flatMap((word) => breakDown(word, max)),
      max,
    );
  }
  const chars = Array.from(piece);
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += max) {
    out.push(chars.slice(index, index + max).join(''));
  }
  return out;
}

/**
 * `text` as parts of at most `max` characters each, cut at the best boundary available.
 * Text within the limit comes back as one part, trimmed.
 */
export function splitForSpeech(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!Number.isFinite(max) || max <= 0 || trimmed.length <= max) return [trimmed];
  const sentences = pieces(trimmed, SENTENCE).flatMap((sentence) => breakDown(sentence, max));
  return pack(sentences, max);
}
