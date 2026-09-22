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

/** Where a primitive may be imported: our own wrapper layer, and the direction provider. */
const ALLOWED = new Set(['ui', 'i18n']);

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
    for (const name of ['Menu.tsx', 'Select.tsx', 'Popover.tsx']) {
      const text = readFileSync(path.join(src, 'ui', name), 'utf8');
      expect(text, name).toMatch(/from 'radix-ui'/);
    }
  });
});
