/**
 * Which MCP rows are open on this device (owner, 2026-09-28).
 *
 * A row of the MCP page folds: its header says what the server is, and a press on it opens
 * what is under it — the address, the sign-in, the last test. Like the sidebar's groups, the
 * choice is this device's own, so it lives in `localStorage`, read and written inside
 * try/catch: a private window or blocked storage simply starts every row at its default.
 *
 * The default is closed, except for a row that needs the person (a sign-in that ran out, or
 * one never made): that one starts open. The default is taken once, when the row is first
 * shown, and is not written down — so a row does not fold itself the moment its sign-in
 * succeeds, and a row the person never touched follows the default the next time.
 */
import { derived } from '@corehub/contracts';
import { useCallback, useEffect, useState } from 'react';

export const MCP_EXPANDED_STORAGE = `${derived.storagePrefix}mcp-expanded`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The choices this device made, by row key; anything unreadable counts as none. */
export function readExpanded(store: Store | null = defaultStore()): Record<string, boolean> {
  try {
    const raw = store?.getItem(MCP_EXPANDED_STORAGE);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Records one row's choice; `null` forgets it (the server was deleted). */
export function writeExpanded(
  key: string,
  open: boolean | null,
  store: Store | null = defaultStore(),
): void {
  try {
    const next = readExpanded(store);
    if (open === null) delete next[key];
    else next[key] = open;
    store?.setItem(MCP_EXPANDED_STORAGE, JSON.stringify(next));
  } catch {
    // fine: the choice then lasts until the page is reloaded
  }
}

/** The key of one row: the agent and the server's name (`#hub` for the hub's own card). */
export function expandedKey(agentId: string | undefined, name: string): string {
  return `${agentId ?? ''}/${name}`;
}

/**
 * Whether one row is open, and the setter its header calls. `attention` is the default, read
 * once `ready` is true (the hub's card waits for its settings before it knows).
 */
export function useMcpExpanded(
  key: string,
  attention: boolean,
  ready = true,
): [boolean, (open: boolean) => void] {
  const [choice, setChoice] = useState<boolean | null>(() => readExpanded()[key] ?? null);
  const [initial, setInitial] = useState<boolean | null>(() => (ready ? attention : null));
  useEffect(() => {
    if (initial === null && ready) setInitial(attention);
  }, [initial, ready, attention]);
  const setOpen = useCallback(
    (open: boolean) => {
      setChoice(open);
      writeExpanded(key, open);
    },
    [key],
  );
  return [choice ?? initial ?? false, setOpen];
}
