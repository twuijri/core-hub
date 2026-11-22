/**
 * A small Markdown reader for the answers the plugin shows in the harness's chat (Hermes's
 * replies, the `/corehub` results): headings, paragraphs, lists, quotes, fenced code, tables,
 * rules, and inline bold, italic, strike-through, code and links.
 *
 * It returns a tree, never HTML: the browser half turns the tree into elements, so nothing in an
 * answer can inject markup, and every block can carry `dir="auto"` (an Arabic paragraph reads
 * right to left, an English one left to right, each on its own). Raw HTML stays text. Links keep
 * only `http:`, `https:` and `mailto:` addresses.
 *
 * Pure, no DOM: the host's tests read it, the browser half renders it.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'rule' }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** The blocks of a Markdown text. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i] ?? '', marker)) body.push(lines[i++] ?? '');
      i++; // the closing fence (or the end)
      blocks.push({ type: 'code', lang: (fence[2] ?? '').toLowerCase(), text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        children: parseInline(heading[2] ?? ''),
      });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() && QUOTE.test(lines[i] ?? ''))
        inner.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '');
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    if (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '') && cells(line).length > 0) {
      const head = cells(line);
      const align = cells(lines[i + 1] ?? '').map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').trim() && (lines[i] ?? '').includes('|'))
        rows.push(cells(lines[i++] ?? '').map(parseInline));
      blocks.push({ type: 'table', align, head: head.map(parseInline), rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !startsBlock(lines, i))
      para.push((lines[i++] ?? '').trim());
    if (para.length === 0) para.push((lines[i++] ?? '').trim());
    blocks.push({ type: 'paragraph', children: joinLines(para) });
  }
  return blocks;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? '';
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? ''))
  );
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(marker) && /^(`+|~+)$/.test(trimmed);
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start] ?? '';
  const ordered = ORDERED.test(first);
  const pattern = ordered ? ORDERED : BULLET;
  const startNumber = ordered ? Number(ORDERED.exec(first)?.[2] ?? '1') : 1;
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const match = pattern.exec(lines[i] ?? '');
    if (!match) break;
    const indent = (match[1] ?? '').length;
    const body = [match[3] ?? ''];
    i++;
    // Continuation lines: indented further than the marker, or a lazy line of the same item.
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (!next.trim()) {
        const after = lines[i + 1] ?? '';
        if (leading(after) > indent + 1 && after.trim()) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      if (leading(next) > indent + 1) {
        body.push(next.slice(Math.min(leading(next), indent + 2)));
        i++;
        continue;
      }
      if (pattern.test(next) || startsBlock(lines, i)) break;
      body.push(next.trim());
      i++;
    }
    items.push(parseBlocks(body));
    // A blank line between items keeps the list going.
    if (!(lines[i] ?? '').trim() && pattern.test(lines[i + 1] ?? '')) i++;
  }
  return [{ type: 'list', ordered, start: startNumber, items }, i];
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  if (c.startsWith(':')) return 'left';
  return null;
}

function joinLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: 'br' });
    out.push(...parseInline(line));
  });
  return out;
}

// ------------------------------------------------------------------ inline

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** The inline nodes of one line (or table cell). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    // Backslash escapes a punctuation mark.
    if (ch === '\\' && /[\\`*_~[\]()#+\-.!|>]/.test(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`';
      const end = text.indexOf(run, i + run.length);
      if (end > i) {
        flush();
        out.push({ type: 'code', text: text.slice(i + run.length, end).trim() || ' ' });
        i = end + run.length;
        continue;
      }
    }
    const strong = delimited(text, i, ['**', '__']);
    if (strong) {
      flush();
      out.push({ type: 'strong', children: parseInline(strong.inner) });
      i = strong.end;
      continue;
    }
    const del = delimited(text, i, ['~~']);
    if (del) {
      flush();
      out.push({ type: 'del', children: parseInline(del.inner) });
      i = del.end;
      continue;
    }
    const em = delimited(text, i, ['*', '_']);
    if (em && (ch === '*' || wordBoundary(text, i, em.end))) {
      flush();
      out.push({ type: 'em', children: parseInline(em.inner) });
      i = em.end;
      continue;
    }
    if (ch === '[') {
      const link = /^\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(text.slice(i));
      if (link) {
        flush();
        const href = link[2] ?? '';
        const children = parseInline(link[1] ?? '');
        if (SAFE_LINK.test(href)) out.push({ type: 'link', href, children });
        else out.push(...children);
        i += link[0].length;
        continue;
      }
    }
    if (
      (ch === 'h' || ch === 'H') &&
      /^https?:\/\//i.test(text.slice(i)) &&
      autolinkStart(text, i)
    ) {
      const url = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(i))?.[0] ?? '';
      const clean = url.replace(/[.,;:!?)\]}'"،؛؟]+$/u, '');
      if (clean.length > 'https://'.length - 1) {
        flush();
        out.push({ type: 'link', href: clean, children: [{ type: 'text', text: clean }] });
        i += clean.length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

function delimited(
  text: string,
  at: number,
  markers: string[],
): { inner: string; end: number } | null {
  for (const marker of markers) {
    if (!text.startsWith(marker, at)) continue;
    const open = at + marker.length;
    const next = text[open] ?? '';
    if (!next || /\s/.test(next)) continue;
    // A single marker must not be the first half of a double one.
    if (marker.length === 1 && text[open] === marker) continue;
    let close = text.indexOf(marker, open + 1);
    while (close > 0) {
      const before = text[close - 1] ?? '';
      const after = text[close + marker.length] ?? '';
      const doubled = marker.length === 1 && (after === marker || before === marker);
      if (!/\s/.test(before) && before !== '\\' && !doubled) break;
      close = text.indexOf(marker, close + 1);
    }
    if (close > open) return { inner: text.slice(open, close), end: close + marker.length };
  }
  return null;
}

function wordBoundary(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? '';
  const after = text[end] ?? '';
  return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
}

function autolinkStart(text: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}/:]/u.test(text[at - 1] ?? '');
}

/** The plain text of inline nodes (for labels and tests). */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text' || n.type === 'code') return n.text;
      if (n.type === 'br') return '\n';
      return plainText(n.children);
    })
    .join('');
}
