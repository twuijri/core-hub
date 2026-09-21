// Arabic first with full RTL: the stylesheet and every class list use logical properties only.
// A physical `left`/`right` in CSS or a Tailwind class such as `ml-2`, `pr-4`, `left-0`,
// `text-left` fails this test; use `ms-`, `pe-`, `start-`, `text-start` and friends.
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

const CSS_PHYSICAL =
  /(^|[\s;{])(margin|padding|border|inset)-(left|right)\s*:|(^|[\s;{])(left|right)\s*:|text-align\s*:\s*(left|right)\b|border-(top|bottom)-(left|right)-radius/;
const CLASS_PHYSICAL =
  /(^|[\s"'`])-?(m|p|inset|scroll-m|scroll-p|rounded|border|space-x|divide-x)?[lr]-\S+|(^|[\s"'`])(left|right)-\S+|(^|[\s"'`])(text|float|clear)-(left|right)(\b|$)|(^|[\s"'`])rounded-(t|b)?[lr]-\S+/;
const CLASS_ALLOW = /^(l|r)-?$/; // never matches; kept for clarity of intent

describe('logical CSS properties only', () => {
  for (const file of walk(src)) {
    if (!/\.(css|tsx?)$/.test(file)) continue;
    it(path.relative(src, file), () => {
      const text = readFileSync(file, 'utf8');
      const offenders: string[] = [];
      text.split('\n').forEach((line, index) => {
        if (file.endsWith('.css')) {
          if (CSS_PHYSICAL.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
          return;
        }
        for (const match of line.matchAll(/className=\{?["'`]([^"'`]*)["'`]|@apply ([^;]+);/g)) {
          const classes = (match[1] ?? match[2] ?? '').split(/\s+/);
          for (const cls of classes) {
            const token = cls.replace(/^[a-z-]+:/, '');
            if (token && !CLASS_ALLOW.test(token) && CLASS_PHYSICAL.test(` ${token}`))
              offenders.push(`${index + 1}: ${cls}`);
          }
        }
      });
      expect(offenders).toEqual([]);
    });
  }
});
