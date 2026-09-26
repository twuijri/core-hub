// The web draws Lucide (owner, 2026-09-27: one family across web, desktop, iOS and Android).
// The outlines are generated from the pinned lucide-static package, never hand-drawn, and every
// destination of the navigation manifest has the one picture the phones use for it
// (docs/design/family.md, "Icons").
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as icons from '../src/ui/icons.js';
import { lucideNodes, lucideVersion } from '../src/ui/lucide.generated.js';

afterEach(cleanup);

const require = createRequire(import.meta.url);
const navigation = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/clients/navigation.json'), 'utf8'),
) as { destinations: Array<{ id: string }> };
const upstream = require('lucide-static/icon-nodes.json') as Record<
  string,
  Array<[string, Record<string, string>]>
>;
const upstreamVersion = (require('lucide-static/package.json') as { version: string }).version;

describe('the Lucide icons', () => {
  it('are the pinned lucide-static outlines, unchanged', () => {
    expect(lucideVersion).toBe(upstreamVersion);
    for (const [name, nodes] of Object.entries(lucideNodes)) {
      expect(nodes, name).toEqual(upstream[name]);
    }
  });

  it('are the only icons: icons.tsx draws no path of its own', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/ui/icons.tsx'), 'utf8');
    expect(source).not.toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
  });

  it('draw with Lucide’s stroke, decorative unless labelled', () => {
    const { container, rerender } = render(<icons.IconSearch size={20} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke-width')).toBe('2');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path, circle').length).toBe(lucideNodes.search.length);
    rerender(<icons.IconSearch label="بحث" />);
    expect(container.querySelector('svg')!.getAttribute('role')).toBe('img');
    expect(container.querySelector('title')!.textContent).toBe('بحث');
  });

  it('give every destination of the manifest its picture', () => {
    const ids = navigation.destinations.map((d) => d.id);
    const missing = ids.filter((id) => !icons.destinationIcons[id]);
    expect(missing).toEqual([]);
  });
});
