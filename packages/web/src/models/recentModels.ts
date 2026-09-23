import { derived } from '@majlis/contracts';
/**
 * The few models this workspace reached for last.
 *
 * With hundreds of models in a provider's catalogue, the ones a person actually uses are
 * a handful, and they should be one keystroke away rather than one search away. The
 * contract has no field for it — it is a per-person convenience, not hub state — so it
 * lives in `localStorage` per workspace, the way the session and agent orders do
 * (`sessions/order.ts`, `chat/agentOrder.ts`). When the contract grows a field, this file
 * is the only one that changes.
 */
export const RECENT_LIMIT = 5;

export function recentModelsKey(profile: string): string {
  return `${derived.storagePrefix}recentModels.${profile}`;
}

export function readRecentModels(
  storage: Pick<Storage, 'getItem'> | null,
  profile: string,
): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(recentModelsKey(profile)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Newest first, no duplicates, capped. Returns the list it stored. */
export function rememberModel(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  profile: string,
  value: string | null,
): string[] {
  if (!storage || value === null || value === '') return readRecentModels(storage, profile);
  const next = [value, ...readRecentModels(storage, profile).filter((v) => v !== value)].slice(
    0,
    RECENT_LIMIT,
  );
  try {
    storage.setItem(recentModelsKey(profile), JSON.stringify(next));
  } catch {
    // A browser with storage switched off simply has no recents; nothing breaks.
  }
  return next;
}
