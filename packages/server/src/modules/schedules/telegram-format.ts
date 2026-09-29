/**
 * Telegram formatting of a "Send message" step (DECISIONS §137): per Telegram target, the words
 * go as plain text (no `parse_mode`, as before), as Telegram HTML (`parse_mode: "HTML"`) or as
 * MarkdownV2 (`parse_mode: "MarkdownV2"`; never the legacy `Markdown`). Only these three values
 * are accepted — a stored value is never handed to Telegram as it is.
 *
 * A formatted message longer than one Telegram message is split on the text Telegram counts
 * (the words after its entities are parsed: tags, markers and escapes count nothing, an entity
 * `&lt;` counts one), with a margin, and never inside a tag, an entity, an escape, a custom emoji
 * or a date. A span that must be split is closed at the end of a part and opened again at the
 * start of the next, so each part is valid on its own (Bot API "Formatting options").
 */

/** The formatting values a target may name; the contract keeps it a plain string. */
export const SEND_FORMATTINGS = ['plain', 'html', 'markdown_v2'] as const;
export type SendFormatting = (typeof SEND_FORMATTINGS)[number];

/** What Telegram counts for a formatted part, kept under its 4096 with a margin. */
export const FORMATTED_MAX_CHARS = 4000;

/** A target's formatting: absent or `null` is plain (every step saved before §137); anything else unknown is `null`. */
export function formattingOf(value: unknown): SendFormatting | null {
  if (value === undefined || value === null) return 'plain';
  return (SEND_FORMATTINGS as readonly unknown[]).includes(value) ? (value as SendFormatting) : null;
}

/** Telegram's `parse_mode` for a formatting; plain sends none at all. */
export function parseModeOf(formatting: SendFormatting): 'HTML' | 'MarkdownV2' | null {
  return formatting === 'html' ? 'HTML' : formatting === 'markdown_v2' ? 'MarkdownV2' : null;
}

/** The formatting's name in a reason: `HTML`, `MarkdownV2`, `plain text`. */
export function formattingName(formatting: SendFormatting): string {
  return parseModeOf(formatting) ?? 'plain text';
}

/**
 * Telegram refused the markup (`Bad Request: can't parse entities: …`): said with the mode, so a
 * person knows it is the formatting and not the chat — `Telegram HTML formatting failed: …`.
 * Another refusal is Telegram's own words, unchanged.
 */
export function formattingRefusal(formatting: SendFormatting, description: string): string {
  if (formatting === 'plain' || !/can't parse entities/i.test(description)) return description;
  const said = description.replace(/^\s*Bad Request:\s*/i, '');
  return `Telegram ${formattingName(formatting)} formatting failed: ${said}`;
}

/** One indivisible piece of a formatted text, as the splitter walks it. */
interface Atom {
  kind: 'text' | 'open' | 'close';
  raw: string;
  /** What Telegram counts of it (UTF-16 units of the parsed text); tags and markers count 0. */
  visible: number;
  /** For `open`: how the span is closed and opened again around a cut. */
  item?: Item;
  /** A marker made of `_` (MarkdownV2), which must not touch another one. */
  underscore?: boolean;
  /** Written before the reopened spans when a part starts at this atom (a quote's `>`). */
  prefix: string;
  /** Written after the closed spans when a part ends before this atom (an expandable quote's `||`). */
  cutClose: string;
}

interface Item {
  close: string;
  reopen: string;
  /** Nothing inside may be cut (a custom emoji, a date). */
  lock: boolean;
  underscore: boolean;
}

export interface Tokenized {
  atoms: Atom[];
  /** Why the markup cannot be walked safely; `null` when it can. */
  problem: string | null;
}

const text = (raw: string, visible = raw.length): Atom => ({
  kind: 'text',
  raw,
  visible,
  prefix: '',
  cutClose: '',
});

/** One character (a surrogate pair whole) at `i`. */
function charAt(value: string, i: number): string {
  const code = value.charCodeAt(i);
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) return value.slice(i, i + 2);
  return value[i]!;
}

// ------------------------------------------------------------------------------------ HTML

/** The tags Telegram's HTML accepts (Bot API "HTML style"); any other it refuses. */
export const TELEGRAM_HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'span',
  'tg-spoiler',
  'a',
  'tg-emoji',
  'tg-time',
  'code',
  'pre',
  'blockquote',
]);

const TAG =
  /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*>/y;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|(lt|gt|amp|quot));/y;

export function tokenizeHtml(value: string): Tokenized {
  const atoms: Atom[] = [];
  const open: string[] = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === '<') {
      TAG.lastIndex = i;
      const match = TAG.exec(value);
      if (!match) return { atoms, problem: `an unexpected "<" at character ${i + 1}` };
      const [raw, slash, rawName] = match as unknown as [string, string, string];
      const name = rawName.toLowerCase();
      if (!TELEGRAM_HTML_TAGS.has(name)) {
        return { atoms, problem: `the tag <${name}> is not one Telegram supports` };
      }
      if (slash) {
        if (open.at(-1) !== name) {
          return {
            atoms,
            problem: open.length
              ? `</${name}> does not close <${open.at(-1)!}>`
              : `</${name}> closes nothing`,
          };
        }
        open.pop();
        atoms.push({ kind: 'close', raw, visible: 0, prefix: '', cutClose: '' });
      } else {
        open.push(name);
        atoms.push({
          kind: 'open',
          raw,
          visible: 0,
          prefix: '',
          cutClose: '',
          item: {
            close: `</${name}>`,
            reopen: raw,
            lock: name === 'tg-emoji' || name === 'tg-time',
            underscore: false,
          },
        });
      }
      i += raw.length;
      continue;
    }
    if (c === '&') {
      ENTITY.lastIndex = i;
      const match = ENTITY.exec(value);
      if (match) {
        const code = match[1] ? Number(match[1]) : match[2] ? parseInt(match[2], 16) : 0;
        atoms.push(text(match[0], code > 0xffff ? 2 : 1));
        i += match[0].length;
        continue;
      }
    }
    const one = charAt(value, i);
    atoms.push(text(one));
    i += one.length;
  }
  if (open.length > 0) return { atoms, problem: `<${open.at(-1)!}> is not closed` };
  return { atoms, problem: null };
}

// ------------------------------------------------------------------------------ MarkdownV2

/** Characters MarkdownV2 reserves outside an entity: each must be escaped with `\`. */
const RESERVED = new Set('_*[]()~`>#+-=|{}.!'.split(''));

const INLINE: Array<{ marker: string; type: string }> = [
  { marker: '||', type: 'spoiler' },
  { marker: '__', type: 'underline' },
  { marker: '*', type: 'bold' },
  { marker: '_', type: 'italic' },
  { marker: '~', type: 'strike' },
];

/** The first unescaped `ch` at or after `from`, or -1. */
function unescaped(value: string, ch: string, from: number): number {
  for (let i = from; i < value.length; i += 1) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value[i] === ch) return i;
  }
  return -1;
}

/** Where a link's text ends (`]` followed by `(`) and its `(…)` part, or null. */
function linkEnd(value: string, from: number): { at: number; close: string } | null {
  for (let i = from; i < value.length; i += 1) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value[i] === '`') {
      // A code span inside the link text: skip it whole.
      const end = unescaped(value, '`', i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (value[i] === ']') {
      if (value[i + 1] !== '(') return null;
      const end = unescaped(value, ')', i + 2);
      if (end < 0) return null;
      return { at: i, close: value.slice(i, end + 1) };
    }
  }
  return null;
}

export function tokenizeMarkdownV2(value: string): Tokenized {
  const atoms: Atom[] = [];
  const stack: Array<{ type: string; closeAt?: number; closeRaw?: string }> = [];
  let lineStart = true;
  let quoteLine = false;
  let expandable = false;
  const push = (atom: Omit<Atom, 'prefix' | 'cutClose'>, marker = false) => {
    const prefix = expandable
      ? marker
        ? '**'
        : '**>'
      : quoteLine && !marker
        ? '>'
        : '';
    atoms.push({ ...atom, prefix, cutClose: expandable ? '||' : '' });
  };
  const top = () => stack.at(-1)?.type;
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    const kind = top();
    // Inside code and pre only `\` escapes and the closing backticks mean anything.
    if (kind === 'code' || kind === 'pre') {
      if (c === '\\' && i + 1 < value.length) {
        const next = charAt(value, i + 1);
        push(text(`\\${next}`, next.length));
        i += 1 + next.length;
        continue;
      }
      if (kind === 'pre' && value.startsWith('```', i)) {
        stack.pop();
        push({ kind: 'close', raw: '```', visible: 0 });
        i += 3;
        lineStart = false;
        continue;
      }
      if (kind === 'code' && c === '`') {
        stack.pop();
        push({ kind: 'close', raw: '`', visible: 0 });
        i += 1;
        continue;
      }
      const one = charAt(value, i);
      push(text(one));
      if (one === '\n') lineStart = true;
      i += one.length;
      continue;
    }
    // The end of a link's (or custom emoji's) text: `](…)`, which counts nothing.
    const link = stack.at(-1);
    if ((kind === 'link' || kind === 'emoji') && link?.closeAt === i) {
      stack.pop();
      push({ kind: 'close', raw: link.closeRaw!, visible: 0 });
      i += link.closeRaw!.length;
      continue;
    }
    if (lineStart) {
      lineStart = false;
      if (value.startsWith('**>', i) && !expandable) {
        // Written before the quote begins: a part starting here needs nothing in front.
        quoteLine = false;
        push({ kind: 'text', raw: '**>', visible: 0 }, true);
        expandable = true;
        quoteLine = true;
        i += 3;
        continue;
      }
      if (c === '>') {
        quoteLine = true;
        push({ kind: 'text', raw: '>', visible: 0 }, true);
        i += 1;
        continue;
      }
      quoteLine = false;
      if (expandable) expandable = false;
    }
    if (c === '\\') {
      if (i + 1 >= value.length) return { atoms, problem: 'the text ends with a lone "\\"' };
      const next = charAt(value, i + 1);
      push(text(`\\${next}`, next.length));
      i += 1 + next.length;
      continue;
    }
    if (c === '\n') {
      push(text('\n'));
      lineStart = true;
      i += 1;
      continue;
    }
    // An expandable quote's last line ends with `||`.
    if (
      expandable &&
      value.startsWith('||', i) &&
      kind !== 'spoiler' &&
      (i + 2 === value.length || value[i + 2] === '\n')
    ) {
      push({ kind: 'text', raw: '||', visible: 0 }, true);
      expandable = false;
      i += 2;
      continue;
    }
    if (value.startsWith('```', i)) {
      const newline = value.indexOf('\n', i + 3);
      const closing = value.indexOf('```', i + 3);
      const lang =
        newline >= 0 && (closing < 0 || newline < closing) ? value.slice(i + 3, newline) : '';
      const raw = newline >= 0 && (closing < 0 || newline < closing) ? `\`\`\`${lang}\n` : '```';
      stack.push({ type: 'pre' });
      push({
        kind: 'open',
        raw,
        visible: 0,
        item: { close: '```', reopen: `\`\`\`${lang}\n`, lock: false, underscore: false },
      });
      i += raw.length;
      continue;
    }
    if (c === '`') {
      stack.push({ type: 'code' });
      push({
        kind: 'open',
        raw: '`',
        visible: 0,
        item: { close: '`', reopen: '`', lock: false, underscore: false },
      });
      i += 1;
      continue;
    }
    if (c === '[' || (c === '!' && value[i + 1] === '[')) {
      const emoji = c === '!';
      const start = i + (emoji ? 2 : 1);
      const end = linkEnd(value, start);
      if (!end) return { atoms, problem: `a link at character ${i + 1} has no "](…)"` };
      stack.push({ type: emoji ? 'emoji' : 'link', closeAt: end.at, closeRaw: end.close });
      push({
        kind: 'open',
        raw: emoji ? '![' : '[',
        visible: 0,
        item: { close: end.close, reopen: emoji ? '![' : '[', lock: emoji, underscore: false },
      });
      i = start;
      continue;
    }
    const inline = INLINE.find((each) => value.startsWith(each.marker, i));
    if (inline) {
      const underscore = inline.marker.startsWith('_');
      if (kind === inline.type) {
        stack.pop();
        push({ kind: 'close', raw: inline.marker, visible: 0, underscore });
      } else if (stack.some((each) => each.type === inline.type)) {
        return {
          atoms,
          problem: `"${inline.marker}" at character ${i + 1} closes across another entity`,
        };
      } else {
        stack.push({ type: inline.type });
        push({
          kind: 'open',
          raw: inline.marker,
          visible: 0,
          underscore,
          item: { close: inline.marker, reopen: inline.marker, lock: false, underscore },
        });
      }
      i += inline.marker.length;
      continue;
    }
    if (RESERVED.has(c)) {
      return { atoms, problem: `"${c}" at character ${i + 1} must be escaped with "\\"` };
    }
    const one = charAt(value, i);
    push(text(one));
    i += one.length;
  }
  if (stack.length > 0) {
    const open = stack.at(-1)!.type;
    return { atoms, problem: `a ${open} entity is not closed` };
  }
  return { atoms, problem: null };
}

// ------------------------------------------------------------------------------- splitting

const isSpace = (atom: Atom | undefined) =>
  !!atom && atom.kind === 'text' && atom.visible > 0 && /^\s+$/.test(atom.raw);

interface Cut {
  /** The atom the part ends before. */
  index: number;
  /** How much of the part's text is written at that point. */
  mark: number;
  lastUnderscore: 'original' | 'synthetic' | null;
  stack: Item[];
  visible: number;
}

class Builder {
  pieces: string[] = [];
  lastUnderscore: 'original' | 'synthetic' | null = null;

  add(raw: string, underscore: boolean, synthetic: boolean): void {
    if (!raw) return;
    // `_` next to `__` reads as another marker; an empty bold entity keeps them apart (Bot API).
    if (
      underscore &&
      this.lastUnderscore &&
      (synthetic || this.lastUnderscore === 'synthetic')
    ) {
      this.pieces.push('**');
    }
    this.pieces.push(raw);
    this.lastUnderscore = underscore ? (synthetic ? 'synthetic' : 'original') : null;
  }
}

/**
 * Cut a tokenized formatted text into parts that each count at most `max` for Telegram, on a
 * paragraph, then a line, then a word boundary, else between two characters; the spans open at
 * a cut are closed there and opened again in the next part. `null` when nothing can be cut
 * (a locked span longer than a message).
 */
export function splitAtoms(atoms: Atom[], max: number): string[] | null {
  const parts: string[] = [];
  let stack: Item[] = [];
  let i = 0;
  while (i < atoms.length) {
    const build = new Builder();
    const first = atoms[i]!;
    if (first.prefix) build.add(first.prefix, false, true);
    for (const item of stack) build.add(item.reopen, item.underscore, true);
    const local = [...stack];
    let visible = 0;
    let content = 0;
    const best: Record<'para' | 'line' | 'space' | 'hard', Cut | null> = {
      para: null,
      line: null,
      space: null,
      hard: null,
    };
    const locked = () => local.some((item) => item.lock);
    const cutHere = (j: number): Cut => ({
      index: j,
      mark: build.pieces.length,
      lastUnderscore: build.lastUnderscore,
      stack: [...local],
      visible,
    });
    let j = i;
    let overflow = false;
    while (j < atoms.length) {
      const atom = atoms[j]!;
      if (atom.kind === 'text' && atom.visible > 0) {
        if (visible + atom.visible > max) {
          overflow = true;
          if (!locked() && content > 0) best.hard = cutHere(j);
          break;
        }
        if (!locked() && content > 0) {
          if (isSpace(atom) && !isSpace(atoms[j - 1])) {
            let k = j;
            let lines = 0;
            while (isSpace(atoms[k])) {
              if (atoms[k]!.raw.includes('\n')) lines += atoms[k]!.raw.split('\n').length - 1;
              k += 1;
            }
            const type = lines >= 2 ? 'para' : lines === 1 ? 'line' : 'space';
            best[type] = cutHere(j);
          } else if (!isSpace(atom)) {
            best.hard = cutHere(j);
          }
        }
        build.add(atom.raw, false, false);
        visible += atom.visible;
        if (!isSpace(atom)) content += 1;
      } else {
        build.add(atom.raw, atom.underscore ?? false, false);
        if (atom.kind === 'open' && atom.item) local.push(atom.item);
        if (atom.kind === 'close') local.pop();
      }
      j += 1;
    }
    if (!overflow) {
      if (content > 0) parts.push(build.pieces.join(''));
      break;
    }
    const quarter = max / 4;
    const cut =
      [best.para, best.line, best.space].find((each) => each && each.visible >= quarter) ??
      best.hard ??
      best.para ??
      best.line ??
      best.space;
    if (!cut) return null;
    const out = new Builder();
    out.pieces = build.pieces.slice(0, cut.mark);
    out.lastUnderscore = cut.lastUnderscore;
    for (const item of [...cut.stack].reverse()) out.add(item.close, item.underscore, true);
    const edge = atoms[cut.index]!;
    if (edge.cutClose) out.add(edge.cutClose, false, true);
    parts.push(out.pieces.join(''));
    stack = cut.stack;
    i = cut.index;
    while (isSpace(atoms[i])) i += 1;
  }
  return parts;
}

/**
 * The parts a formatted text is sent in. A text Telegram counts within `max` goes whole, as it
 * is (Telegram judges its markup). A longer one is split safely, or refused — before anything
 * is sent — when its markup cannot be walked (`problem`).
 */
export function splitFormatted(
  value: string,
  formatting: Exclude<SendFormatting, 'plain'>,
  max: number = FORMATTED_MAX_CHARS,
): { parts: string[] } | { problem: string } {
  const trimmed = value.trim();
  const { atoms, problem } =
    formatting === 'html' ? tokenizeHtml(trimmed) : tokenizeMarkdownV2(trimmed);
  const counted = problem ? trimmed.length : atoms.reduce((sum, atom) => sum + atom.visible, 0);
  if (counted <= max) return { parts: trimmed ? [trimmed] : [] };
  if (problem) {
    return {
      problem: `the message is longer than one Telegram message and its ${formattingName(formatting)} cannot be split safely (${problem})`,
    };
  }
  const parts = splitAtoms(atoms, max);
  if (!parts) {
    return {
      problem: `the message is longer than one Telegram message and a custom emoji or date in it is too long to split`,
    };
  }
  return { parts };
}
