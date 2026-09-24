/**
 * Browser keys from before the rename (Majlis → Core Hub, ADR 0017).
 *
 * Every preference this client keeps — the session, the theme, the pane width, the orders
 * a person dragged — lived under `majlis.*` and lives under `corehub.*` now. Moving them
 * once, before anything reads them, is what keeps a person signed in and their preferences
 * where they left them after an image upgrade. A key already written under the new name
 * wins; the old one is removed either way, so the move happens exactly once.
 */
import { LEGACY, derived } from '@corehub/contracts';

type KeyStore = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/** Moves `majlis.*` to `corehub.*` in one store. Returns the new names it filled. */
export function migrateLegacyKeys(store: KeyStore | null | undefined): string[] {
  if (!store) return [];
  const moved: string[] = [];
  try {
    const legacy: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(LEGACY.storagePrefix)) legacy.push(key);
    }
    for (const key of legacy) {
      const value = store.getItem(key);
      const next = `${derived.storagePrefix}${key.slice(LEGACY.storagePrefix.length)}`;
      if (value !== null && store.getItem(next) === null) {
        store.setItem(next, value);
        moved.push(next);
      }
      store.removeItem(key);
    }
  } catch {
    // A store that refuses (private mode, quota) keeps what it has; nothing here is required.
  }
  return moved;
}

/** Both of the browser's stores, as the app starts. */
export function migrateLegacyStorage(): void {
  migrateLegacyKeys(typeof localStorage === 'undefined' ? null : localStorage);
  migrateLegacyKeys(typeof sessionStorage === 'undefined' ? null : sessionStorage);
}
