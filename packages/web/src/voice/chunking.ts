/**
 * What of a reply is read aloud, and in what pieces (contract decision §54).
 *
 * A reply is Markdown. Read as it is, a voice would say "asterisk asterisk", spell out a
 * URL, and recite a whole code block character by character. So before anything reaches
 * `models.synthesize`:
 *
 * - a fenced code block becomes one short sentence, «كتلة كود» / "Code block", in the
 *   reply's own language — it is announced, never recited;
 * - Markdown's marks go (emphasis, headings, list bullets, quote bars, table pipes,
 *   link targets, images, HTML tags), and a bare URL is dropped;
 * - what remains is cut at sentence ends into chunks of at most `maxChars` (400 by
 *   default, far under the contract's 2 000), so the first words play while the rest is
 *   still being synthesized, and a long reply never hits `413`.
 *
 * `StreamingChunker` does the same for a reply that is still arriving (voice mode): it
 * hands out only what ends at a sentence boundary and is not inside a code block that has
 * not closed yet, and keeps the rest until more text, or the end, arrives.
 *
 * Pure: no DOM, no network — `tests/voice-chunking.test.ts`.
 */

/** The contract's `SpeechRequest.text.maxLength`. */
export const MAX_SPEECH_CHARS = 2000;
const DEFAULT_CHUNK = 400;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

/** Whether a text is Arabic enough to be read in Arabic. */
export function languageOf(text: string): 'ar' | 'en' {
  return ARABIC.test(text) ? 'ar' : 'en';
}

/** How a code block is announced, in the language the reply is read in. */
export function codeLabelFor(language: 'ar' | 'en'): string {
  return language === 'ar' ? 'كتلة كود' : 'Code block';
}

const FENCE = /^ {0,3}(```|~~~)/;

/** Markdown to the words a voice should say. Code blocks become `codeLabel`. */
export function speakableText(markdown: string, codeLabel: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split('\n')) {
    const opening = FENCE.exec(raw);
    if (fence) {
      if (opening && opening[1] === fence) fence = null;
      continue;
    }
    if (opening) {
      fence = opening[1]!;
      out.push(`${codeLabel}.`);
      continue;
    }
    out.push(cleanLine(raw));
  }
  return out
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
}

function cleanLine(line: string): string {
  let text = line;
  // A table's separator row says nothing; its other rows are read cell by cell.
  if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(text)) return '';
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) return ''; // a horizontal rule
  text = text.replace(/^\s{0,3}#{1,6}\s+/, ''); // heading marks
  text = text.replace(/^\s*>+\s?/, ''); // quote bars
  text = text.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''); // list bullets, task boxes
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, ''); // images
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links keep their words
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ''); // HTML tags
  text = text.replace(/https?:\/\/\S+/g, ''); // a bare address is not read out
  text = text.replace(/`([^`]*)`/g, '$1'); // inline code keeps its words
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2');
  text = text.replace(/~~(.+?)~~/g, '$1');
  // `_emphasis_`, but not the underscores inside a snake_case name.
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2');
  if (text.includes('|')) {
    text = text
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(', ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Sentence ends in both scripts, and the end of a line. */
const BOUNDARY = /([.!?؟…。]+["')\]»]*)(\s+)|\n+/g;

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(BOUNDARY)) {
    const end = (match.index ?? 0) + (match[1]?.length ?? 0);
    const piece = text.slice(last, end).trim();
    if (piece) out.push(piece);
    last = (match.index ?? 0) + match[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

/** A sentence longer than a chunk is cut at a comma, else at a space, else anywhere. */
function split(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(
      window.lastIndexOf('، '),
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf('؛ '),
    );
    const at =
      cut > max / 3 ? cut + 1 : window.lastIndexOf(' ') > max / 3 ? window.lastIndexOf(' ') : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface ChunkOptions {
  /** What a code block is read as; `codeLabelFor(languageOf(text))` when omitted. */
  codeLabel?: string;
  /** The longest chunk, in characters; never above the contract's 2 000. */
  maxChars?: number;
}

/** A whole reply, as the chunks it is read in. Empty when there is nothing to say. */
export function speakableChunks(markdown: string, options: ChunkOptions = {}): string[] {
  const max = Math.min(options.maxChars ?? DEFAULT_CHUNK, MAX_SPEECH_CHARS);
  const label = options.codeLabel ?? codeLabelFor(languageOf(markdown));
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentencesOf(speakableText(markdown, label))) {
    for (const piece of split(sentence, max)) {
      if (current && current.length + 1 + piece.length > max) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current} ${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * The same chunks for a reply that is still arriving. `push` takes the whole text so far
 * (as the transcript holds it) and returns the chunks that became safe to read; `finish`
 * returns what was left once the reply ended.
 */
export class StreamingChunker {
  private offset = 0;
  private readonly options: ChunkOptions;
  /** Below this, a finished sentence waits for company: fewer, fuller requests. */
  private readonly minChars: number;

  constructor(options: ChunkOptions & { minChars?: number } = {}) {
    this.options = options;
    this.minChars = options.minChars ?? 40;
  }

  push(full: string): string[] {
    const cut = safeCut(full, this.offset);
    if (cut <= this.offset) return [];
    const piece = full.slice(this.offset, cut);
    const label = this.options.codeLabel ?? codeLabelFor(languageOf(full));
    if (speakableText(piece, label).length < this.minChars) return [];
    this.offset = cut;
    return speakableChunks(piece, { ...this.options, codeLabel: label });
  }

  finish(full: string): string[] {
    const piece = full.slice(this.offset);
    this.offset = full.length;
    const label = this.options.codeLabel ?? codeLabelFor(languageOf(full));
    return speakableChunks(piece, { ...this.options, codeLabel: label });
  }
}

/**
 * The furthest point after `from` where the text so far can be read: just after a sentence
 * end or a line break, and never inside a code block that has not closed — a block that is
 * still open is left whole for the next push, so it is announced once.
 */
export function safeCut(full: string, from: number): number {
  let open: number | null = null;
  let fence: string | null = null;
  let position = 0;
  for (const line of full.split('\n')) {
    const opening = FENCE.exec(line);
    if (opening) {
      if (fence === null) {
        fence = opening[1]!;
        open = position;
      } else if (opening[1] === fence) {
        fence = null;
        open = null;
      }
    }
    position += line.length + 1;
  }
  const limit = open ?? full.length;
  let cut = from;
  const region = full.slice(from, limit);
  for (const match of region.matchAll(BOUNDARY)) {
    const end = from + (match.index ?? 0) + match[0].length;
    // A boundary that only ends because the text ends is not one yet: the next delta may
    // carry on the same sentence ("3." of "3.5").
    if (end < full.length || match[0].includes('\n')) cut = end;
  }
  // Everything before an open fence is complete, whatever its last character.
  if (open !== null && open > cut) cut = open;
  return cut;
}
