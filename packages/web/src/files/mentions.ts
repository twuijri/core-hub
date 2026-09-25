/**
 * A rehype plugin: in a reply, a word that names one of the conversation's files becomes a
 * link that opens it beside the chat (decision §48). Only exact names count — a listed
 * path, or the bare name of a file that is the only one with that name — and never inside
 * code blocks or existing links; inline code is left to the `code` renderer, which asks
 * `fileForMention` itself.
 */
interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

export interface Mention {
  /** What is written in the reply. */
  word: string;
  key: string;
}

const SKIP = new Set(['code', 'pre', 'a', 'button']);

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rehypeFileMentions(options: { mentions: readonly Mention[] }) {
  const mentions = [...options.mentions].sort((a, b) => b.word.length - a.word.length);
  if (mentions.length === 0) return () => undefined;
  const keyOf = new Map(mentions.map((m) => [m.word, m.key]));
  // A name counts only as a whole word: not inside `myreport.html` or `report.html5`.
  const pattern = new RegExp(
    `(^|[\\s(«"'\`/])(${mentions.map((m) => escape(m.word)).join('|')})(?=$|[\\s)»"'\`,;:!?،؛]|\\.(?:\\s|$))`,
    'gu',
  );

  const split = (text: string): HastNode[] | null => {
    pattern.lastIndex = 0;
    const out: HastNode[] = [];
    let last = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index + (match[1]?.length ?? 0);
      const word = match[2] ?? '';
      if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
      out.push({
        type: 'element',
        tagName: 'a',
        properties: { dataFileKey: keyOf.get(word) },
        children: [{ type: 'text', value: word }],
      });
      last = start + word.length;
    }
    if (out.length === 0) return null;
    if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
    return out;
  };

  const walk = (node: HastNode): void => {
    if (!('children' in node) || !node.children) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text') {
        next.push(...(split((child as HastText).value) ?? [child]));
        continue;
      }
      if (child.type === 'element' && SKIP.has((child as HastElement).tagName)) {
        next.push(child);
        continue;
      }
      walk(child);
      next.push(child);
    }
    node.children = next;
  };

  return (tree: HastNode) => walk(tree);
}
