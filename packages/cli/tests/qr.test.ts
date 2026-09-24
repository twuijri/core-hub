import { describe, expect, it } from 'vitest';
import { qrModules, renderModules, renderQr } from '../src/qr.js';

describe('qrModules', () => {
  it('produces a square matrix with the three finder patterns', () => {
    const m = qrModules('{"type":"corehub.pairing","code":"7KQ2-M9XW"}');
    const size = m.length;
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 21) % 4).toBe(0);
    for (const row of m) expect(row).toHaveLength(size);
    const finder = (r: number, c: number) => {
      for (let i = 0; i < 7; i += 1) {
        expect(m[r]?.[c + i]).toBe(true);
        expect(m[r + 6]?.[c + i]).toBe(true);
        expect(m[r + i]?.[c]).toBe(true);
        expect(m[r + i]?.[c + 6]).toBe(true);
      }
      expect(m[r + 1]?.[c + 1]).toBe(false);
      expect(m[r + 3]?.[c + 3]).toBe(true);
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);
  });

  it('encodes Arabic text without throwing', () => {
    expect(qrModules('كور هب').length).toBeGreaterThan(0);
  });
});

describe('renderModules', () => {
  it('draws two module rows per line inside a quiet zone', () => {
    const modules = [
      [true, false],
      [false, true],
    ];
    const lines = renderModules(modules, { quiet: 1 }).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => [...line].length === 4)).toBe(true);
    expect(lines[0]).toBe('█▀██');
    expect(lines[1]).toBe('██▄█');
    const inverted = renderModules(modules, { quiet: 1, invert: true }).split('\n');
    expect(inverted[0]).toBe(' ▄  ');
    expect(inverted[1]).toBe('  ▀ ');
  });

  it('renders a full code with only the four block characters', () => {
    const text = renderQr('hello');
    expect(text).toMatch(/^[ █▀▄\n]+$/);
  });
});
