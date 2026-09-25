/**
 * The hub's own line diff (decision §49, folders without git): the hunks `git diff` would
 * draw for the same two texts, the counts, and the bounds.
 */
import { describe, expect, it } from 'vitest';
import { MAX_EDITS, diffTexts, isBinary, linesOf } from './line-diff.js';

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join('');

describe('diffTexts', () => {
  it('draws one hunk with three lines of context, as git does', () => {
    const before = numbered(10);
    const after = before.replace('5\n', 'five\n');
    expect(diffTexts(before, after, 10_000)).toEqual({
      additions: 1,
      deletions: 1,
      truncated: false,
      text: '@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n',
    });
  });

  it('keeps far-apart changes in separate hunks and joins close ones', () => {
    const before = numbered(30);
    const apart = before.replace('3\n', 'three\n').replace('25\n', 'twenty-five\n');
    expect(diffTexts(before, apart, 10_000).text!.match(/^@@/gm)).toHaveLength(2);
    const close = before.replace('3\n', 'three\n').replace('9\n', 'nine\n');
    expect(diffTexts(before, close, 10_000).text!.match(/^@@/gm)).toHaveLength(1);
  });

  it('draws a new file, a removed file, and a last line without a newline', () => {
    expect(diffTexts(null, 'a\nb\n', 1000).text).toBe('@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(diffTexts('a\n', null, 1000).text).toBe('@@ -1 +0,0 @@\n-a\n');
    expect(diffTexts('a\nb', 'a\nb\n', 1000)).toEqual({
      additions: 1,
      deletions: 1,
      truncated: false,
      text: '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n',
    });
  });

  it('adds a long new file without searching for edits', () => {
    const drawn = diffTexts(null, numbered(MAX_EDITS * 3), 100);
    expect(drawn.additions).toBe(MAX_EDITS * 3);
    expect(drawn.truncated).toBe(true);
    expect(drawn.text!.length).toBeLessThanOrEqual(100);
  });

  it('counts without drawing when the sides are too far apart', () => {
    const before = Array.from({ length: MAX_EDITS + 10 }, (_, i) => `a${i}\n`).join('');
    const after = Array.from({ length: MAX_EDITS + 10 }, (_, i) => `b${i}\n`).join('');
    expect(diffTexts(before, after, 1000)).toEqual({
      additions: MAX_EDITS + 10,
      deletions: MAX_EDITS + 10,
      text: null,
      truncated: false,
    });
  });

  it('cuts the text at a whole line under the cap', () => {
    const drawn = diffTexts(numbered(5), numbered(5).replace(/\d/g, 'x'), 20);
    expect(drawn.truncated).toBe(true);
    expect(drawn.text!.endsWith('\n')).toBe(true);
    expect(new TextEncoder().encode(drawn.text!).length).toBeLessThanOrEqual(20);
  });
});

describe('helpers', () => {
  it('splits lines keeping their ends, and tells binary by a NUL byte', () => {
    expect(linesOf('a\r\nb')).toEqual(['a\r\n', 'b']);
    expect(linesOf('')).toEqual([]);
    expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(isBinary(new TextEncoder().encode('نص عربي'))).toBe(false);
  });
});
