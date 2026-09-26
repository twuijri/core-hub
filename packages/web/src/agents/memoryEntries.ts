/**
 * The two memory lists as Hermes keeps them (decision §102): short entries separated by a line
 * holding only `§`, within a budget in characters. The hub sends the entries and the budget
 * (`MemoryItem.entries`, `char_limit`, `char_count`); these helpers are how the page edits one
 * entry and says what the list would count before it is saved, counted the way the hub counts
 * (code points of the entries joined), so the counter never disagrees with a refusal.
 */
import type { MemoryItem } from './skills.js';

export const ENTRY_SEPARATOR = '\n§\n';

/** Split on a `§` line, trimmed, empties dropped — what the agent reads. */
export function entriesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*§[ \t]*\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function joinEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_SEPARATOR);
}

/** Characters as the budget counts them: code points, so an emoji is one, not two. */
export function lengthOf(entries: readonly string[]): number {
  return [...joinEntries(entries)].length;
}

/** The item's entries: the hub's own split, or — from an older hub — the same split here. */
export function listOf(item: MemoryItem): string[] {
  return item.entries ?? entriesOf(item.content ?? '');
}

/** Whether a document is a list of entries (the two memories), not one text (the persona). */
export function isList(item: MemoryItem): boolean {
  return item.kind === 'document' && item.id !== 'soul';
}

export type BudgetTone = 'normal' | 'warning' | 'danger';

/** How full the list is: warning from 80 %, danger past the limit. */
export function toneOf(count: number, limit: number | null | undefined): BudgetTone {
  if (!limit) return 'normal';
  if (count > limit) return 'danger';
  return count >= limit * 0.8 ? 'warning' : 'normal';
}

/**
 * Whether the hub would take this list: within the budget, or — for a list already over it —
 * not longer than it is now (shrinking is always allowed, growing past the budget never).
 */
export function fits(next: number, current: number, limit: number | null | undefined): boolean {
  if (!limit || next <= limit) return true;
  return next <= current;
}
