/**
 * How the track spends the width it has.
 *
 * Kept apart from the component and free of the DOM so the rule can be tested directly:
 * the widths come from the real elements, the decision is arithmetic.
 *
 * The control gives up its comfort in a fixed order, so the same width always produces the
 * same shape:
 *
 * 1. **comfortable** — every option shows its icon and its label;
 * 2. **compact** — only the selected option keeps its label; the rest are icon-only,
 *    with a hairline between neighbours;
 * 3. **compact + More** — what still does not fit moves into the trailing menu.
 *
 * Two promises hold at every level:
 *
 * - **the selected option is always in the track**, and in compact it is the one that
 *   keeps its label. If it would fall into the overflow it takes the last visible place,
 *   so a person never loses sight of what is active;
 * - **the logical order is kept.** Visible options stay in the caller's order, and the
 *   overflow lists the rest in that same order — which in Arabic means the same order read
 *   right to left, not a reversed one.
 */
export type SegmentedDensity = 'comfortable' | 'compact';

export interface LayoutInput {
  /** Inline size of the track's content box, in pixels. */
  available: number;
  /** Each option's inline size with its label, in the caller's order. */
  comfortable: readonly number[];
  /** Each option's inline size as icon only, in the caller's order. */
  compact: readonly number[];
  /** Inline size of the "More" control, counted only when something overflows. */
  moreWidth: number;
  /** Inline size of the trailing action ("+"), counted whenever there is one. */
  actionWidth: number;
  /** Gap between options. */
  gap: number;
  /** Index of the selected option, or -1. */
  selected: number;
}

export interface Layout {
  density: SegmentedDensity;
  /** Indexes to render in the track, in order. */
  visible: number[];
  /** Indexes to list in the More menu, in order. */
  overflow: number[];
}

const sum = (values: readonly number[], gap: number) =>
  values.reduce((total, v) => total + v, 0) + gap * Math.max(0, values.length - 1);

const allOf = (count: number) => Array.from({ length: count }, (_, i) => i);

/** In compact, the selected option keeps its label and the rest shrink to their icon. */
function compactWidths(input: LayoutInput): number[] {
  return input.compact.map((w, i) => (i === input.selected ? (input.comfortable[i] ?? w) : w));
}

export function layoutSegments(input: LayoutInput): Layout {
  const count = input.comfortable.length;
  if (count === 0) return { density: 'comfortable', visible: [], overflow: [] };

  // Before the first measurement the container reports 0; show everything rather than
  // collapsing the control to a lone More button for a frame.
  const budget = input.available - (input.actionWidth > 0 ? input.actionWidth + input.gap : 0);
  if (!Number.isFinite(input.available) || input.available <= 0 || input.compact.length !== count) {
    return { density: 'comfortable', visible: allOf(count), overflow: [] };
  }

  if (sum(input.comfortable, input.gap) <= budget) {
    return { density: 'comfortable', visible: allOf(count), overflow: [] };
  }

  const widths = compactWidths(input);
  if (sum(widths, input.gap) <= budget) {
    return { density: 'compact', visible: allOf(count), overflow: [] };
  }

  // Still too wide: compact *and* a More menu. Its width joins the budget.
  const withMore = budget - input.moreWidth - input.gap;
  const visible: number[] = [];
  let used = 0;
  for (let i = 0; i < count; i += 1) {
    const next = used + (visible.length === 0 ? 0 : input.gap) + (widths[i] ?? 0);
    if (next > withMore) break;
    visible.push(i);
    used = next;
  }
  // At the narrowest width one option still shows — the selected one, hoisted below.
  if (visible.length === 0) visible.push(0);

  if (input.selected >= 0 && !visible.includes(input.selected)) {
    visible[visible.length - 1] = input.selected;
    visible.sort((a, b) => a - b);
  }

  const shown = new Set(visible);
  const overflow = allOf(count).filter((i) => !shown.has(i));
  return { density: 'compact', visible, overflow };
}
