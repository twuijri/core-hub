import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, plainText } from '../src/markdown.js';

describe('markdown', () => {
  it('reads bold, italic, code, strike-through and links', () => {
    expect(parseInline('**مرحبا** _a_ *b* `x` ~~y~~ [z](https://e.x)')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'مرحبا' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'a' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'x' },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: 'y' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://e.x', children: [{ type: 'text', text: 'z' }] },
    ]);
  });

  it('keeps unsafe links as text and raw HTML as text', () => {
    expect(parseInline('[x](javascript:void)')).toEqual([{ type: 'text', text: 'x' }]);
    expect(plainText(parseInline('<b>hi</b>'))).toBe('<b>hi</b>');
  });

  it('leaves snake_case and lone markers alone', () => {
    expect(plainText(parseInline('a_b_c and 2 * 3 * 4'))).toBe('a_b_c and 2 * 3 * 4');
  });

  it('turns bare addresses into links without the trailing punctuation', () => {
    const nodes = parseInline('see https://hub.example/x.');
    expect(nodes[1]).toEqual({
      type: 'link',
      href: 'https://hub.example/x',
      children: [{ type: 'text', text: 'https://hub.example/x' }],
    });
  });

  it('reads headings, lists, quotes, code, rules and tables', () => {
    const blocks = parseMarkdown(
      [
        '## عنوان',
        '',
        'سطر أول',
        'سطر ثاني',
        '',
        '- one',
        '- two',
        '  - nested',
        '',
        '3. c',
        '4. d',
        '',
        '> quoted',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '---',
        '| a | b |',
        '|:--|--:|',
        '| 1 | 2 |',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'quote',
      'code',
      'rule',
      'table',
    ]);
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'سطر أول' },
        { type: 'br' },
        { type: 'text', text: 'سطر ثاني' },
      ],
    });
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[1]?.map((b) => b.type)).toEqual(['paragraph', 'list']);
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(blocks[5]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1;' });
    expect(blocks[7]).toMatchObject({ type: 'table', align: ['left', 'right'] });
  });

  it('closes an unterminated fence at the end', () => {
    expect(parseMarkdown('```\nopen')).toEqual([{ type: 'code', lang: '', text: 'open' }]);
  });
});
