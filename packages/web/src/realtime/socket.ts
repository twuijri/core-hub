// Socket.IO namespaces under the `/rt` engine path (ARCHITECTURE §Realtime). The handshake
// carries the same bearer as HTTP and the workspace slug; `auth` is a function so a refreshed
// token is used on the next reconnect attempt without rebuilding the socket.
import { io, type Socket } from 'socket.io-client';

export const SOCKET_PATH = '/rt';
export const NAMESPACES = {
  sessions: '/rt/sessions',
  devices: '/rt/devices',
  jobs: '/rt/jobs',
  tasks: '/rt/tasks',
  schedules: '/rt/schedules',
  // The owner's web terminal (DECISIONS §70); the hub refuses everyone else's handshake.
  terminal: '/rt/terminal',
} as const;
export type NamespaceName = keyof typeof NAMESPACES;

export interface ConnectOptions {
  baseUrl: string;
  namespace: (typeof NAMESPACES)[NamespaceName];
  token: () => string | undefined;
  profile: () => string | undefined;
  /**
   * `all` also hears every other profile the person may enter (ADR 0016): the chats list,
   * the Tasks board and the Schedules page gather them, and a conversation opened from
   * another profile gets its approvals.
   */
  profiles?: 'all';
  /**
   * The hub refused the handshake's token (`unauthorized`, `token_expired`). socket.io does
   * not retry a refused handshake on its own; the caller gets a fresh token and reconnects.
   * `used` is the token the refused handshake carried.
   */
  onAuthRefused?: (socket: Socket, used: string | undefined) => void;
}

/** Handshake refusals that a new access token can cure (`modules/auth/sockets.ts`). */
const TOKEN_REFUSALS = new Set(['unauthorized', 'token_expired']);

/** Reconnects with backoff capped at 30 s, as events/README.md §Reconnection asks. */
export function connectNamespace(options: ConnectOptions): Socket {
  let used: string | undefined;
  const socket = io(`${options.baseUrl}${options.namespace}`, {
    path: SOCKET_PATH,
    transports: ['websocket', 'polling'],
    auth: (cb) => {
      const token = options.token();
      const profile = options.profile();
      used = token;
      cb({
        ...(token ? { token } : {}),
        ...(profile ? { profile } : {}),
        ...(options.profiles ? { profiles: options.profiles } : {}),
      });
    },
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    timeout: 10_000,
  });
  // A drop the hub initiated (restart, kicked socket) is not retried by socket.io-client on
  // its own; the session is still ours, so come back like after any other drop.
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1_000);
  });
  socket.on('connect_error', (error: Error) => {
    if (!socket.active && TOKEN_REFUSALS.has(error.message)) options.onAuthRefused?.(socket, used);
  });
  return socket;
}

export interface SubscribeAck {
  ok: boolean;
  replayed?: number;
  truncated?: boolean;
  error?: string;
  code?: string;
}

export function subscribeSession(
  socket: Socket,
  sessionId: string,
  afterSeq: number,
  timeoutMs = 10_000,
): Promise<SubscribeAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe timed out')), timeoutMs);
    socket.emit(
      'subscribe',
      afterSeq > 0 ? { session_id: sessionId, after_seq: afterSeq } : { session_id: sessionId },
      (ack: SubscribeAck) => {
        clearTimeout(timer);
        resolve(ack);
      },
    );
  });
}

export function unsubscribeSession(socket: Socket, sessionId: string): void {
  socket.emit('unsubscribe', { session_id: sessionId }, () => undefined);
}
