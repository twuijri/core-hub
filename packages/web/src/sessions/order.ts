// Manual order of the sidebar list. The contract has no sort field (only `pinned`), so the
// order a person drags into is kept locally per workspace and applied on top of the server's
// `last_message_at desc` order; unknown sessions keep the server order.
import { derived } from '@majlis/contracts';
import type { Session } from '../types.js';

export function orderKey(profile: string): string {
  return `${derived.storagePrefix}sessionOrder.${profile}`;
}

export function readOrder(storage: Pick<Storage, 'getItem'> | null, profile: string): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(orderKey(profile)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeOrder(
  storage: Pick<Storage, 'setItem'> | null,
  profile: string,
  ids: string[],
): void {
  try {
    storage?.setItem(orderKey(profile), JSON.stringify(ids));
  } catch {
    // fine
  }
}

/** Pinned first; within each group the remembered manual order, then the server order. */
export function arrange(sessions: readonly Session[], manual: readonly string[]): Session[] {
  const rank = new Map(manual.map((id, i) => [id, i]));
  const sorted = [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
  return sorted;
}

export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}
