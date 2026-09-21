import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, parseHex } from '../src/contrast.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(path.join(root, 'tokens.json'), 'utf8')) as {
  themes: Record<string, Record<string, string>>;
  glass: { default: number; levels: Record<string, { alpha: number }> };
  contrast: { pairs: Array<{ fg: string; bg: string; min: number }> };
};

describe('design tokens', () => {
  it('has the same colour names in every theme', () => {
    const names = Object.keys(tokens.themes.light!).sort();
    for (const [theme, colours] of Object.entries(tokens.themes))
      expect(Object.keys(colours).sort(), theme).toEqual(names);
  });

  it('declares glass levels 0..3 with 0 solid and a default level', () => {
    expect(Object.keys(tokens.glass.levels)).toEqual(['0', '1', '2', '3']);
    expect(tokens.glass.levels['0']!.alpha).toBe(1);
    expect(String(tokens.glass.default) in tokens.glass.levels).toBe(true);
  });

  for (const [theme, colours] of Object.entries(tokens.themes)) {
    describe(`${theme} theme meets WCAG AA on every declared pair`, () => {
      const colour = (name: string) => {
        const hex = colours[name];
        if (!hex) throw new Error(`${theme}: unknown colour "${name}"`);
        return parseHex(hex);
      };
      for (const pair of tokens.contrast.pairs) {
        if (pair.bg === 'glass') {
          for (const [level, spec] of Object.entries(tokens.glass.levels)) {
            it(`${pair.fg} on glass level ${level} ≥ ${pair.min}`, () => {
              const bg = composite(colour('glassTint'), spec.alpha, colour('bg'));
              const ratio = contrastRatio(colour(pair.fg), bg);
              expect(
                ratio,
                `${pair.fg} on glass ${level} = ${ratio.toFixed(2)}`,
              ).toBeGreaterThanOrEqual(pair.min);
            });
          }
          continue;
        }
        it(`${pair.fg} on ${pair.bg} ≥ ${pair.min}`, () => {
          const ratio = contrastRatio(colour(pair.fg), colour(pair.bg));
          expect(ratio, `${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
            pair.min,
          );
        });
      }
    });
  }

  it('checks every colour that is used as text at least once', () => {
    const textLike = Object.keys(tokens.themes.light!).filter(
      (name) =>
        name === 'text' ||
        name.endsWith('-text') ||
        name.startsWith('text-') ||
        (name.startsWith('code-') && name !== 'code-bg') ||
        name === 'link' ||
        name === 'accent',
    );
    const checked = new Set(tokens.contrast.pairs.map((pair) => pair.fg));
    for (const name of textLike)
      expect(checked.has(name), `${name} is never contrast-checked`).toBe(true);
  });
});
