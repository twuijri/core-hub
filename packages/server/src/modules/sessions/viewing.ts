/**
 * Which conversation each person is looking at right now (DECISIONS §149; the owner, 2026-10-01:
 * «اي رد يوصلني تنبيه على جوالي… اني انا فاتح الصفحة المفروض ما يرسلي تنبيه»).
 *
 * A client on `/rt/sessions` says `viewing { session_id }` while a conversation is open and its
 * page or app is in front (the web: the tab visible and focused; a phone: the chat in the
 * foreground), again every `VIEWING_HEARTBEAT_MS`, and `viewing { session_id: null }` when it
 * stops (hidden, blurred, another screen). What it says lasts `VIEWING_TTL_MS` unless repeated,
 * and goes with its socket. A finished reply, a failure or an approval in a conversation the
 * person is looking at is still written to the inbox, but not pushed to their phones.
 *
 * Memory only, per hub process: after a restart nobody is viewing until their client says so
 * again, which errs on the side of a push. A client that never says it (an older app) is never
 * viewing, so it is pushed to as before.
 */
import type { Server as SocketServer } from 'socket.io';

/** How long one `viewing` lasts unless the client says it again. */
export const VIEWING_TTL_MS = 45_000;

/** How often a client repeats `viewing` while it is still looking (documented for clients). */
export const VIEWING_HEARTBEAT_MS = 20_000;

interface Seen {
  userId: string;
  sessionId: string;
  until: number;
}

export class ViewingRegistry {
  /** One entry per socket: a person may look at a conversation on two screens at once. */
  private readonly bySocket = new Map<string, Seen>();

  constructor(private readonly now: () => number = Date.now) {}

  /** What one socket says: looking at `sessionId`, or at nothing (`null`). */
  set(socketId: string, userId: string, sessionId: string | null): void {
    if (sessionId === null) {
      this.bySocket.delete(socketId);
      return;
    }
    this.bySocket.set(socketId, { userId, sessionId, until: this.now() + VIEWING_TTL_MS });
  }

  /** The socket went away: whatever it was looking at, it no longer is. */
  forget(socketId: string): void {
    this.bySocket.delete(socketId);
  }

  /** Whether any of this person's clients is looking at the conversation right now. */
  isViewing(userId: string, sessionId: string): boolean {
    const now = this.now();
    for (const [socketId, seen] of this.bySocket) {
      if (seen.until <= now) {
        this.bySocket.delete(socketId);
        continue;
      }
      if (seen.userId === userId && seen.sessionId === sessionId) return true;
    }
    return false;
  }
}

const registries = new WeakMap<SocketServer, ViewingRegistry>();

/** The registry of one hub (one Socket.IO server). */
export function viewingFor(io: SocketServer, now?: () => number): ViewingRegistry {
  let registry = registries.get(io);
  if (!registry) {
    registry = new ViewingRegistry(now);
    registries.set(io, registry);
  }
  return registry;
}
