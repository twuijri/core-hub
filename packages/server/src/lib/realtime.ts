/**
 * The realtime envelope every Socket.IO message carries
 * (`packages/contracts/events/README.md` §Envelope):
 *
 *     { event, namespace, profile, ts, seq, payload }
 *
 * `seq` is monotonic per (namespace, profile); a client that sees a gap refetches over
 * HTTP. `profile` is null only for user-level events on `/rt/devices`.
 *
 * Modules emit through this interface and never touch Socket.IO directly, so the rooms a
 * payload reaches stay in one place: `profile:<slug>` for workspace-wide events and
 * `user:<id>` for user-level ones. Only the server joins a socket to a room, from the
 * authenticated principal (`modules/auth/sockets.ts`).
 */
import type { Server as SocketServer } from 'socket.io';
import type { RealtimeNamespace } from './module.js';

export interface RealtimeEnvelope {
  event: string;
  namespace: string;
  profile: string | null;
  ts: string;
  seq: number;
  payload: Record<string, unknown>;
}

export interface EmitTarget {
  /** Workspace slug; every socket that joined this profile's room receives the event. */
  profile?: string | null;
  /** Deliver only to the sockets of one user (device- and notice-level events). */
  userId?: string;
  /** Deliver only to sockets that subscribed to this entity (`session:<id>`, …). */
  room?: string;
}

export interface Realtime {
  emit(
    namespace: RealtimeNamespace,
    event: string,
    target: EmitTarget,
    payload: Record<string, unknown>,
  ): RealtimeEnvelope;
  /** Room name helpers, shared by the emitters and the socket handlers. */
  profileRoom(profile: string): string;
  userRoom(userId: string): string;
}

export const profileRoom = (profile: string): string => `profile:${profile}`;
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * An event as it left the hub, for a listener that is not a socket (the webhooks of
 * `notify`, contract decision §59). `profile` is the workspace slug, or null for a
 * user-level event; `payload` is the envelope's, exactly as the clients receive it.
 */
export interface TappedEvent {
  namespace: string;
  event: string;
  profile: string | null;
  ts: string;
  payload: unknown;
}

export type RealtimeTap = (event: TappedEvent) => void;

/**
 * Listeners per Socket.IO server, the key every module already holds. Every emitter —
 * `createRealtime` here, the sessions layer, `auth`'s `emitToUser` — hands each event to
 * them after it has gone to the sockets, so a module can follow what happens in the hub
 * without every other module knowing it exists.
 */
const taps = new WeakMap<SocketServer, Set<RealtimeTap>>();

/** Follow every event emitted on this server; returns the function that stops. */
export function tapRealtime(io: SocketServer, tap: RealtimeTap): () => void {
  const set = taps.get(io) ?? new Set<RealtimeTap>();
  set.add(tap);
  taps.set(io, set);
  return () => {
    set.delete(tap);
  };
}

/** Hand one emitted event to the listeners. A listener that throws never breaks an emit. */
export function publishToTaps(io: SocketServer | null | undefined, event: TappedEvent): void {
  const set = io ? taps.get(io) : undefined;
  if (!set) return;
  for (const tap of set) {
    try {
      tap(event);
    } catch {
      // The event already reached the sockets; a listener's failure is its own.
    }
  }
}

export function createRealtime(io: SocketServer, now: () => Date = () => new Date()): Realtime {
  const sequences = new Map<string, number>();
  return {
    profileRoom,
    userRoom,
    emit(namespace, event, target, payload) {
      const profile = target.profile ?? null;
      const key = `${namespace}|${profile ?? ''}`;
      const seq = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, seq);
      const envelope: RealtimeEnvelope = {
        event,
        namespace,
        profile,
        ts: now()
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
        seq,
        payload,
      };
      const nsp = io.of(namespace);
      const room = target.room ?? (target.userId ? userRoom(target.userId) : undefined);
      if (room) nsp.to(room).emit(event, envelope);
      else if (profile) nsp.to(profileRoom(profile)).emit(event, envelope);
      // No room and no profile names nobody: never the whole namespace, which would be
      // every signed-in person of every workspace.
      publishToTaps(io, { namespace, event, profile, ts: envelope.ts, payload });
      return envelope;
    },
  };
}
