/**
 * The line under a channel composer, «Goes out on Telegram first…» (owner, 2026-10-27): once
 * read, it can be put away. The choice is this browser's own, like the folded sidebar
 * (shell/sidebarFold.ts), so it lives in `localStorage`, read and written inside try/catch: a
 * private window or blocked storage simply shows the line again. Put away, the same words stay
 * one hover away on the small ⓘ beside the send button, and the composer still describes
 * itself with them to a screen reader.
 */
import { derived } from '@corehub/contracts';
import { useCallback, useState } from 'react';

export const HINT_STORAGE = `${derived.storagePrefix}channel-send-hint-hidden`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readHintHidden(store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(HINT_STORAGE) === '1';
  } catch {
    return false;
  }
}

export function writeHintHidden(hidden: boolean, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(HINT_STORAGE, hidden ? '1' : '0');
  } catch {
    // fine: the choice then lasts until the page is reloaded
  }
}

/** Whether the line is put away on this device, and the way to change it. */
export function useChannelHintHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(readHintHidden);
  const set = useCallback((next: boolean) => {
    writeHintHidden(next);
    setHidden(next);
  }, []);
  return [hidden, set];
}
