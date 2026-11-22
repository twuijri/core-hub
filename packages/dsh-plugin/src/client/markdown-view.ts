/**
 * Renders the Markdown tree (`../markdown.ts`) as React elements. Every block carries
 * `dir="auto"`, so each paragraph, list item, heading and table cell takes the direction of its
 * own first strong letter: Arabic reads right to left, English left to right, in the same answer.
 * Links open in a new tab; nothing is set as HTML.
 */
import { createElement as h, Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../markdown.js';

const codeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '0.9em',
  background: 'rgba(127,127,127,0.14)',
  borderRadius: 4,
  padding: '0.1em 0.35em',
  unicodeBidi: 'isolate' as const,
};

const preStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  background: 'rgba(127,127,127,0.12)',
  borderRadius: 8,
  padding: '10px 12px',
  margin: '8px 0',
  overflowX: 'auto' as const,
  whiteSpace: 'pre' as const,
  direction: 'ltr' as const,
  textAlign: 'left' as const,
};

function inline(nodes: Inline[], key = 'i'): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}.${index}`;
    switch (node.type) {
      case 'text':
        return h(Fragment, { key: k }, node.text);
      case 'code':
        return h('code', { key: k, style: codeStyle, dir: 'ltr' }, node.text);
      case 'strong':
        return h('strong', { key: k }, inline(node.children, k));
      case 'em':
        return h('em', { key: k }, inline(node.children, k));
      case 'del':
        return h('del', { key: k }, inline(node.children, k));
      case 'link':
        return h(
          'a',
          {
            key: k,
            href: node.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 },
          },
          inline(node.children, k),
        );
      case 'br':
        return h('br', { key: k });
    }
  });
}

function block(b: Block, key: string): ReactNode {
  switch (b.type) {
    case 'heading':
      return h(
        `h${Math.min(6, Math.max(3, b.level + 2))}`,
        { key, dir: 'auto', style: { margin: '12px 0 6px', fontSize: b.level <= 2 ? 16 : 15 } },
        inline(b.children, key),
      );
    case 'paragraph':
      return h('p', { key, dir: 'auto', style: { margin: '6px 0' } }, inline(b.children, key));
    case 'code':
      return h('pre', { key, dir: 'ltr', style: preStyle }, h('code', null, b.text));
    case 'rule':
      return h('hr', {
        key,
        style: { border: 0, borderTop: '1px solid rgba(127,127,127,0.3)', margin: '10px 0' },
      });
    case 'quote':
      return h(
        'blockquote',
        {
          key,
          dir: 'auto',
          style: {
            margin: '6px 0',
            paddingInlineStart: 12,
            borderInlineStart: '3px solid rgba(127,127,127,0.35)',
            opacity: 0.9,
          },
        },
        b.children.map((c, i) => block(c, `${key}.${i}`)),
      );
    case 'list':
      return h(
        b.ordered ? 'ol' : 'ul',
        {
          key,
          dir: 'auto',
          start: b.ordered && b.start !== 1 ? b.start : undefined,
          style: { margin: '6px 0', paddingInlineStart: 22 },
        },
        b.items.map((item, i) =>
          h(
            'li',
            { key: `${key}.${i}`, dir: 'auto', style: { margin: '3px 0' } },
            item.length === 1 && item[0]?.type === 'paragraph'
              ? inline(item[0].children, `${key}.${i}`)
              : item.map((c, j) => block(c, `${key}.${i}.${j}`)),
          ),
        ),
      );
    case 'table':
      return h(
        'div',
        { key, style: { overflowX: 'auto', margin: '8px 0' } },
        h(
          'table',
          { dir: 'auto', style: { borderCollapse: 'collapse', fontSize: 13 } },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              b.head.map((cell, i) =>
                h(
                  'th',
                  { key: i, dir: 'auto', style: cellStyle(b.align[i] ?? null, true) },
                  inline(cell, `${key}.h${i}`),
                ),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            b.rows.map((row, r) =>
              h(
                'tr',
                { key: r },
                row.map((cell, i) =>
                  h(
                    'td',
                    { key: i, dir: 'auto', style: cellStyle(b.align[i] ?? null, false) },
                    inline(cell, `${key}.${r}.${i}`),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
  }
}

function cellStyle(align: 'left' | 'center' | 'right' | null, head: boolean) {
  return {
    border: '1px solid rgba(127,127,127,0.3)',
    padding: '4px 8px',
    textAlign: align === 'center' ? ('center' as const) : undefined,
    fontWeight: head ? 600 : undefined,
  };
}

/** A Markdown answer as elements. */
export function MarkdownBlocks({ source }: { source: string }): ReactNode {
  const blocks = parseMarkdown(source);
  return h(
    'div',
    { style: { lineHeight: 1.6, overflowWrap: 'anywhere' } },
    blocks.map((b, i) => block(b, `b${i}`)),
  );
}
