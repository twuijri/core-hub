/**
 * `/rt/rooms` — the room's own stream (`packages/contracts/events/rooms/*`).
 *
 * Rooms on the Socket.IO server:
 * - `profile:<slug>` — joined by `auth`'s handshake; carries `room.created` only (a room
 *   appearing is news for the list, whose rows then say who may open it).
 * - `room:<id>` — joined by the `join` command, and only by a member of the room in a
 *   workspace the socket was admitted to: every other room event goes here.
 *
 * Commands (client → server): `join { room_id }`, `leave { room_id }`,
 * `typing { room_id, typing }`. Presence (`Member.online`) is the set of people with a socket
 * in the room; it lives in memory and is never stored, like typing.
 */
import type { Namespace, Server as SocketServer, Socket } from 'socket.io';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';

export const roomChannel = (roomId: string): string => `room:${roomId}`;

/** May this socket enter this room? Answers the member's row id and name, or `null`. */
export type RoomAdmission = (
  socket: Socket,
  roomId: string,
) => Promise<{ memberId: string; name: string; profile: string } | null>;

interface Ack {
  (reply: { ok: true } | { ok: false; error: string; code: string }): void;
}

export class RoomsRealtime {
  private readonly nsp: Namespace;
  private readonly realtime: Realtime;
  /** roomId → userId → how many of that person's sockets are in the room. */
  private readonly presence = new Map<string, Map<string, number>>();
  private admit: RoomAdmission = () => Promise.resolve(null);

  constructor(io: SocketServer) {
    this.nsp = io.of(REALTIME_NAMESPACES.rooms);
    this.realtime = createRealtime(io);
  }

  admitWith(check: RoomAdmission): void {
    this.admit = check;
  }

  /** An event for the members of one room. */
  toRoom(profile: string, roomId: string, event: string, payload: Record<string, unknown>): void {
    this.realtime.emit(
      REALTIME_NAMESPACES.rooms,
      event,
      { profile, room: roomChannel(roomId) },
      payload,
    );
  }

  /** An event for everyone in the profile (`room.created`). */
  toProfile(profile: string, event: string, payload: Record<string, unknown>): void {
    this.realtime.emit(REALTIME_NAMESPACES.rooms, event, { profile }, payload);
  }

  /** An event for one person's sockets (`member.left` to the person who was removed). */
  toUser(profile: string, userId: string, event: string, payload: Record<string, unknown>): void {
    this.realtime.emit(REALTIME_NAMESPACES.rooms, event, { profile, userId }, payload);
  }

  isOnline(roomId: string, userId: string): boolean {
    return (this.presence.get(roomId)?.get(userId) ?? 0) > 0;
  }

  /** A removed member's sockets leave the room's channel at once. */
  evict(roomId: string, userId: string): void {
    for (const socket of this.nsp.sockets.values()) {
      const principal = (socket.data as { principal?: { user: { id: string } } }).principal;
      if (principal?.user.id === userId) void socket.leave(roomChannel(roomId));
    }
    this.presence.get(roomId)?.delete(userId);
  }

  /** A deleted room's channel is emptied. */
  close(roomId: string): void {
    this.nsp.in(roomChannel(roomId)).socketsLeave(roomChannel(roomId));
    this.presence.delete(roomId);
  }

  attach(): void {
    this.nsp.on('connection', (socket: Socket) => {
      const joined = new Map<string, { memberId: string; name: string; profile: string }>();
      const userId = (socket.data as { principal?: { user: { id: string } } }).principal?.user.id;

      const enter = (roomId: string) => {
        if (!userId) return;
        const people = this.presence.get(roomId) ?? new Map<string, number>();
        people.set(userId, (people.get(userId) ?? 0) + 1);
        this.presence.set(roomId, people);
      };
      const exit = (roomId: string) => {
        if (!userId) return;
        const people = this.presence.get(roomId);
        if (!people) return;
        const left = (people.get(userId) ?? 1) - 1;
        if (left > 0) people.set(userId, left);
        else people.delete(userId);
      };

      socket.on('join', (payload: unknown, ack?: Ack) => {
        const roomId = readRoomId(payload);
        if (!roomId) return reply(ack, badRequest('room_id is required'));
        this.admit(socket, roomId).then(
          (member) => {
            if (!member) return reply(ack, notFound(roomId));
            if (socket.disconnected) return;
            if (!joined.has(roomId)) {
              joined.set(roomId, member);
              enter(roomId);
            }
            void socket.join(roomChannel(roomId));
            reply(ack, { ok: true });
          },
          () => reply(ack, notFound(roomId)),
        );
      });

      socket.on('leave', (payload: unknown, ack?: Ack) => {
        const roomId = readRoomId(payload);
        if (!roomId) return reply(ack, badRequest('room_id is required'));
        void socket.leave(roomChannel(roomId));
        if (joined.delete(roomId)) exit(roomId);
        reply(ack, { ok: true });
      });

      socket.on('typing', (payload: unknown, ack?: Ack) => {
        const roomId = readRoomId(payload);
        const member = roomId ? joined.get(roomId) : undefined;
        if (!roomId || !member) return reply(ack, notFound(roomId ?? ''));
        const typing = (payload as { typing?: unknown }).typing === true;
        this.toRoom(member.profile, roomId, 'member.typing', {
          room_id: roomId,
          member_id: member.memberId,
          name: member.name,
          typing,
        });
        reply(ack, { ok: true });
      });

      socket.on('disconnect', () => {
        for (const roomId of joined.keys()) exit(roomId);
        joined.clear();
      });
    });
  }
}

const layers = new WeakMap<SocketServer, RoomsRealtime>();

export function roomsRealtimeFor(io: SocketServer): RoomsRealtime {
  const existing = layers.get(io);
  if (existing) return existing;
  const layer = new RoomsRealtime(io);
  layers.set(io, layer);
  return layer;
}

function readRoomId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as { room_id?: unknown }).room_id;
  return typeof value === 'string' && value.length === 26 ? value : null;
}

function badRequest(message: string) {
  return { ok: false as const, error: message, code: 'bad_request' };
}

function notFound(roomId: string) {
  return { ok: false as const, error: `room ${roomId} not found`, code: 'not_found' };
}

function reply(ack: Ack | undefined, value: Parameters<Ack>[0]): void {
  if (typeof ack === 'function') ack(value);
}
