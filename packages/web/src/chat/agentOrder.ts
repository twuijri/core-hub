/**
 * The order of the agent chips above the composer.
 *
 * The contract has no per-workspace ordering field for the agent registry, so the order a
 * person drags into is a local preference, kept per workspace in `localStorage` exactly the
 * way the sidebar keeps the session order (`sessions/order.ts`). When the contract grows a
 * field this file is the only place that changes. An agent the remembered list has never
 * seen keeps its server position at the end, so installing one adds a chip instead of
 * shuffling the row.
 */
import { derived } from '@corehub/contracts';
import type { Agent } from '../types.js';

export function agentOrderKey(profile: string): string {
  return `${derived.storagePrefix}agentOrder.${profile}`;
}

export function readAgentOrder(
  storage: Pick<Storage, 'getItem'> | null,
  profile: string,
): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(agentOrderKey(profile)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeAgentOrder(
  storage: Pick<Storage, 'setItem'> | null,
  profile: string,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(agentOrderKey(profile), JSON.stringify([...ids]));
  } catch {
    // A browser with storage switched off still gets the server order; nothing breaks.
  }
}

/** Remembered order first, in that order; everything else keeps the server's order after it. */
export function arrangeAgents<T extends Pick<Agent, 'id'>>(
  agents: readonly T[],
  manual: readonly string[],
): T[] {
  const rank = new Map(manual.map((id, index) => [id, index]));
  return [...agents].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

/** Move one item, the way a drag does. Out-of-range indexes leave the list alone. */
export function moveAgent<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

/**
 * The order to persist after a drag: what is on screen now, plus every id that was already
 * remembered but is not on screen (an agent behind a filter, or one temporarily missing),
 * so switching a filter does not quietly forget a person's arrangement.
 */
export function nextOrder(visible: readonly string[], remembered: readonly string[]): string[] {
  const seen = new Set(visible);
  return [...visible, ...remembered.filter((id) => !seen.has(id))];
}
