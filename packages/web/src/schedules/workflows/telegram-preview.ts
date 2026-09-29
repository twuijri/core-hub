/**
 * The preview of a "Send message" step's words as Telegram will show them (DECISIONS §137).
 *
 * The words are parsed here into a small tree of Telegram's own entities — bold, italic,
 * underline, strikethrough, spoiler, code, pre, blockquote and links — and the preview draws that
 * tree with React elements. No HTML from the words is ever put into the page: a tag Telegram does
 * not know, an unclosed one or an unescaped MarkdownV2 character is reported instead
 * (`ok: false`), so the person sees that Telegram would refuse it before sending.
 */

export type TelegramFormatting = 'plain' | 'html' | 'markdown_v2';

export const TELEGRAM_FORMATTINGS: readonly TelegramFormatting[] = ['plain', 'html', 'markdown_v2'];

export type TgKind =
  'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' | 'code' | 'pre' | 'quote' | 'link';

export type TgNode = { kind: 'text'; text: string } | TgElement;

export interface TgElement {
  kind: TgKind;
  href?: string;
  /** A custom emoji's or a date's group: shown as its text only. */
  plain?: boolean;
  children: TgNode[];
}

export type TgParse = { ok: true; nodes: TgNode[] } | { ok: false; error: string };

/** A target's formatting as this client reads it: absent or unknown is plain. */
export function formattingOf(value: unknown): TelegramFormatting {
  return value === 'html' || value === 'markdown_v2' ? value : 'plain';
}

/** Telegram's `parse_mode` name of a formatting, as the preview says it. */
export function parseModeName(formatting: TelegramFormatting): string {
  return formatting === 'html' ? 'HTML' : formatting === 'markdown_v2' ? 'MarkdownV2' : '';
}

class Tree {
  root: TgElement = { kind: 'bold', children: [] };
  stack: Array<{ el: TgElement; tag: string }> = [{ el: this.root, tag: '' }];

  get top() {
    return this.stack.at(-1)!;
  }

  text(value: string) {
    if (!value) return;
    const children = this.top.el.children;
    const last = children.at(-1);
    if (last && last.kind === 'text') last.text += value;
    else children.push({ kind: 'text', text: value });
  }

  open(kind: TgKind, tag: string, href?: string) {
    const el: TgElement = { kind, children: [], ...(href !== undefined ? { href } : {}) };
    this.top.el.children.push(el);
    this.stack.push({ el, tag });
  }

  close() {
    this.stack.pop();
  }
}

// ------------------------------------------------------------------------------------ HTML

const HTML_KINDS: Record<string, TgKind | null> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  'tg-spoiler': 'spoiler',
  span: 'spoiler',
  code: 'code',
  pre: 'pre',
  blockquote: 'quote',
  a: 'link',
  // Shown as their text: a custom emoji's fallback emoji, a date's words.
  'tg-emoji': null,
  'tg-time': null,
};

const TAG =
  /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*>/;

function decode(value: string): string {
  return value.replace(
    /&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|lt|gt|amp|quot);/g,
    (all, body: string) => {
      if (body === 'lt') return '<';
      if (body === 'gt') return '>';
      if (body === 'amp') return '&';
      if (body === 'quot') return '"';
      const code = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    },
  );
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    attrs,
  );
  return match ? decode(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

export function parseTelegramHtml(value: string): TgParse {
  const tree = new Tree();
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === '<') {
      const match = TAG.exec(value.slice(i));
      if (!match)
        return { ok: false, error: `“<” at character ${i + 1} is not a tag (write &lt;)` };
      const [raw, slash, rawName, attrs] = match as unknown as [string, string, string, string];
      const name = rawName.toLowerCase();
      if (!(name in HTML_KINDS)) return { ok: false, error: `<${name}> is not a Telegram tag` };
      if (name === 'span' && attribute(attrs, 'class') !== 'tg-spoiler') {
        return { ok: false, error: '<span> needs class="tg-spoiler"' };
      }
      if (slash) {
        if (tree.top.tag !== name) {
          return {
            ok: false,
            error: tree.top.tag
              ? `</${name}> does not close <${tree.top.tag}>`
              : `</${name}> closes nothing`,
          };
        }
        tree.close();
      } else {
        const kind = HTML_KINDS[name];
        const inside = tree.top.tag;
        if (inside === 'code' || (inside === 'pre' && name !== 'code')) {
          return { ok: false, error: `<${name}> cannot be inside <${inside}>` };
        }
        if (kind === null) {
          // Kept as a plain group so its closing tag matches.
          tree.open('bold', name);
          tree.top.el.plain = true;
        } else if (name === 'code' && inside === 'pre') {
          tree.stack.push({ el: tree.top.el, tag: 'code' });
        } else {
          tree.open(kind!, name, name === 'a' ? (attribute(attrs, 'href') ?? '') : undefined);
        }
      }
      i += raw.length;
      continue;
    }
    if (c === '&') {
      const match = /^&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|lt|gt|amp|quot);/.exec(value.slice(i));
      if (match) {
        tree.text(decode(match[0]));
        i += match[0].length;
        continue;
      }
    }
    tree.text(c);
    i += 1;
  }
  if (tree.stack.length > 1) return { ok: false, error: `<${tree.top.tag}> is not closed` };
  return { ok: true, nodes: unwrapPlain(tree.root.children) };
}

/** A custom emoji's or date's group is shown as its text. */
function unwrapPlain(nodes: TgNode[]): TgNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'text') return [node];
    const children = unwrapPlain(node.children);
    return node.plain ? children : [{ ...node, children }];
  });
}

// ------------------------------------------------------------------------------ MarkdownV2

const RESERVED = '_*[]()~`>#+-=|{}.!';
const MARKERS: Array<[string, TgKind]> = [
  ['||', 'spoiler'],
  ['__', 'underline'],
  ['*', 'bold'],
  ['_', 'italic'],
  ['~', 'strike'],
];

export function parseTelegramMarkdownV2(value: string): TgParse {
  const tree = new Tree();
  let lineStart = true;
  let quote: { expandable: boolean } | null = null;
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    const tag = tree.top.tag;
    if (tag === 'code' || tag === 'pre') {
      if (c === '\\' && i + 1 < value.length) {
        tree.text(value[i + 1]!);
        i += 2;
        continue;
      }
      const end = tag === 'pre' ? '```' : '`';
      if (value.startsWith(end, i)) {
        tree.close();
        i += end.length;
        continue;
      }
      tree.text(c);
      if (c === '\n') lineStart = true;
      i += 1;
      continue;
    }
    if (lineStart) {
      lineStart = false;
      const expandable = value.startsWith('**>', i);
      if (expandable || c === '>') {
        if (!quote) {
          if (tree.stack.length > 1)
            return { ok: false, error: 'a quote cannot start inside another entity' };
          quote = { expandable };
          tree.open('quote', 'quote');
        }
        i += expandable ? 3 : 1;
        continue;
      }
      if (quote) {
        if (tree.top.tag !== 'quote')
          return { ok: false, error: `a ${tree.top.tag} entity is not closed` };
        tree.close();
        quote = null;
      }
    }
    if (c === '\\') {
      if (i + 1 >= value.length) return { ok: false, error: 'the text ends with a lone “\\”' };
      tree.text(value[i + 1]!);
      i += 2;
      continue;
    }
    if (c === '\n') {
      tree.text('\n');
      lineStart = true;
      i += 1;
      continue;
    }
    if (
      quote?.expandable &&
      value.startsWith('||', i) &&
      tag !== 'spoiler' &&
      (i + 2 === value.length || value[i + 2] === '\n')
    ) {
      i += 2;
      continue;
    }
    if (value.startsWith('```', i)) {
      const newline = value.indexOf('\n', i + 3);
      const closing = value.indexOf('```', i + 3);
      tree.open('pre', 'pre');
      i = newline >= 0 && (closing < 0 || newline < closing) ? newline + 1 : i + 3;
      continue;
    }
    if (c === '`') {
      tree.open('code', 'code');
      i += 1;
      continue;
    }
    if (c === '[' || (c === '!' && value[i + 1] === '[')) {
      tree.open('link', c === '!' ? 'emoji' : 'link', '');
      i += c === '!' ? 2 : 1;
      continue;
    }
    if (c === ']' && (tag === 'link' || tag === 'emoji')) {
      if (value[i + 1] !== '(')
        return { ok: false, error: `a link at character ${i + 1} has no “(…)”` };
      let j = i + 2;
      let url = '';
      while (j < value.length && value[j] !== ')') {
        if (value[j] === '\\') j += 1;
        url += value[j] ?? '';
        j += 1;
      }
      if (j >= value.length) return { ok: false, error: 'a link’s address has no closing “)”' };
      const el = tree.top.el;
      if (tag === 'emoji') {
        // A custom emoji or a date shows its words.
        const parent = tree.stack.at(-2)!.el;
        parent.children.pop();
        tree.close();
        for (const child of el.children) {
          if (child.kind === 'text') tree.text(child.text);
          else tree.top.el.children.push(child);
        }
      } else {
        el.href = url;
        tree.close();
      }
      i = j + 1;
      continue;
    }
    const marker = MARKERS.find(([mark]) => value.startsWith(mark, i));
    if (marker) {
      const [mark, kind] = marker;
      if (tag === kind) tree.close();
      else if (tree.stack.some((each) => each.tag === kind)) {
        return { ok: false, error: `“${mark}” at character ${i + 1} closes across another entity` };
      } else tree.open(kind, kind);
      i += mark.length;
      continue;
    }
    if (RESERVED.includes(c)) {
      return { ok: false, error: `“${c}” at character ${i + 1} must be escaped as “\\${c}”` };
    }
    tree.text(c);
    i += 1;
  }
  if (quote && tree.top.tag === 'quote') tree.close();
  if (tree.stack.length > 1) return { ok: false, error: `a ${tree.top.tag} entity is not closed` };
  return { ok: true, nodes: tree.root.children };
}

/** The words parsed as Telegram will read them; plain words are one text node. */
export function parseTelegram(value: string, formatting: TelegramFormatting): TgParse {
  if (formatting === 'html') return parseTelegramHtml(value);
  if (formatting === 'markdown_v2') return parseTelegramMarkdownV2(value);
  return { ok: true, nodes: value ? [{ kind: 'text', text: value }] : [] };
}
