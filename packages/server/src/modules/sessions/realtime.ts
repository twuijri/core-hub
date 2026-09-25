/**
 * `/rt/sessions` — the streaming surface of this module.
 *
 * Envelope, names and payloads are `packages/contracts/events/sessions/*`:
 *
 *   { event, namespace: '/rt/sessions', profile, ts, seq, payload }
 *
 * `seq` is monotonic per (namespace, profile), as the contract says, so one
 * counter serves every room of a workspace and a client can detect a gap
 * across sessions.
 *
 * Rooms:
 * - `profile:<slug>` — joined by `auth`'s handshake middleware, from the
 *   verified token and only for a workspace the caller may enter; carries the
 *   profile-wide events (`session.*`, `approval.*`) the contract marks "no
 *   subscription needed". This module never joins a profile room itself.
 * - `session:<id>` — joined by the `subscribe` command, and only after the
 *   `FollowCheck` the module wires in (`index.ts`) has found the session in
 *   one of the socket's workspaces, exactly as `GET /sessions/{id}` would;
 *   carries the transcript events of one session.
 *
 * Commands (client -> server) are only `subscribe` / `unsubscribe`: every
 * mutation goes over HTTP (events/README.md §Connecting and subscribing).
 *
 * Authentication is `auth`'s (`modules/auth/sockets.ts`): a socket reaches
 * this namespace only with a verified principal. Until the module wires the
 * follow check, every `subscribe` is refused — closed, not open.
 */
import type { Namespace, Server as SocketServer, Socket } from 'socket.io';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { ResumeJournal, type JournalEntry } from './journal.js';

export const SESSIONS_NAMESPACE = REALTIME_NAMESPACES.sessions;

export type SessionEventName =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'message.created'
  | 'message.delta'
  | 'reasoning.delta'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'run.queued'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'approval.requested'
  | 'approval.resolved'
  | 'context.updated'
  | 'context.compression'
  | 'subagent.started'
  | 'subagent.updated'
  | 'subagent.completed';

export interface Envelope {
  event: string;
  namespace: string;
  profile: string;
  ts: string;
  seq: number;
  payload: unknown;
}

export interface SubscribeAck {
  ok: true;
  /** How many missed events were re-sent on this socket. */
  replayed: number;
  /** True when the replay may be incomplete — refetch the session document. */
  truncated: boolean;
}

export interface ErrorAck {
  ok: false;
  error: string;
  code: string;
}

export const profileRoom = (profile: string): string => `profile:${profile}`;
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

/**
 * May this socket follow this session? True only when the session exists in a workspace
 * the socket was admitted to — the same lookup `GET /sessions/{id}` makes. Anything else
 * (another workspace, an unknown id, no principal) is false and the caller hears
 * `not_found`, so a refusal does not reveal whether the id exists elsewhere.
 */
export type FollowCheck = (socket: Socket, sessionId: string) => Promise<boolean>;

const refuseAll: FollowCheck = () => Promise.resolve(false);

export class SessionsRealtime {
  readonly journal: ResumeJournal;
  private readonly sequences = new Map<string, number>();
  private canFollow: FollowCheck = refuseAll;

  constructor(
    private readonly nsp: Namespace,
    journal: ResumeJournal = new ResumeJournal(),
  ) {
    this.journal = journal;
  }

  /** Profile-wide event: everyone scoped to this workspace sees it. */
  emitToProfile(profile: string, event: SessionEventName, payload: unknown): Envelope {
    const envelope = this.envelope(profile, event, payload);
    this.nsp.to(profileRoom(profile)).emit(event, envelope);
    return envelope;
  }

  /**
   * Profile-wide *and* journaled under a session.
   *
   * `approval.requested` / `approval.resolved` are profile-wide so the
   * pending-actions bar shows them from any screen, but a client that was
   * offline while one was raised still has to learn about it, so the envelope
   * is recorded in the session's journal. It is emitted once, to the profile
   * room only: a socket that is in both rooms must not receive it twice.
   */
  emitToProfileFor(
    profile: string,
    sessionId: string,
    event: SessionEventName,
    payload: unknown,
  ): Envelope {
    const envelope = this.envelope(profile, event, payload);
    this.journal.append(sessionId, { seq: envelope.seq, envelope });
    this.nsp.to(profileRoom(profile)).emit(event, envelope);
    return envelope;
  }

  /**
   * Transcript event: subscribers of the session only, and journaled so a
   * reconnecting client can be handed exactly what it missed.
   */
  emitToSession(
    profile: string,
    sessionId: string,
    event: SessionEventName,
    payload: unknown,
  ): Envelope {
    const envelope = this.envelope(profile, event, payload);
    this.journal.append(sessionId, { seq: envelope.seq, envelope });
    this.nsp.to(sessionRoom(sessionId)).emit(event, envelope);
    return envelope;
  }

  /** Wires the check `subscribe` runs before joining a session's room (`index.ts`). */
  authorizeFollowWith(check: FollowCheck): void {
    this.canFollow = check;
  }

  /** Attach the namespace handlers. Called once per app from `registerEvents`. */
  attach(): void {
    this.nsp.on('connection', (socket: Socket) => {
      socket.on('subscribe', (payload: unknown, ack?: (reply: SubscribeAck | ErrorAck) => void) => {
        const sessionId = readSessionId(payload);
        if (!sessionId) return reply(ack, badRequest('session_id is required'));
        this.canFollow(socket, sessionId).then(
          (allowed) => {
            if (!allowed) return reply(ack, notFound(sessionId));
            // The socket may have gone while the check ran; nothing to join then.
            if (socket.disconnected) return;
            void socket.join(sessionRoom(sessionId));
            const afterSeq = readAfterSeq(payload);
            const slice = this.journal.since(sessionId, afterSeq);
            for (const entry of slice.entries) socket.emit(entry.envelope.event, entry.envelope);
            reply(ack, { ok: true, replayed: slice.entries.length, truncated: slice.truncated });
          },
          () => reply(ack, notFound(sessionId)),
        );
      });

      socket.on(
        'unsubscribe',
        (payload: unknown, ack?: (reply: SubscribeAck | ErrorAck) => void) => {
          const sessionId = readSessionId(payload);
          if (!sessionId) return reply(ack, badRequest('session_id is required'));
          void socket.leave(sessionRoom(sessionId));
          reply(ack, { ok: true, replayed: 0, truncated: false });
        },
      );
    });
  }

  private envelope(profile: string, event: SessionEventName, payload: unknown): Envelope {
    const seq = (this.sequences.get(profile) ?? 0) + 1;
    this.sequences.set(profile, seq);
    return {
      event,
      namespace: SESSIONS_NAMESPACE,
      profile,
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      seq,
      payload,
    };
  }
}

/** One realtime layer per Socket.IO server, shared by the sockets and the routes. */
const layers = new WeakMap<SocketServer, SessionsRealtime>();

export function attachSessionsRealtime(io: SocketServer): SessionsRealtime {
  const existing = layers.get(io);
  if (existing) return existing;
  const layer = new SessionsRealtime(io.of(SESSIONS_NAMESPACE));
  layer.attach();
  layers.set(io, layer);
  return layer;
}

export function sessionsRealtimeFor(io: SocketServer): SessionsRealtime | undefined {
  return layers.get(io);
}

function readSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value.length === 26 ? value : null;
}

function readAfterSeq(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = (payload as { after_seq?: unknown }).after_seq;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function badRequest(message: string): ErrorAck {
  return { ok: false, error: message, code: 'bad_request' };
}

function notFound(sessionId: string): ErrorAck {
  return { ok: false, error: `session ${sessionId} not found`, code: 'not_found' };
}

function reply(
  ack: ((reply: SubscribeAck | ErrorAck) => void) | undefined,
  value: SubscribeAck | ErrorAck,
): void {
  if (typeof ack === 'function') ack(value);
}

export type { JournalEntry };
