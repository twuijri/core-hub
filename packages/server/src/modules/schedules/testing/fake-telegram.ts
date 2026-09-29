/**
 * Telegram's Bot API `sendMessage`, in memory, behind a `fetch` (DECISIONS §124, §137).
 *
 * It judges a message the way Telegram does: `parse_mode` must be absent, `HTML` or
 * `MarkdownV2` (anything else is refused); the markup is parsed into the text Telegram keeps and
 * its entities, with Telegram's own refusals — `Bad Request: can't parse entities: …` for an
 * unsupported tag, an unclosed entity or an unescaped reserved character — and the parsed text
 * must be 1 to 4096 characters (UTF-16 units). It is its own parser, written from the Bot API's
 * "Formatting options", so a test proves the hub's parts against something other than the hub.
 *
 * Chat `-100404` is one Telegram does not know. Used by the unit tests and by the e2e hub.
 */

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface FakeTelegramMessage {
  chat_id: string;
  /** The text as the hub sent it. */
  text: string;
  /** `null` when the request carried no `parse_mode` field at all. */
  parse_mode: string | null;
  /** Whether the request body had a `parse_mode` key (even `null`). */
  has_parse_mode: boolean;
  /** The text Telegram shows, markup parsed away. */
  plain: string;
  entities: TelegramEntity[];
  message_id: number;
}

export class TelegramParseError extends Error {}

const utf8Offset = (value: string, index: number) =>
  Buffer.byteLength(value.slice(0, index), 'utf8');

// ------------------------------------------------------------------------------------ HTML

const HTML_ENTITY_TYPES: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strikethrough',
  strike: 'strikethrough',
  del: 'strikethrough',
  'tg-spoiler': 'spoiler',
  span: 'spoiler',
  a: 'text_link',
  code: 'code',
  pre: 'pre',
  blockquote: 'blockquote',
  'tg-emoji': 'custom_emoji',
  'tg-time': 'date_time',
};

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    attrs,
  );
  if (!match) return null;
  return decodeHtml(match[1] ?? match[2] ?? match[3] ?? '');
}

function decodeHtml(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|lt|gt|amp|quot);/gi, (all, body: string) => {
    const lower = body.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

export function parseTelegramHtml(value: string): { text: string; entities: TelegramEntity[] } {
  let out = '';
  const entities: TelegramEntity[] = [];
  const open: Array<{ name: string; start: number; entity: TelegramEntity }> = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === '<') {
      const match =
        /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*>/.exec(
          value.slice(i),
        );
      if (!match) {
        throw new TelegramParseError(
          `Unexpected end of name token at byte offset ${utf8Offset(value, i)}`,
        );
      }
      const [raw, slash, rawName, attrs] = match as unknown as [string, string, string, string];
      const name = rawName.toLowerCase();
      if (slash) {
        const top = open.pop();
        if (!top) {
          throw new TelegramParseError(`Unexpected end tag at byte offset ${utf8Offset(value, i)}`);
        }
        if (top.name !== name) {
          throw new TelegramParseError(
            `Unmatched end tag at byte offset ${utf8Offset(value, i)}, expected "</${top.name}>", found "</${name}>"`,
          );
        }
        top.entity.length = out.length - top.start;
        if (top.entity.length > 0) entities.push(top.entity);
      } else {
        const type = HTML_ENTITY_TYPES[name];
        if (!type || (name === 'span' && attribute(attrs, 'class') !== 'tg-spoiler')) {
          throw new TelegramParseError(
            `Unsupported start tag "${name}" at byte offset ${utf8Offset(value, i)}`,
          );
        }
        const inside = open.at(-1)?.name;
        if (inside === 'code' || (inside === 'pre' && name !== 'code')) {
          throw new TelegramParseError(
            `Unsupported start tag "${name}" inside "${inside}" at byte offset ${utf8Offset(value, i)}`,
          );
        }
        const entity: TelegramEntity = { type, offset: out.length, length: 0 };
        if (name === 'a') entity.url = attribute(attrs, 'href') ?? '';
        if (name === 'code') {
          const language = /^language-(.+)$/.exec(attribute(attrs, 'class') ?? '')?.[1];
          if (language && inside === 'pre') {
            open.at(-1)!.entity.language = language;
          }
        }
        open.push({ name, start: out.length, entity });
      }
      i += raw.length;
      continue;
    }
    if (c === '&') {
      const match = /^&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|lt|gt|amp|quot);/.exec(value.slice(i));
      if (match) {
        out += decodeHtml(match[0]);
        i += match[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  if (open.length > 0) {
    throw new TelegramParseError(
      `Can't find end tag corresponding to start tag "${open.at(-1)!.name}"`,
    );
  }
  return { text: out, entities: entities.sort((a, b) => a.offset - b.offset) };
}

// ------------------------------------------------------------------------------ MarkdownV2

const MD_RESERVED = '_*[]()~`>#+-=|{}.!';
const MD_TYPES: Array<[string, string]> = [
  ['||', 'spoiler'],
  ['__', 'underline'],
  ['*', 'bold'],
  ['_', 'italic'],
  ['~', 'strikethrough'],
];

const NAMES: Record<string, string> = {
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strikethrough: 'Strikethrough',
  spoiler: 'Spoiler',
  code: 'Code',
  pre: 'Pre',
  text_link: 'TextUrl',
  custom_emoji: 'CustomEmoji',
};

export function parseTelegramMarkdownV2(value: string): {
  text: string;
  entities: TelegramEntity[];
} {
  let out = '';
  const entities: TelegramEntity[] = [];
  const open: Array<{ type: string; marker: string; start: number; byte: number }> = [];
  let quote: { start: number; expandable: boolean } | null = null;
  let lineStart = true;
  const endQuote = () => {
    if (quote && out.length > quote.start) {
      entities.push({
        type: quote.expandable ? 'expandable_blockquote' : 'blockquote',
        offset: quote.start,
        length: out.replace(/\n+$/, '').length - quote.start,
      });
    }
    quote = null;
  };
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    const top = open.at(-1);
    if (top?.type === 'code' || top?.type === 'pre') {
      if (c === '\\' && i + 1 < value.length) {
        out += value[i + 1];
        i += 2;
        continue;
      }
      const end = top.type === 'pre' ? '```' : '`';
      if (value.startsWith(end, i)) {
        open.pop();
        entities.push({ type: top.type, offset: top.start, length: out.length - top.start });
        i += end.length;
        continue;
      }
      if (c === '`') {
        throw new TelegramParseError(
          `Character '\`' is reserved and must be escaped with the preceding '\\'`,
        );
      }
      out += c;
      i += 1;
      continue;
    }
    if (lineStart) {
      lineStart = false;
      if (value.startsWith('**>', i) || c === '>') {
        const expandable = value.startsWith('**>', i);
        if (!quote) quote = { start: out.length, expandable };
        i += expandable ? 3 : 1;
        continue;
      }
      if (quote) endQuote();
    }
    if (c === '\\') {
      const next = value[i + 1];
      if (next === undefined) {
        throw new TelegramParseError(`Can't find end of the entity at byte offset ${i}`);
      }
      out += next;
      i += 2;
      continue;
    }
    if (c === '\n') {
      out += c;
      lineStart = true;
      i += 1;
      continue;
    }
    if (
      (quote as { expandable: boolean } | null)?.expandable &&
      value.startsWith('||', i) &&
      top?.type !== 'spoiler' &&
      (i + 2 === value.length || value[i + 2] === '\n')
    ) {
      i += 2;
      endQuote();
      continue;
    }
    if (value.startsWith('```', i)) {
      const newline = value.indexOf('\n', i + 3);
      const closing = value.indexOf('```', i + 3);
      let skip = 3;
      if (newline >= 0 && (closing < 0 || newline < closing)) skip = newline - i + 1;
      open.push({ type: 'pre', marker: '```', start: out.length, byte: utf8Offset(value, i) });
      i += skip;
      continue;
    }
    if (c === '`') {
      open.push({ type: 'code', marker: '`', start: out.length, byte: utf8Offset(value, i) });
      i += 1;
      continue;
    }
    if (c === '[' || (c === '!' && value[i + 1] === '[')) {
      const emoji = c === '!';
      open.push({
        type: emoji ? 'custom_emoji' : 'text_link',
        marker: '[',
        start: out.length,
        byte: utf8Offset(value, i),
      });
      i += emoji ? 2 : 1;
      continue;
    }
    if (c === ']' && (top?.type === 'text_link' || top?.type === 'custom_emoji')) {
      if (value[i + 1] !== '(') {
        throw new TelegramParseError(
          `Can't find end of ${NAMES[top.type]} entity at byte offset ${top.byte}`,
        );
      }
      let j = i + 2;
      let url = '';
      while (j < value.length && value[j] !== ')') {
        if (value[j] === '\\') j += 1;
        url += value[j] ?? '';
        j += 1;
      }
      if (j >= value.length) {
        throw new TelegramParseError(
          `Can't find end of a url at byte offset ${utf8Offset(value, i + 2)}`,
        );
      }
      open.pop();
      entities.push({
        type: top.type,
        offset: top.start,
        length: out.length - top.start,
        ...(top.type === 'text_link' ? { url } : {}),
      });
      i = j + 1;
      continue;
    }
    const marker = MD_TYPES.find(([mark]) => value.startsWith(mark, i));
    if (marker) {
      const [mark, type] = marker;
      if (top?.type === type) {
        open.pop();
        if (out.length > top.start) {
          entities.push({ type, offset: top.start, length: out.length - top.start });
        }
      } else if (open.some((each) => each.type === type)) {
        const inner = open.at(-1)!;
        throw new TelegramParseError(
          `Can't find end of ${NAMES[inner.type] ?? inner.type} entity at byte offset ${inner.byte}`,
        );
      } else {
        open.push({ type, marker: mark, start: out.length, byte: utf8Offset(value, i) });
      }
      i += mark.length;
      continue;
    }
    if (MD_RESERVED.includes(c)) {
      throw new TelegramParseError(
        `Character '${c}' is reserved and must be escaped with the preceding '\\'`,
      );
    }
    out += c;
    i += 1;
  }
  if (open.length > 0) {
    const inner = open.at(-1)!;
    throw new TelegramParseError(
      `Can't find end of ${NAMES[inner.type] ?? inner.type} entity at byte offset ${inner.byte}`,
    );
  }
  endQuote();
  return { text: out, entities: entities.sort((a, b) => a.offset - b.offset) };
}

// ---------------------------------------------------------------------------------- the API

export interface FakeTelegram {
  fetch: typeof fetch;
  /** Every message Telegram took, in order. */
  sent: FakeTelegramMessage[];
  /** Every `sendMessage` asked, taken or not. */
  requests: Array<{ url: string; body: Record<string, unknown> }>;
}

export function fakeTelegram(options: { firstMessageId?: number } = {}): FakeTelegram {
  const sent: FakeTelegramMessage[] = [];
  const requests: FakeTelegram['requests'] = [];
  const refuse = (description: string, status = 400) =>
    Response.json({ ok: false, error_code: status, description }, { status });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ url: String(url), body });
    const chat = String(body.chat_id ?? '');
    if (chat === '-100404') return refuse('Bad Request: chat not found');
    const text = typeof body.text === 'string' ? body.text : '';
    const hasMode = Object.prototype.hasOwnProperty.call(body, 'parse_mode');
    const mode = hasMode ? body.parse_mode : undefined;
    let parsed: { text: string; entities: TelegramEntity[] };
    try {
      if (mode === undefined) parsed = { text, entities: [] };
      else if (mode === 'HTML') parsed = parseTelegramHtml(text);
      else if (mode === 'MarkdownV2') parsed = parseTelegramMarkdownV2(text);
      else return refuse(`Bad Request: unsupported parse_mode "${String(mode)}"`);
    } catch (error) {
      if (error instanceof TelegramParseError) {
        return refuse(`Bad Request: can't parse entities: ${error.message}`);
      }
      throw error;
    }
    if (!parsed.text.trim()) return refuse('Bad Request: message text is empty');
    if (parsed.text.length > 4096) return refuse('Bad Request: message is too long');
    const messageId = (options.firstMessageId ?? 9000) + sent.length;
    sent.push({
      chat_id: chat,
      text,
      parse_mode: typeof mode === 'string' ? mode : null,
      has_parse_mode: hasMode,
      plain: parsed.text,
      entities: parsed.entities,
      message_id: messageId,
    });
    return Response.json({ ok: true, result: { message_id: messageId } });
  }) as typeof fetch;
  return { fetch: fetchImpl, sent, requests };
}
