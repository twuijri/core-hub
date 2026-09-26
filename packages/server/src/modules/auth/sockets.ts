// Realtime side of auth. Every namespace requires `auth.token` — the same bearer as HTTP,
// resolved by the same `resolvePrincipal` (JWT sessions and `hub_at_…` app tokens, revoked
// sessions and disabled users refused). A socket without one, or with one the hub refuses,
// never connects: the handshake fails with the contract's error code as the message
// (`unauthorized`, `token_expired`, `profile_not_found`, …) and `{ code }` as its data.
//
// Rooms are decided here, from the principal, never from what the client claims:
// - `user:<id>` — the caller's own user-level events (`pairing.claimed`, `device.linked`);
// - `profile:<slug>` — only for the workspace the handshake names, and only when the
//   caller may enter it (`resolveWorkspaceFor`, the same rule as `X-Hub-Profile`); with
//   `profiles: 'all'` (ADR 0016) also every other workspace `listWorkspacesFor` allows.
// Entity rooms (`session:<id>`, …) are joined by the module that owns the entity, after
// it has checked the entity belongs to one of `socket.data.workspaces`.
//
// A socket outlives the request that opened it, so whatever can take access away (logout,
// a revoked token, a disabled or deleted user, a new role, a new membership, an archived
// workspace) calls `revalidateSockets`, which disconnects every socket no longer admitted.
import type { Server as SocketServer, Socket } from 'socket.io';
import { eq } from 'drizzle-orm';
import { socketAddressOf } from '../../lib/client-address.js';
import type { ModuleDb } from '../../lib/db.js';
import { HubError, type ErrorCode } from '../../lib/errors.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { profileRoom, publishToTaps } from '../../lib/realtime.js';
import type { AuthContext } from './context.js';
import { resolvePrincipal, type Principal } from './principal.js';
import { appTokens } from './schema.js';
import { findUser } from './users.js';
import {
  canEnter,
  findWorkspace,
  listWorkspacesFor,
  resolveWorkspaceFor,
  toScope,
  type WorkspaceScope,
} from './workspace.js';

/** What the handshake leaves in `socket.data` for the modules that own entity rooms. */
export interface AuthSocketData {
  /** Who opened the socket; set by the handshake middleware, never absent after it. */
  principal?: Principal;
  /** The workspaces this socket was admitted to; it is in each one's profile room. */
  workspaces?: WorkspaceScope[];
}

const dataOf = (socket: Socket): AuthSocketData => socket.data as AuthSocketData;

export const userRoom = (userId: string) => `user:${userId}`;

/** A handshake refusal the client can branch on: `err.message` and `err.data.code`. */
export function socketRefusal(code: ErrorCode | string): Error {
  return Object.assign(new Error(code), { data: { code } });
}

export function registerSocketAuth(io: SocketServer, ctx: () => AuthContext | null): void {
  for (const namespace of Object.values(REALTIME_NAMESPACES)) {
    io.of(namespace).use((socket: Socket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return next(socketRefusal('unauthorized'));
      }
      const context = ctx();
      if (!context) return next(socketRefusal('unauthorized'));
      const ip = socketAddressOf(socket);
      const profile = socket.handshake.auth?.profile;
      resolvePrincipal(context, token, ip).then(
        (principal) => {
          // Workspace-wide events (`/rt/jobs`, and the streaming namespaces) reach
          // `profile:<slug>`; the handshake names the workspace the same way
          // `X-Hub-Profile` does (packages/contracts/events/README.md §Connecting).
          const workspaces: WorkspaceScope[] = [];
          if (typeof profile === 'string' && profile.length > 0) {
            try {
              workspaces.push(resolveWorkspaceFor(context.db, principal.user, profile));
            } catch (error) {
              return next(
                socketRefusal(error instanceof HubError ? error.code : 'profile_not_found'),
              );
            }
          }
          // A list across profiles (ADR 0016) hears every profile it shows: `profiles: 'all'`
          // adds each workspace this person may enter — the same rule as `X-Hub-Profile` and
          // `sessions.list?profiles=all`, decided here, not by the client.
          if (socket.handshake.auth?.profiles === 'all') {
            for (const row of listWorkspacesFor(context.db, principal.user)) {
              if (!workspaces.some((known) => known.id === row.id)) workspaces.push(toScope(row));
            }
          }
          dataOf(socket).principal = principal;
          dataOf(socket).workspaces = workspaces;
          void socket.join(userRoom(principal.user.id));
          for (const workspace of workspaces) void socket.join(profileRoom(workspace.slug));
          next();
        },
        (error: unknown) => {
          next(socketRefusal(error instanceof HubError ? error.code : 'unauthorized'));
        },
      );
    });
  }
}

/**
 * Disconnects every socket whose principal is no longer admitted: its token (the web
 * session or the app token) revoked, expired or gone; its user disabled, deleted or given
 * another role; or one of its workspaces archived or no longer enterable. Returns how many
 * were dropped. A web client comes back on its own and is admitted, or refused, afresh.
 */
export function revalidateSockets(io: SocketServer | null, db: ModuleDb, now: number): number {
  if (!io) return 0;
  let dropped = 0;
  for (const namespace of Object.values(REALTIME_NAMESPACES)) {
    for (const socket of io.of(namespace).sockets.values()) {
      if (stillAdmitted(db, socket, now)) continue;
      socket.disconnect(true);
      dropped += 1;
    }
  }
  return dropped;
}

function stillAdmitted(db: ModuleDb, socket: Socket, now: number): boolean {
  const { principal, workspaces = [] } = dataOf(socket);
  if (!principal) return false;
  const token = db.select().from(appTokens).where(eq(appTokens.id, principal.tokenId)).get();
  if (!token || token.revokedAt || token.userId !== principal.user.id) return false;
  if (token.expiresAt && token.expiresAt.getTime() <= now) return false;
  const user = findUser(db, principal.user.id);
  if (!user || user.status !== 'active' || user.role !== principal.user.role) return false;
  return workspaces.every(
    (workspace) =>
      findWorkspace(db, workspace.id)?.id === workspace.id && canEnter(db, user, workspace.id),
  );
}

let seq = 0;

/** Emits a contract-shaped event envelope to one user's sockets on a namespace. */
export function emitToUser(
  io: SocketServer | null,
  userId: string,
  namespace: string,
  event: string,
  payload: Record<string, unknown>,
  now: number,
): void {
  if (!io) return;
  seq += 1;
  const ts = new Date(now).toISOString();
  io.of(namespace).to(userRoom(userId)).emit(event, {
    event,
    namespace,
    profile: null,
    ts,
    seq,
    payload,
  });
  publishToTaps(io, { namespace, event, profile: null, ts, payload });
}
