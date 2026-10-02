// Tells the hub which conversation this tab is showing to the person right now, so a reply
// that finishes there is not pushed to their phone as well (DECISIONS §149; the owner,
// 2026-10-01: «اي رد يوصلني تنبيه على جوالي… اني انا فاتح الصفحة المفروض ما يرسلي تنبيه»).
//
// "Showing" is: this conversation is open, the tab is visible, and the window has focus. While
// that holds, the tab says `viewing { session_id }` on `/rt/sessions`, and again every 20 s (the
// hub forgets it after 45 s); the moment it stops — hidden, blurred, another conversation, the
// page closed — it says `viewing { session_id: null }`. A reconnect says it again. A hub older
// than this ignores the command, and pushes as before.
import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { useRealtime } from './context.js';

/** How often the tab repeats `viewing` while it still shows the conversation. */
export const VIEWING_HEARTBEAT_MS = 20_000;

/** Whether the person can see this page right now: visible and focused. */
export function pageInFront(
  doc: Pick<Document, 'visibilityState' | 'hasFocus'> = document,
): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus();
}

export function sayViewing(socket: Socket, sessionId: string | null): void {
  if (!socket.connected) return;
  // An older hub has no handler and never answers; nothing waits for the ack.
  socket.emit('viewing', { session_id: sessionId }, () => undefined);
}

export function useViewing(sessionId: string | null): void {
  const realtime = useRealtime();
  useEffect(() => {
    if (!sessionId) return;
    const socket = realtime.socket('sessions');
    let said: string | null = null;
    const update = () => {
      const next = pageInFront() ? sessionId : null;
      // A heartbeat repeats a `viewing`; a `null` is said once.
      if (next === null && said === null) return;
      said = next;
      sayViewing(socket, next);
    };
    const heartbeat = setInterval(() => {
      if (said !== null) sayViewing(socket, said);
    }, VIEWING_HEARTBEAT_MS);
    // After a reconnect the hub knows nothing of this tab: say it again.
    const onConnect = () => {
      said = null;
      update();
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    window.addEventListener('pagehide', update);
    socket.on('connect', onConnect);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      window.removeEventListener('pagehide', update);
      socket.off('connect', onConnect);
      if (said !== null) sayViewing(socket, null);
    };
    // The socket object is stable until every socket is dropped, which `epoch` counts.
  }, [sessionId, realtime.epoch]);
}
