// How the track spends its width (src/ui/segmented-fit.ts): the rule, without a DOM.
// Degradation is comfortable → compact → compact + More, the selected option is always
// in the track, and the caller's order is never rearranged.
import { describe, expect, it } from 'vitest';
import { layoutSegments, type LayoutInput } from '../src/ui/segmented-fit.js';

/** Five options: 100px each with a label, 30px as an icon. */
const base: LayoutInput = {
  available: 1000,
  comfortable: [100, 100, 100, 100, 100],
  compact: [30, 30, 30, 30, 30],
  moreWidth: 70,
  actionWidth: 0,
  gap: 2,
  selected: 0,
};

describe('layoutSegments', () => {
  it('stays comfortable while every label fits', () => {
    const out = layoutSegments(base);
    expect(out.density).toBe('comfortable');
    expect(out.visible).toEqual([0, 1, 2, 3, 4]);
    expect(out.overflow).toEqual([]);
  });

  it('gives up labels before it gives up options', () => {
    // 5×100 + gaps = 508 does not fit in 300; 4×30 + 100 (the selected keeps its label)
    // + gaps = 228 does.
    const out = layoutSegments({ ...base, available: 300 });
    expect(out.density).toBe('compact');
    expect(out.visible).toEqual([0, 1, 2, 3, 4]);
    expect(out.overflow).toEqual([]);
  });

  it('moves the rest into More only once compact is not enough either', () => {
    const out = layoutSegments({ ...base, available: 180 });
    expect(out.density).toBe('compact');
    expect(out.overflow.length).toBeGreaterThan(0);
    // Order is kept on both sides, and nothing is lost or duplicated.
    expect([...out.visible].sort((a, b) => a - b)).toEqual(out.visible);
    expect([...out.overflow].sort((a, b) => a - b)).toEqual(out.overflow);
    expect([...out.visible, ...out.overflow].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('hoists the selected option into the track when it would overflow', () => {
    const out = layoutSegments({ ...base, available: 180, selected: 4 });
    expect(out.visible).toContain(4);
    expect(out.overflow).not.toContain(4);
    expect(out.visible).toEqual([...out.visible].sort((a, b) => a - b));
  });

  it('keeps the selected option even at the narrowest width', () => {
    const out = layoutSegments({ ...base, available: 80, selected: 3 });
    expect(out.visible).toEqual([3]);
    expect(out.overflow).toEqual([0, 1, 2, 4]);
  });

  it('counts the trailing action against the width it has', () => {
    // Comfortable needs 508; with 520 available it fits, but not once a 40px action and
    // its gap are taken out.
    expect(layoutSegments({ ...base, available: 520 }).density).toBe('comfortable');
    expect(layoutSegments({ ...base, available: 520, actionWidth: 40 }).density).toBe('compact');
  });

  it('shows everything before the first measurement instead of collapsing', () => {
    expect(layoutSegments({ ...base, available: 0 }).visible).toEqual([0, 1, 2, 3, 4]);
    expect(layoutSegments({ ...base, compact: [] }).density).toBe('comfortable');
  });

  it('has nothing to lay out with no options', () => {
    expect(layoutSegments({ ...base, comfortable: [], compact: [] })).toEqual({
      density: 'comfortable',
      visible: [],
      overflow: [],
    });
  });
});
