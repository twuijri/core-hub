/**
 * The desktop app's new versions, as the page sees them (DECISIONS §109): the state the app
 * hands over (and every change it makes on its own), and which notice — if any — floats over
 * the page. In a browser there is no bridge and nothing here does anything.
 */
import { useEffect, useState } from 'react';
import type { DesktopBridge, DesktopUpdatesState } from './bridge-types.js';

/** The app's update state, kept current: first `get()`, then every `onChange`. */
export function useDesktopUpdates(
  bridge: DesktopBridge | null,
): [DesktopUpdatesState | null, (next: DesktopUpdatesState) => void] {
  const [state, setState] = useState<DesktopUpdatesState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.updates
      .get()
      .then((next) => live && next && setState(next))
      .catch(() => {});
    const stop = bridge.updates.onChange?.((next) => live && setState(next));
    return () => {
      live = false;
      stop?.();
    };
  }, [bridge]);
  return [state, setState];
}

/**
 * The floating notice:
 * - `ready` — `install` mode, the new version is downloaded: "Restart to update" / "Later";
 * - `available` — `notify` mode (the .deb), or `install` mode when its feed could not be read
 *   but the releases say a newer version is out: a link to get it / "Later".
 * None while a version downloads (This device shows the progress), for the version the person
 * said "Later" to, and never in the Store build.
 */
export type UpdateNotice =
  { kind: 'ready'; version: string } | { kind: 'available'; version: string; href: string };

export function updateNoticeOf(state: DesktopUpdatesState | null): UpdateNotice | null {
  if (!state || state.channel === 'store' || state.mode === 'off' || !state.mode) return null;
  const pending = state.pending ?? null;
  if (pending) {
    if (pending.status !== 'ready' || pending.version === state.dismissed) return null;
    return { kind: 'ready', version: pending.version };
  }
  const last = state.last;
  if (last?.status !== 'available' || !last.update) return null;
  if (last.update.version === state.dismissed) return null;
  return {
    kind: 'available',
    version: last.update.version,
    href: state.downloadPage ?? last.update.download,
  };
}
