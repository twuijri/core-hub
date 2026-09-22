/**
 * Naming a session (contract decision §26).
 *
 * `Session.title` is `null` until something names it, and a sidebar of twenty rows all
 * reading "New chat" carries no information at all. After the first assistant reply of a
 * session completes, the hub asks that session's **own** agent for a short title in the
 * conversation's language — one cheap call that is not a run — and writes it through the
 * ordinary update path.
 *
 * Everything in this file is pure so it can be tested without an agent, a database or a
 * socket: the prompt, the cleanup of whatever the agent answered, and the fallback.
 *
 * Why so much cleanup: a model asked for a title answers with a title *and* its manners —
 * `"Here you go: «خطة الإطلاق»."`, a markdown heading, a trailing full stop, a pair of
 * quotes, sometimes a whole paragraph. None of that belongs in a list row, and none of it
 * is worth a second round trip to remove.
 */

/** The contract's `Session.title` limit is 200; a sidebar row shows far less than that. */
export const TITLE_MAX = 60;

/** Everything a model wraps a title in, in both languages. */
const WRAPPERS = ['"', "'", '`', '«', '»', '“', '”', '‘', '’', '‏', '‎'];
/** Punctuation a sentence ends with and a title does not. */
const TRAILING = ['.', '،', ',', ':', '؛', ';', '!', '?', '؟', '…', '-', '–', '—'];

function stripWrappers(value: string): string {
  let text = value.trim();
  for (;;) {
    const before = text;
    // A leading markdown heading or list marker: the model formatted its answer.
    text = text.replace(/^\s*(?:#{1,6}|[-*>])\s+/, '').trim();
    while (text.length > 0 && WRAPPERS.includes(text[0] as string)) text = text.slice(1).trim();
    while (text.length > 0 && WRAPPERS.includes(text.at(-1) as string)) {
      text = text.slice(0, -1).trim();
    }
    while (text.length > 0 && TRAILING.includes(text.at(-1) as string)) {
      text = text.slice(0, -1).trim();
    }
    if (text === before) return text;
  }
}

/** Cut on a word boundary when there is one near the end; never mid-word, never mid-space. */
export function trimToWords(value: string, max: number = TITLE_MAX): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only respect the boundary if it leaves a title worth reading; a single very long
  // word is better truncated than reduced to nothing.
  return (lastSpace >= Math.floor(max / 2) ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The title inside whatever the agent said, or `null` when there is nothing usable.
 *
 * Only the first non-empty line is considered: a model that explains itself puts the
 * title first and the explanation after, and a "title" spanning three lines is not one.
 */
export function cleanTitle(raw: string | null | undefined, max: number = TITLE_MAX): string | null {
  if (typeof raw !== 'string') return null;
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => stripWrappers(line) !== '');
  if (firstLine === undefined) return null;
  const cleaned = trimToWords(stripWrappers(firstLine), max);
  // A model that answered with a paragraph has not answered with a title. Falling back to
  // the first user message is more honest than publishing the first 60 characters of prose.
  return cleaned === '' ? null : cleaned;
}

/**
 * The title when the agent cannot be asked, or answered with nothing: the person's own
 * first words, trimmed on a word boundary. It is never wrong, only plainer.
 */
export function fallbackTitle(firstUserMessage: string | null | undefined): string | null {
  if (typeof firstUserMessage !== 'string') return null;
  // Fenced code, inline code and images say nothing about the subject in a list row.
  const flattened = firstUserMessage
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened === '') return null;
  return trimToWords(flattened) || null;
}

/**
 * What the agent is asked. Deliberately one short turn with the transcript inlined: the
 * agent must not need tools, a folder or its memory to answer it.
 *
 * The instruction is in English because it is an instruction to a model, not text a person
 * reads; the *answer* is demanded in the conversation's own language, which is the only
 * part that shows.
 */
export function titlePrompt(exchange: { user: string; assistant: string }): string {
  const user = trimToWords(exchange.user.replace(/\s+/g, ' ').trim(), 1000);
  const assistant = trimToWords(exchange.assistant.replace(/\s+/g, ' ').trim(), 1000);
  return [
    'Name this conversation.',
    '',
    `User: ${user}`,
    `Assistant: ${assistant}`,
    '',
    'Reply with the title and nothing else: at most six words, in the same language the',
    'conversation is in, no quotation marks, no trailing punctuation, no preamble.',
  ].join('\n');
}
