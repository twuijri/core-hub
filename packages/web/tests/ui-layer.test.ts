/**
 * The composition rule (owner decision, 2026-09-22): a headless primitive is wrapped once
 * in `src/ui/`, and screens import that wrapper. A screen that reaches for `radix-ui`
 * directly would put styling in two places, which is exactly what the rule exists to stop —
 * so this test fails instead of a reviewer having to notice.
 */
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

/** Where a primitive may be imported: our own wrapper layer, and nowhere else. */
const ALLOWED = new Set(['ui']);

describe('the UI layer', () => {
  it('is the only place that imports radix-ui', () => {
    const offenders = walk(src)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => /from '(radix-ui|@radix-ui\/[^']+)'/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(src, file))
      .filter((rel) => !ALLOWED.has(rel.split(path.sep)[0] ?? ''));
    expect(offenders).toEqual([]);
  });

  it('exports a wrapper for every primitive the client uses', () => {
    for (const name of [
      'Menu.tsx',
      'Select.tsx',
      'Popover.tsx',
      'Tooltip.tsx',
      'Checkbox.tsx',
      'ConfirmDialog.tsx',
      'Direction.tsx',
    ]) {
      const text = readFileSync(path.join(src, 'ui', name), 'utf8');
      expect(text, name).toMatch(/from 'radix-ui'/);
    }
  });

  it('has no native popup or OS-painted control left in a screen', () => {
    // `pnpm lint` fails on these too (eslint.config.js §UI policy). This says the same
    // thing from the other side, so deleting the rule cannot quietly pass.
    const offenders: string[] = [];
    for (const file of walk(src).filter((f) => /\.tsx?$/.test(f))) {
      const rel = path.relative(src, file);
      if (ALLOWED.has(rel.split(path.sep)[0] ?? '')) continue;
      const text = readFileSync(file, 'utf8');
      for (const [what, pattern] of [
        ['a native <select>', /<select[\s>]/],
        ['a native <dialog>', /<dialog[\s>]/],
        ['a native checkbox or radio', /type="(checkbox|radio)"/],
        ['window.confirm/alert/prompt', /\b(window\.)?(confirm|alert|prompt)\(/],
        // `title` on a host element only: <AppShell title={…}> is a prop, not a tooltip.
        ['a native title tooltip', /<[a-z][a-zA-Z0-9-]*\s[^>]*\stitle=/],
      ] as const) {
        if (pattern.test(text)) offenders.push(`${rel}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the policy is in the lint config, so CI fails on it and not only this test', () => {
    const config = readFileSync(path.resolve(src, '../../../eslint.config.js'), 'utf8');
    for (const fragment of [
      "JSXOpeningElement[name.name='select']",
      "JSXOpeningElement[name.name='dialog']",
      "JSXAttribute[name.name='title']",
      'no-restricted-globals',
      'radix-ui',
    ]) {
      expect(config, fragment).toContain(fragment);
    }
  });
});
