// Realtime side of auth: every namespace accepts `auth.token` (the same bearer as HTTP); an
// authenticated socket joins `user:<id>` so user-level events (`pairing.claimed`,
// `device.linked`) reach only that person's clients. A socket without a token connects but
// joins no room; a socket with an invalid token is refused. `profiles: 'all'` in the handshake
// joins every profile room the person may enter (ADR 0016).
import type { Server as SocketServer, Socket } from 'socket.io';
import { HubError } from '../../lib/errors.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { profileRoom } from '../../lib/realtime.js';
import type { AuthContext } from './context.js';
import { resolvePrincipal, type Principal } from './principal.js';
import { listWorkspacesFor, resolveWorkspaceFor } from './workspace.js';

declare module 'socket.io' {
  interface SocketData {
    principal?: Principal;
  }
}

export const userRoom = (userId: string) => `user:${userId}`;

export function registerSocketAuth(io: SocketServer, ctx: () => AuthContext | null): void {
  for (const namespace of Object.values(REALTIME_NAMESPACES)) {
    io.of(namespace).use((socket: Socket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length === 0) return next();
      const context = ctx();
      if (!context) return next(new Error('unauthorized'));
      const ip = socket.handshake.address;
      const profile = socket.handshake.auth?.profile;
      resolvePrincipal(context, token, ip).then(
        (principal) => {
          socket.data.principal = principal;
          void socket.join(userRoom(principal.user.id));
          // Workspace-wide events (`/rt/jobs`, and the streaming namespaces) reach
          // `profile:<slug>`; the handshake names the workspace the same way
          // `X-Hub-Profile` does (packages/contracts/events/README.md §Connecting).
          if (typeof profile === 'string' && profile.length > 0) {
            try {
              const scope = resolveWorkspaceFor(context.db, principal.user, profile);
              void socket.join(profileRoom(scope.slug));
            } catch (error) {
              return next(new Error(error instanceof HubError ? error.code : 'profile_not_found'));
            }
          }
          // A list across profiles (ADR 0016) hears every profile it shows: `profiles: 'all'`
          // joins the room of each workspace this person may enter — the same rule as
          // `X-Hub-Profile` and `sessions.list?profiles=all`, decided here, not by the client.
          if (socket.handshake.auth?.profiles === 'all') {
            for (const row of listWorkspacesFor(context.db, principal.user)) {
              void socket.join(profileRoom(row.slug));
            }
          }
          next();
        },
        (error: unknown) => {
          next(new Error(error instanceof HubError ? error.code : 'unauthorized'));
        },
      );
    });
  }
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
  io.of(namespace)
    .to(userRoom(userId))
    .emit(event, {
      event,
      namespace,
      profile: null,
      ts: new Date(now).toISOString(),
      seq,
      payload,
    });
}
