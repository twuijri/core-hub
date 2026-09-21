// Cursor paging for every list in the contract: `{ items, next_cursor }` with an opaque
// cursor (`Cursor` parameter, ≤ 512 chars). Ids are ULIDs and therefore time-sortable, so
// the cursor is just the last id seen, base64url-encoded so clients cannot build one.
import { isUlid } from '../db/ids.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function encodeCursor(lastId: string): string {
  return Buffer.from(lastId, 'utf8').toString('base64url');
}

/** Returns null for an absent or unreadable cursor: a bad cursor restarts the list. */
export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  return isUlid(value) ? value : null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Takes one row more than the page size to learn whether another page exists.
 * Call with `rows` fetched at `limit + 1`.
 */
export function pageOf<T extends { id: string }, S>(
  rows: T[],
  limit: number,
  serialize: (row: T) => S,
): { items: S[]; next_cursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(serialize),
    next_cursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}
