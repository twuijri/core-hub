import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ANSI, Printer, detectColor, displayWidth, stripAnsi } from '../src/output.js';

function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, read: () => text };
}

describe('displayWidth', () => {
  it('counts Arabic letters once and tashkeel not at all', () => {
    expect(displayWidth('عربي')).toBe(4);
    expect(displayWidth('شغّل')).toBe(3);
    expect(displayWidth(ANSI.bold('ab'))).toBe(2);
    expect(displayWidth('日本')).toBe(4);
  });

  it('strips colour codes', () => {
    expect(stripAnsi(ANSI.red('x'))).toBe('x');
  });
});

describe('Printer', () => {
  it('aligns table columns by display width and puts JSON on stdout only', () => {
    const out = capture();
    const err = capture();
    const printer = new Printer(out.stream, err.stream, { color: false });
    printer.table(
      [
        { key: 'id', label: 'ID' },
        { key: 'n', label: 'N', align: 'end' },
      ],
      [
        { id: 'a', n: '1' },
        { id: 'عربي', n: '10' },
      ],
    );
    expect(out.read()).toBe('ID     N\na      1\nعربي  10\n');
    printer.json({ a: 1 });
    printer.notice('note');
    printer.error('bad');
    expect(out.read()).toContain('{\n  "a": 1\n}\n');
    expect(err.read()).toBe('note\nbad\n');
  });
});

describe('detectColor', () => {
  it('honours the flag, NO_COLOR, FORCE_COLOR and the TTY', () => {
    expect(detectColor({}, { isTTY: true }, true)).toBe(false);
    expect(detectColor({ NO_COLOR: '1' }, { isTTY: true }, false)).toBe(false);
    expect(detectColor({ FORCE_COLOR: '1' }, { isTTY: false }, false)).toBe(true);
    expect(detectColor({}, { isTTY: true }, false)).toBe(true);
    expect(detectColor({}, {}, false)).toBe(false);
  });
});
