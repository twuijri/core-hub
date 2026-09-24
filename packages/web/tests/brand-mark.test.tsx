// Majlis's mark (owner, 2026-09-24): the rounded "C" holding a square, in the theme's accent.
// The favicon draws the same path outside React, so this also keeps the two from drifting.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MAJLIS_MARK_PATH, MajlisMark } from '../src/ui/brand/MajlisMark.js';

afterEach(cleanup);

describe('the Majlis mark', () => {
  it('is one path in the current colour, with the hole cut by even-odd', () => {
    const { getByTestId } = render(<MajlisMark size={40} />);
    const svg = getByTestId('majlis-mark');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('fill-rule')).toBe('evenodd');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe('40');
    // outer square, the hole, the square inside it
    expect(svg.querySelector('path')?.getAttribute('d')?.match(/Z/g)).toHaveLength(3);
  });

  it('is the favicon too, in white on the accent tile', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain(MAJLIS_MARK_PATH);
    expect(html).toContain("fill='%230b6b5d'");
    expect(html).toContain("fill='%23fff'");
  });
});
