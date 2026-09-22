/**
 * What a searchable list shows for a given query.
 *
 * Kept apart from the component and free of the DOM so the rule can be tested directly:
 * the widths and the scrolling are the component's business, but *which rows, in what
 * order, with which characters highlighted* is arithmetic over strings.
 *
 * The rules, in the order they apply:
 *
 * 1. a row matches when the query appears anywhere in its display name **or** in its id,
 *    case-insensitively — so `opus` finds `anthropic/claude-opus-4-6-thinking`;
 * 2. the models chosen most recently in this workspace come first, under **Recent**, as
 *    long as they match too;
 * 3. the rest keep the caller's order, grouped by provider — and the group headers are
 *    only drawn when more than one provider is in scope, because a single header over
 *    every row is noise.
 */
export interface ComboboxOption {
  value: string;
  /** The display name: the first line, and the first thing searched. */
  label: string;
  /** The model id: the dimmed second line, searched as well. */
  detail?: string | undefined;
  /** The provider, when the list spans more than one. */
  group?: string | undefined;
  disabled?: boolean | undefined;
}

/** A half-open range of matched characters, for highlighting. */
export type Range = readonly [start: number, end: number];

export type Row =
  | { kind: 'group'; key: string; label: string }
  | {
      kind: 'option';
      key: string;
      option: ComboboxOption;
      labelHits: Range[];
      detailHits: Range[];
    };

/** Every occurrence of `query` in `text`, case-insensitively. Empty query matches nothing. */
export function matchRanges(text: string, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const hay = text.toLowerCase();
  const out: Range[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    out.push([at, at + needle.length]);
    from = at + needle.length;
  }
  return out;
}

/** Split `text` into the pieces between and inside the matches, for rendering. */
export function highlightParts(
  text: string,
  ranges: readonly Range[],
): Array<{ text: string; hit: boolean }> {
  if (ranges.length === 0) return text === '' ? [] : [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

export function optionMatches(option: ComboboxOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    option.label.toLowerCase().includes(needle) ||
    (option.detail ?? '').toLowerCase().includes(needle)
  );
}

export interface BuildRowsInput {
  options: readonly ComboboxOption[];
  query: string;
  /** Values chosen most recently in this workspace, newest first. */
  recent?: readonly string[];
  /** What the Recent header says. */
  recentLabel: string;
}

/**
 * The flat list the virtualizer renders: group headers and option rows in one array, so
 * every row has an index and a sticky header knows which rows it covers.
 */
export function buildRows({ options, query, recent = [], recentLabel }: BuildRowsInput): Row[] {
  const matching = options.filter((option) => optionMatches(option, query));
  const withHits = (option: ComboboxOption, prefix: string): Row => ({
    kind: 'option',
    key: `${prefix}${option.value}`,
    option,
    labelHits: matchRanges(option.label, query),
    detailHits: matchRanges(option.detail ?? '', query),
  });

  const rows: Row[] = [];
  const recentRows = recent
    .map((value) => matching.find((option) => option.value === value))
    .filter((option): option is ComboboxOption => option !== undefined);
  if (recentRows.length > 0) {
    rows.push({ kind: 'group', key: 'group:recent', label: recentLabel });
    for (const option of recentRows) rows.push(withHits(option, 'recent:'));
  }

  // One provider in scope needs no header; several do.
  const groups = new Set(matching.map((option) => option.group).filter(Boolean));
  const showHeaders = groups.size > 1;
  let current: string | undefined;
  for (const option of matching) {
    if (showHeaders && option.group !== undefined && option.group !== current) {
      current = option.group;
      rows.push({ kind: 'group', key: `group:${option.group}`, label: option.group });
    }
    rows.push(withHits(option, ''));
  }
  return rows;
}

/** Indexes of the rows a person can actually land on. */
export function selectableIndexes(rows: readonly Row[]): number[] {
  const out: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'option' && !row.option.disabled) out.push(index);
  });
  return out;
}

/** The next row the arrows should highlight, never wrapping past the ends. */
export function moveActive(
  rows: readonly Row[],
  active: number,
  step: 'up' | 'down' | 'first' | 'last',
): number {
  const usable = selectableIndexes(rows);
  if (usable.length === 0) return -1;
  if (step === 'first') return usable[0] as number;
  if (step === 'last') return usable[usable.length - 1] as number;
  const at = usable.indexOf(active);
  if (at < 0) return (step === 'down' ? usable[0] : usable[usable.length - 1]) as number;
  const next = step === 'down' ? at + 1 : at - 1;
  return (usable[Math.max(0, Math.min(usable.length - 1, next))] ?? active) as number;
}
