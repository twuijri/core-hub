/**
 * Telegram formatting (DECISIONS §137): only plain, html and markdown_v2; plain sends no
 * `parse_mode`; a long formatted message is split on what Telegram counts, never inside a tag,
 * an entity or an escape, with the spans open at a cut closed and opened again — every part is
 * judged by the fake Telegram's own parser, which answers like Telegram.
 */
import { describe, expect, it } from 'vitest';
import {
  FORMATTED_MAX_CHARS,
  formattingOf,
  formattingRefusal,
  parseModeOf,
  splitFormatted,
} from './telegram-format.js';
import { parseTelegramHtml, parseTelegramMarkdownV2 } from './testing/fake-telegram.js';

function parts(text: string, formatting: 'html' | 'markdown_v2', max?: number): string[] {
  const split = splitFormatted(text, formatting, max);
  if ('problem' in split) throw new Error(split.problem);
  return split.parts;
}

const parse = (formatting: 'html' | 'markdown_v2') =>
  formatting === 'html' ? parseTelegramHtml : parseTelegramMarkdownV2;

/** Every part parses as Telegram parses it, and counts within Telegram's 4096. */
function everyPartValid(list: string[], formatting: 'html' | 'markdown_v2') {
  return list.map((part) => {
    const parsed = parse(formatting)(part);
    expect(parsed.text.length).toBeLessThanOrEqual(4096);
    expect(parsed.text.trim().length).toBeGreaterThan(0);
    return parsed;
  });
}

describe('which formatting, and what reaches Telegram', () => {
  it('accepts plain, html and markdown_v2 only; absent is plain', () => {
    expect(formattingOf(undefined)).toBe('plain');
    expect(formattingOf(null)).toBe('plain');
    expect(formattingOf('html')).toBe('html');
    expect(formattingOf('markdown_v2')).toBe('markdown_v2');
    for (const other of ['HTML', 'Markdown', 'markdown', 'MarkdownV2', '', 'plain ', 1]) {
      expect(formattingOf(other)).toBeNull();
    }
    expect(parseModeOf('plain')).toBeNull();
    expect(parseModeOf('html')).toBe('HTML');
    expect(parseModeOf('markdown_v2')).toBe('MarkdownV2');
  });

  it('names the mode when Telegram cannot parse the markup, and leaves other refusals as they are', () => {
    expect(
      formattingRefusal(
        'html',
        'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 120',
      ),
    ).toBe(
      'Telegram HTML formatting failed: can\'t parse entities: Unsupported start tag "x" at byte offset 120',
    );
    expect(formattingRefusal('markdown_v2', "Bad Request: can't parse entities: x")).toBe(
      "Telegram MarkdownV2 formatting failed: can't parse entities: x",
    );
    expect(formattingRefusal('html', 'Bad Request: chat not found')).toBe(
      'Bad Request: chat not found',
    );
  });
});

describe('splitting HTML', () => {
  it('sends a text that fits whole and as it is, even with markup Telegram will judge', () => {
    expect(parts('<b>اختبار</b>', 'html')).toEqual(['<b>اختبار</b>']);
    expect(parts('<b>unclosed', 'html')).toEqual(['<b>unclosed']);
  });

  it('counts an entity as one character: 4000 of them are one message', () => {
    const text = '&lt;'.repeat(FORMATTED_MAX_CHARS);
    expect(parts(text, 'html')).toEqual([text]);
    const longer = parts('&lt;'.repeat(FORMATTED_MAX_CHARS + 10), 'html');
    expect(longer).toHaveLength(2);
    for (const part of longer) expect(part).toMatch(/^(&lt;)+$/);
    everyPartValid(longer, 'html');
  });

  it('closes a bold span at the end of a part and opens it again in the next', () => {
    const words = 'كلمة عريضة طويلة '.repeat(400).trim(); // ~6800 characters
    const text = `مقدمة <b>${words}</b> ثم <a href="https://example.com/?a=1&amp;b=2">الرابط</a>.`;
    const list = parts(text, 'html');
    expect(list.length).toBe(2);
    expect(list[0]!.endsWith('</b>')).toBe(true);
    expect(list[1]!.startsWith('<b>')).toBe(true);
    const parsed = everyPartValid(list, 'html');
    // The whole second part's bold words are bold in both parts.
    expect(parsed[0]!.entities).toContainEqual(
      expect.objectContaining({ type: 'bold', offset: 'مقدمة '.length }),
    );
    expect(parsed[1]!.entities[0]).toMatchObject({ type: 'bold', offset: 0 });
    expect(parsed[1]!.entities).toContainEqual(
      expect.objectContaining({ type: 'text_link', url: 'https://example.com/?a=1&b=2' }),
    );
    // Nothing is lost but the space at the cut.
    const plain = parseTelegramHtml(text).text;
    expect(parsed.map((each) => each.text).join(' ')).toBe(plain);
  });

  it('never cuts inside a tag or an entity when there is no space, and reopens a link', () => {
    const inner = 'x&amp;y'.repeat(1500); // 4500 counted, no space anywhere
    const text = `<a href="https://example.com/"><i>${inner}</i></a>`;
    const list = parts(text, 'html');
    expect(list).toHaveLength(2);
    expect(list[1]!.startsWith('<a href="https://example.com/"><i>')).toBe(true);
    for (const part of list) expect(part).not.toMatch(/&(?!amp;)/);
    const parsed = everyPartValid(list, 'html');
    expect(parsed.every((each) => each.entities.some((e) => e.type === 'text_link'))).toBe(true);
  });

  it('keeps a code block with its language across parts', () => {
    const code = Array.from({ length: 300 }, (_, i) => `print("line ${i}") # &lt;tag&gt;`).join(
      '\n',
    );
    const list = parts(`<pre><code class="language-python">${code}</code></pre>`, 'html');
    expect(list.length).toBeGreaterThan(1);
    for (const part of list) {
      expect(part.startsWith('<pre><code class="language-python">')).toBe(true);
      expect(part.endsWith('</code></pre>')).toBe(true);
    }
    const parsed = everyPartValid(list, 'html');
    for (const each of parsed) {
      expect(each.entities).toContainEqual(
        expect.objectContaining({ type: 'pre', language: 'python' }),
      );
    }
  });

  it('refuses, before anything is sent, a long text whose HTML cannot be walked', () => {
    const long = 'word '.repeat(1000);
    expect(splitFormatted(`<b>${long}`, 'html')).toEqual({
      problem: expect.stringContaining('<b> is not closed'),
    });
    expect(splitFormatted(`<blink>${long}</blink>`, 'html')).toEqual({
      problem: expect.stringContaining('<blink>'),
    });
  });
});

describe('splitting MarkdownV2', () => {
  it('closes and reopens a bold span, and never cuts an escape apart', () => {
    const sentence = 'جملة عريضة فيها نقطة\\. ورقم 1\\-2 ';
    const text = `*${sentence.repeat(200).trim()}* والنهاية\\!`;
    const list = parts(text, 'markdown_v2');
    expect(list.length).toBeGreaterThan(1);
    expect(list[0]!.endsWith('*')).toBe(true);
    expect(list[1]!.startsWith('*')).toBe(true);
    const parsed = everyPartValid(list, 'markdown_v2');
    expect(parsed[1]!.entities[0]).toMatchObject({ type: 'bold', offset: 0 });
    for (const part of list) expect(part).not.toMatch(/(^|[^\\])\\$/);
  });

  it('cuts a text without spaces between escapes, never between "\\" and its character', () => {
    const text = '\\.'.repeat(FORMATTED_MAX_CHARS + 500);
    const list = parts(text, 'markdown_v2');
    expect(list).toHaveLength(2);
    for (const part of list) expect(part).toMatch(/^(\\\.)+$/);
    everyPartValid(list, 'markdown_v2');
  });

  it('keeps an italic next to an underline apart when both are closed at a cut', () => {
    const text = `__تحته _مائل ${'كلمة '.repeat(1000).trim()}_ نهاية__`;
    const list = parts(text, 'markdown_v2');
    expect(list.length).toBe(2);
    expect(list[0]!.endsWith('_**__')).toBe(true);
    const parsed = everyPartValid(list, 'markdown_v2');
    expect(parsed[1]!.entities.map((e) => e.type)).toEqual(
      expect.arrayContaining(['underline', 'italic']),
    );
  });

  it('reopens a link, a code block and a quote line', () => {
    const link = parts(
      `[${'نص الرابط '.repeat(500).trim()}](https://example.com/a\\)b)`,
      'markdown_v2',
    );
    expect(link).toHaveLength(2);
    expect(link[0]!.endsWith('](https://example.com/a\\)b)')).toBe(true);
    expect(link[1]!.startsWith('[')).toBe(true);
    for (const each of everyPartValid(link, 'markdown_v2')) {
      expect(each.entities).toContainEqual(
        expect.objectContaining({ type: 'text_link', url: 'https://example.com/a)b' }),
      );
    }

    const pre = parts(`\`\`\`js\n${'const a = 1;\n'.repeat(400)}\`\`\``, 'markdown_v2');
    expect(pre.length).toBeGreaterThan(1);
    for (const part of pre) {
      expect(part.startsWith('```js\n')).toBe(true);
      expect(part.endsWith('```')).toBe(true);
    }
    everyPartValid(pre, 'markdown_v2');

    const quote = parts(`>${'سطر مقتبس طويل '.repeat(400).trim()}`, 'markdown_v2');
    expect(quote).toHaveLength(2);
    expect(quote[1]!.startsWith('>')).toBe(true);
    for (const each of everyPartValid(quote, 'markdown_v2')) {
      expect(each.entities[0]).toMatchObject({ type: 'blockquote', offset: 0 });
    }
  });

  it('ends an expandable quote with "||" at a cut and starts the next part with "**>"', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `>سطر رقم ${i} من الاقتباس`).join('\n');
    const text = `**${lines}||`;
    const list = parts(text, 'markdown_v2');
    expect(list.length).toBeGreaterThan(1);
    for (const part of list) {
      expect(part.startsWith('**>')).toBe(true);
      expect(part.endsWith('||')).toBe(true);
    }
    for (const each of everyPartValid(list, 'markdown_v2')) {
      expect(each.entities[0]).toMatchObject({ type: 'expandable_blockquote', offset: 0 });
    }
  });

  it('refuses a long text with an unescaped reserved character before sending anything', () => {
    expect(splitFormatted(`${'كلمة '.repeat(1000)}نهاية.`, 'markdown_v2')).toEqual({
      problem: expect.stringContaining('"." at character'),
    });
  });
});
