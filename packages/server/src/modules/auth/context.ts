// What every auth service needs: the database handle, the data directory (avatars, keys), the
// JWT signing key, the logger, and lazy access to the realtime server and hub identity.
import type { Server as SocketServer } from 'socket.io';
import type { ModuleDb } from '../../lib/db.js';
import type { FastifyBaseLogger } from 'fastify';

export interface AuthContext {
  db: ModuleDb;
  dataDir: string;
  /** HS256 key for access tokens, loaded from `<DATA_DIR>/keys/jwt.secret`. */
  key: Uint8Array;
  log: FastifyBaseLogger;
  /** Socket.IO server, available once the app is built. */
  io: () => SocketServer | null;
  version: string;
  contractVersion: string;
  /** Namespaces the server actually exposes (`/rt/…`). */
  namespaces: () => string[];
  /** Injectable clock so tests can move time (pairing expiry, lockouts). */
  now: () => number;
  /**
   * First run (ADR 0019): until when `POST /auth/setup` needs no claim token. Set at boot when
   * the hub has no owner — boot time + `COREHUB_SETUP_OPEN_MINUTES` — and `null` otherwise
   * (an owner exists, or the window is 0 = token only).
   */
  setupOpenUntil: number | null;
}
