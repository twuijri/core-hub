// What the searchable list shows for a query (src/ui/combobox-filter.ts): matching over
// both the display name and the id, the highlighted ranges, the Recent group, and the
// group headers that only appear when more than one provider is in scope.
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  highlightParts,
  matchRanges,
  moveActive,
  optionMatches,
  selectableIndexes,
  type ComboboxOption,
} from '../src/ui/combobox-filter.js';

const option = (value: string, label: string, group?: string): ComboboxOption => ({
  value,
  label,
  detail: value,
  ...(group === undefined ? {} : { group }),
});

const CATALOGUE = [
  option('anthropic/claude-opus-4-6-thinking', 'Claude Opus 4.6 (thinking)', 'anthropic'),
  option('anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5', 'anthropic'),
  option('openai/gpt-5', 'GPT-5', 'openai'),
  option('google/gemini-3-pro', 'Gemini 3 Pro', 'google'),
];

describe('matching', () => {
  it('finds the query anywhere, case-insensitively, in the name or the id', () => {
    // The owner's own example: `opus` must find the thinking variant by its id.
    expect(optionMatches(CATALOGUE[0]!, 'opus')).toBe(true);
    expect(optionMatches(CATALOGUE[0]!, 'OPUS')).toBe(true);
    expect(optionMatches(CATALOGUE[0]!, 'thinking')).toBe(true);
    // By display name, including the part that is not in the id.
    expect(optionMatches(CATALOGUE[2]!, 'GPT')).toBe(true);
    expect(optionMatches(CATALOGUE[2]!, 'gpt-5')).toBe(true);
    expect(optionMatches(CATALOGUE[2]!, 'claude')).toBe(false);
    // An empty query matches everything, not nothing.
    expect(optionMatches(CATALOGUE[3]!, '   ')).toBe(true);
  });

  it('reports every occurrence, so all of them can be highlighted', () => {
    expect(matchRanges('claude-opus-opus', 'opus')).toEqual([
      [7, 11],
      [12, 16],
    ]);
    expect(matchRanges('GPT-5', 'gpt')).toEqual([[0, 3]]);
    expect(matchRanges('GPT-5', '')).toEqual([]);
    expect(matchRanges('GPT-5', 'zzz')).toEqual([]);
  });

  it('splits the text into the matched and unmatched pieces, losing none of it', () => {
    const parts = highlightParts('claude-opus-4-6', matchRanges('claude-opus-4-6', 'opus'));
    expect(parts).toEqual([
      { text: 'claude-', hit: false },
      { text: 'opus', hit: true },
      { text: '-4-6', hit: false },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('claude-opus-4-6');
    expect(highlightParts('plain', [])).toEqual([{ text: 'plain', hit: false }]);
  });
});

describe('the rows', () => {
  const rows = (query: string, recent: string[] = []) =>
    buildRows({ options: CATALOGUE, query, recent, recentLabel: 'Recent' });

  it('groups by provider with a header each, when more than one is in scope', () => {
    const out = rows('');
    expect(
      out.filter((r) => r.kind === 'group').map((r) => (r as { label: string }).label),
    ).toEqual(['anthropic', 'openai', 'google']);
    expect(out.filter((r) => r.kind === 'option')).toHaveLength(4);
  });

  it('draws no header when everything comes from one provider', () => {
    const out = buildRows({
      options: CATALOGUE.filter((o) => o.group === 'anthropic'),
      query: '',
      recentLabel: 'Recent',
    });
    expect(out.every((r) => r.kind === 'option')).toBe(true);
  });

  it('narrows to what matches, and marks where it matched', () => {
    const out = rows('opus');
    const options = out.filter((r) => r.kind === 'option');
    expect(options).toHaveLength(1);
    const row = options[0] as Extract<(typeof out)[number], { kind: 'option' }>;
    expect(row.option.value).toBe('anthropic/claude-opus-4-6-thinking');
    expect(row.labelHits.length).toBeGreaterThan(0);
    expect(row.detailHits.length).toBeGreaterThan(0);
    // One provider left, so the header goes away with the rest.
    expect(out.filter((r) => r.kind === 'group')).toHaveLength(0);
  });

  it('is empty when nothing matches, rather than falling back to everything', () => {
    expect(rows('zzzz')).toEqual([]);
  });

  it('puts the recently chosen at the top, under their own header, and lists each row once', () => {
    const out = rows('', ['openai/gpt-5']);
    expect(out[0]).toMatchObject({ kind: 'group', label: 'Recent' });
    expect(out[1]).toMatchObject({ kind: 'option' });
    expect((out[1] as { option: ComboboxOption }).option.value).toBe('openai/gpt-5');
    // Not repeated under its provider (owner, 2026-09-26: the recent model showed twice).
    const values = out.flatMap((r) => (r.kind === 'option' ? [r.option.value] : []));
    expect(values).toHaveLength(4);
    expect(new Set(values).size).toBe(4);
    // openai has nothing left below, so it has no header either.
    expect(
      out.filter((r) => r.kind === 'group').map((r) => (r as { label: string }).label),
    ).toEqual(['Recent', 'anthropic', 'google']);
  });

  it('gives the rest a header under Recent even with one provider, and "Recent" is said once', () => {
    // The Images tab: one provider, a recent model and another.
    const images = [
      option('openai/gpt-image-2', 'gpt-image-2', 'openai'),
      option('openai/gpt-image-1', 'gpt-image-1', 'openai'),
    ];
    const out = buildRows({
      options: images,
      query: '',
      recent: ['openai/gpt-image-2'],
      recentLabel: 'Recent',
      restLabel: 'All',
    });
    expect(out.map((r) => (r.kind === 'group' ? `# ${r.label}` : r.option.value))).toEqual([
      '# Recent',
      'openai/gpt-image-2',
      '# openai',
      'openai/gpt-image-1',
    ]);
    // Options that name no provider get the caller's word for "the rest".
    const plain = buildRows({
      options: [option('a', 'A'), option('b', 'B')],
      query: '',
      recent: ['b'],
      recentLabel: 'Recent',
      restLabel: 'All',
    });
    expect(plain.map((r) => (r.kind === 'group' ? `# ${r.label}` : r.option.value))).toEqual([
      '# Recent',
      'b',
      '# All',
      'a',
    ]);
    // Only the recent one left: nothing below, so no second header.
    const only = buildRows({
      options: [images[0]!],
      query: '',
      recent: ['openai/gpt-image-2'],
      recentLabel: 'Recent',
    });
    expect(only.map((r) => r.kind)).toEqual(['group', 'option']);
  });

  it('drops a recent entry that the query filtered out, and one that no longer exists', () => {
    expect(rows('opus', ['openai/gpt-5'])[0]).not.toMatchObject({ label: 'Recent' });
    expect(rows('', ['gone/model'])[0]).not.toMatchObject({ label: 'Recent' });
  });
});

describe('the highlighted row', () => {
  const out = buildRows({ options: CATALOGUE, query: '', recentLabel: 'Recent' });

  it('only ever lands on an option, never on a header', () => {
    const usable = selectableIndexes(out);
    expect(usable.every((i) => out[i]?.kind === 'option')).toBe(true);
    expect(usable).toHaveLength(4);
  });

  it('moves down and up, and stops at the ends instead of wrapping', () => {
    const first = moveActive(out, -1, 'first');
    const second = moveActive(out, first, 'down');
    expect(second).toBeGreaterThan(first);
    expect(moveActive(out, second, 'up')).toBe(first);
    expect(moveActive(out, first, 'up')).toBe(first);
    const last = moveActive(out, -1, 'last');
    expect(moveActive(out, last, 'down')).toBe(last);
  });

  it('skips a disabled row', () => {
    const withDisabled = buildRows({
      options: [option('a', 'A'), { ...option('b', 'B'), disabled: true }, option('c', 'C')],
      query: '',
      recentLabel: 'Recent',
    });
    expect(selectableIndexes(withDisabled)).toHaveLength(2);
    expect(moveActive(withDisabled, 0, 'down')).toBe(2);
  });

  it('has nothing to highlight in an empty list', () => {
    expect(moveActive([], -1, 'first')).toBe(-1);
  });
});
