/**
 * Folding the sidebar into a rail of icons (owner, 2026-09-26: the ChatGPT-style sidebar).
 *
 * On a wide screen the sidebar can fold to a narrow rail that keeps only the icons: new chat,
 * the main destinations, search, and the person's menu. The choice is this browser's own — a
 * per-device convenience like the selected segment, not an account setting — so it lives in
 * `localStorage`, read and written inside try/catch: a private window or blocked storage
 * simply starts unfolded. The phone drawer never folds.
 *
 * `Ctrl+Shift+S` (`⌘⇧S` on a Mac) toggles it, the shortcut ChatGPT uses for the same thing.
 * It is matched on the physical key (`KeyS`), so it works with an Arabic keyboard layout too,
 * where the key types «س».
 */
import { derived } from '@corehub/contracts';
import { useCallback, useEffect, useState } from 'react';

export const FOLD_STORAGE = `${derived.storagePrefix}sidebar-folded`;

/** The width at which the sidebar sits beside the page (Tailwind `md`): below it, the drawer. */
export const WIDE_QUERY = '(min-width: 48rem)';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readFolded(store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(FOLD_STORAGE) === '1';
  } catch {
    return false;
  }
}

export function writeFolded(folded: boolean, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(FOLD_STORAGE, folded ? '1' : '0');
  } catch {
    // fine: the choice then lasts until the page is reloaded
  }
}

type Keys = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'code'>;

/** Ctrl+Shift+S, or ⌘⇧S: the physical S key, whatever the layout types on it. */
export function isFoldShortcut(event: Keys): boolean {
  return (
    (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyS'
  );
}

export function isMac(
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
) {
  return /mac|iphone|ipad/i.test(platform);
}

/** The shortcut as the person's keyboard spells it. Keys are not words: never translated. */
export function foldShortcutLabel(mac: boolean = isMac()): string {
  return mac ? '⌘⇧S' : 'Ctrl+Shift+S';
}

/** The same keys in `aria-keyshortcuts` notation. */
export function foldShortcutAria(mac: boolean = isMac()): string {
  return mac ? 'Meta+Shift+S' : 'Control+Shift+S';
}

function wide(): boolean {
  try {
    return typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches;
  } catch {
    return true;
  }
}

/** The folded state, remembered per browser, and the keyboard shortcut that toggles it. */
export function useSidebarFold(): { folded: boolean; toggle(): void } {
  const [folded, setFolded] = useState(() => readFolded());
  const toggle = useCallback(() => {
    setFolded((value) => {
      writeFolded(!value);
      return !value;
    });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || !isFoldShortcut(event)) return;
      // On a phone-width window there is no sidebar beside the page to fold.
      if (!wide()) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
  return { folded, toggle };
}
