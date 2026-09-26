// A colour utility must name a colour the theme defines (`@theme` in styles/app.css).
// Tailwind emits nothing for one it does not know, so a typo is silent: `border-border`
// drew no border on the channel settings panel (owner, 2026-09-26). The codebase's border
// colours are `line` and `line-strong`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const theme = new Set(
  [
    ...readFileSync(path.join(src, 'styles/app.css'), 'utf8').matchAll(/--color-([a-z0-9-]+):/g),
  ].map((match) => match[1]),
);
/** Tailwind's own colour words. */
const BUILTIN = new Set(['transparent', 'current', 'inherit', 'white', 'black']);
/** What follows `border-` that is not a colour: sides, styles and table modes. */
const NOT_COLOUR =
  /^(x|y|s|e|t|b|l|r|bs|be|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing)$/;

/** `border-<colour>` and `border-<side>-<colour>` in class lists, with the colour named. */
function borderColours(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)) {
    for (const cls of (match[1] ?? '').split(/\s+/)) {
      const token = cls.replace(/^([a-z-]+:)+/, '').replace(/\/\d+$/, '');
      const found = /^border-(?:(?:x|y|s|e|t|b|l|r)-)?([a-z][a-z0-9-]*)$/.exec(token);
      if (found && !NOT_COLOUR.test(found[1]!)) out.push(found[1]!);
    }
  }
  return out;
}

describe('border colour utilities name a theme colour', () => {
  it('reads the theme', () => {
    expect(theme.has('line')).toBe(true);
    expect(borderColours('<div className="rounded-md border border-border p-4">')).toEqual([
      'border',
    ]);
  });

  for (const file of walk(src)) {
    if (!file.endsWith('.tsx')) continue;
    it(path.relative(src, file), () => {
      const unknown: string[] = [];
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const colour of borderColours(line))
            if (!theme.has(colour) && !BUILTIN.has(colour))
              unknown.push(`${index + 1}: border-${colour}`);
        });
      expect(unknown).toEqual([]);
    });
  }
});
