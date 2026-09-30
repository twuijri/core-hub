/**
 * The preview's reading of Telegram formatting (DECISIONS §137): Telegram's tags and MarkdownV2
 * markers become a tree of its entities; anything Telegram would refuse is said, not drawn.
 */
import { describe, expect, it } from 'vitest';
import {
  formattingOf,
  parseTelegram,
  parseTelegramHtml,
  parseTelegramMarkdownV2,
} from '../src/schedules/workflows/telegram-preview.js';

describe('Telegram formatting in the preview', () => {
  it('reads only the three formattings; anything else is plain', () => {
    expect(formattingOf('html')).toBe('html');
    expect(formattingOf('markdown_v2')).toBe('markdown_v2');
    expect(formattingOf(undefined)).toBe('plain');
    expect(formattingOf('HTML')).toBe('plain');
    expect(parseTelegram('<b>x</b>', 'plain')).toEqual({
      ok: true,
      nodes: [{ kind: 'text', text: '<b>x</b>' }],
    });
  });

  it("reads Telegram's HTML tags and entities", () => {
    expect(
      parseTelegramHtml('<b>a <i>b</i></b> &lt;c&gt; <a href="https://x.test/?a=1&amp;b">d</a>'),
    ).toEqual({
      ok: true,
      nodes: [
        {
          kind: 'bold',
          children: [
            { kind: 'text', text: 'a ' },
            { kind: 'italic', children: [{ kind: 'text', text: 'b' }] },
          ],
        },
        { kind: 'text', text: ' <c> ' },
        { kind: 'link', href: 'https://x.test/?a=1&b', children: [{ kind: 'text', text: 'd' }] },
      ],
    });
    expect(parseTelegramHtml('<pre><code class="language-js">x</code></pre>')).toEqual({
      ok: true,
      nodes: [{ kind: 'pre', children: [{ kind: 'text', text: 'x' }] }],
    });
  });

  it('says what Telegram would refuse in HTML', () => {
    expect(parseTelegramHtml('<script>x</script>')).toMatchObject({ ok: false });
    expect(parseTelegramHtml('<b>x')).toEqual({ ok: false, error: '<b> is not closed' });
    expect(parseTelegramHtml('<b>x</i>')).toMatchObject({ ok: false });
    expect(parseTelegramHtml('a < b')).toMatchObject({ ok: false });
    expect(parseTelegramHtml('<span>x</span>')).toMatchObject({ ok: false });
  });

  it('reads MarkdownV2 and says what it would refuse', () => {
    expect(parseTelegramMarkdownV2('*a* _b_ __c__ ~d~ ||e|| `f` [g](https://x.test) h\\.')).toEqual(
      {
        ok: true,
        nodes: [
          { kind: 'bold', children: [{ kind: 'text', text: 'a' }] },
          { kind: 'text', text: ' ' },
          { kind: 'italic', children: [{ kind: 'text', text: 'b' }] },
          { kind: 'text', text: ' ' },
          { kind: 'underline', children: [{ kind: 'text', text: 'c' }] },
          { kind: 'text', text: ' ' },
          { kind: 'strike', children: [{ kind: 'text', text: 'd' }] },
          { kind: 'text', text: ' ' },
          { kind: 'spoiler', children: [{ kind: 'text', text: 'e' }] },
          { kind: 'text', text: ' ' },
          { kind: 'code', children: [{ kind: 'text', text: 'f' }] },
          { kind: 'text', text: ' ' },
          { kind: 'link', href: 'https://x.test', children: [{ kind: 'text', text: 'g' }] },
          { kind: 'text', text: ' h.' },
        ],
      },
    );
    expect(parseTelegramMarkdownV2('>quoted\nafter')).toMatchObject({
      ok: true,
      nodes: [{ kind: 'quote' }, { kind: 'text', text: 'after' }],
    });
    expect(parseTelegramMarkdownV2('end.')).toMatchObject({ ok: false });
    expect(parseTelegramMarkdownV2('*open')).toMatchObject({ ok: false });
    expect(parseTelegramMarkdownV2('**bold**')).toMatchObject({ ok: true });
  });
});
