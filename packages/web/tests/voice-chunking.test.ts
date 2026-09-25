// What of a reply is read aloud, and in what pieces (DECISIONS §63, src/voice/chunking.ts).
import { describe, expect, it } from 'vitest';
import {
  MAX_SPEECH_CHARS,
  StreamingChunker,
  codeLabelFor,
  languageOf,
  safeCut,
  speakableChunks,
  speakableText,
} from '../src/voice/chunking.js';

describe('speakableText', () => {
  it('announces a code block instead of reciting it, in the reply’s language', () => {
    const reply = 'شغّل هذا:\n\n```bash\npnpm test --filter web\nrm -rf dist\n```\n\nثم أخبرني.';
    const text = speakableText(reply, codeLabelFor(languageOf(reply)));
    expect(text).toContain('كتلة كود.');
    expect(text).not.toContain('pnpm');
    expect(text).not.toContain('```');
    expect(speakableText('Run:\n~~~\nls\n~~~', codeLabelFor('en'))).toBe('Run:\nCode block.');
  });

  it('drops Markdown’s marks and keeps the words', () => {
    const text = speakableText(
      [
        '## The result',
        '- **All** tests _passed_ and `pnpm build` is *green*.',
        '1. See [the report](https://example.com/report) for details.',
        '> quoted',
        '![chart](chart.png)',
        '| name | status |',
        '|---|---|',
        '| web | ok |',
        'Raw link: https://example.com/x',
        '---',
      ].join('\n'),
      'Code block',
    );
    expect(text).toBe(
      [
        'The result',
        'All tests passed and pnpm build is green.',
        'See the report for details.',
        'quoted',
        'name, status',
        'web, ok',
        'Raw link:',
      ].join('\n'),
    );
  });
});

describe('speakableChunks', () => {
  it('keeps every chunk under the limit and never above the contract’s 2 000', () => {
    const sentence = 'This sentence is part of a long reply. ';
    const chunks = speakableChunks(sentence.repeat(60), { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    // Cut at sentence ends: every chunk ends where a sentence does.
    for (const chunk of chunks) expect(chunk.endsWith('.')).toBe(true);
    expect(speakableChunks('x'.repeat(5000), { maxChars: 9999 })[0]!.length).toBe(MAX_SPEECH_CHARS);
  });

  it('cuts one very long sentence at a comma, then at a space', () => {
    const long = `${'word '.repeat(30)}, ${'more '.repeat(30)}`;
    const chunks = speakableChunks(long, { maxChars: 100 });
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('word word');
  });

  it('reads Arabic sentence ends (؟) as ends, and says nothing for an empty reply', () => {
    expect(speakableChunks('هل انتهيت؟ نعم. تمّ كل شيء!', { maxChars: 12 })).toEqual([
      'هل انتهيت؟',
      'نعم.',
      'تمّ كل شيء!',
    ]);
    expect(speakableChunks('```\nonly code\n```', { codeLabel: 'Code block' })).toEqual([
      'Code block.',
    ]);
    expect(speakableChunks('   ')).toEqual([]);
  });
});

describe('StreamingChunker', () => {
  it('hands out only finished sentences, and the rest when the reply ends', () => {
    const chunker = new StreamingChunker({ minChars: 10 });
    expect(chunker.push('The build')).toEqual([]);
    expect(chunker.push('The build passed on all three')).toEqual([]);
    expect(chunker.push('The build passed on all three runners. Now the')).toEqual([
      'The build passed on all three runners.',
    ]);
    // Nothing is said twice.
    expect(chunker.push('The build passed on all three runners. Now the tests')).toEqual([]);
    expect(chunker.finish('The build passed on all three runners. Now the tests.')).toEqual([
      'Now the tests.',
    ]);
  });

  it('waits for a code block to close and announces it once', () => {
    const chunker = new StreamingChunker({ minChars: 5, codeLabel: 'Code block' });
    const start = 'Here is the script I ran.\n```bash\npnpm te';
    expect(chunker.push(start)).toEqual(['Here is the script I ran.']);
    expect(chunker.push(`${start}st\n`)).toEqual([]);
    const closed = `${start}st\n\`\`\`\nIt passed.\n`;
    expect(chunker.push(closed)).toEqual(['Code block. It passed.']);
    expect(chunker.finish(closed)).toEqual([]);
  });

  it('does not cut after a sentence end that is only the end of the text so far', () => {
    // "3." may yet become "3.5": only a following space or line break makes it an end.
    expect(safeCut('Version 3.', 0)).toBe(0);
    expect(safeCut('Version 3.5 is out. More', 0)).toBe('Version 3.5 is out. '.length);
  });
});
