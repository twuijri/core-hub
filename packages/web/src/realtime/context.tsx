// One socket per namespace for the whole app, created lazily and rebuilt when the signed-in
// person or the workspace changes. The sessions socket's state feeds the footer's connection dot,
// so the provider itself keeps that one open for as long as someone is signed in.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Socket } from 'socket.io-client';
import { useAuth } from '../auth/context.js';
import { NAMESPACES, connectNamespace, type NamespaceName } from './socket.js';

export type ConnectionState = 'connected' | 'connecting' | 'offline';

interface RealtimeValue {
  socket(name: NamespaceName): Socket;
  state: ConnectionState;
  /**
   * Counts the times every socket was dropped. A hook that keeps a socket in an effect lists
   * this among the effect's dependencies, so it takes the new socket instead of holding the
   * closed one.
   */
  epoch: number;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { baseUrl, session, profile, refresh } = useAuth();
  const token = session?.token;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  /** The token a refresh was already asked for, so a refusal cannot loop. */
  const refreshedFor = useRef<string | undefined>(undefined);
  const profileRef = useRef(profile);
  const [state, setState] = useState<ConnectionState>('offline');
  const [epoch, setEpoch] = useState(0);
  const sockets = useRef(new Map<NamespaceName, Socket>());
  const userId = session?.user.id;

  // A new person or workspace means new rooms on the hub: drop every socket and start over.
  // Only a *change* does. On the first render there is nothing to drop — and a page opened
  // straight from the address bar (a reload of a conversation) has already asked for its
  // socket in its own effect, which React runs before this one: tearing that socket down
  // left the page holding a closed one and the footer saying "Offline" until another
  // conversation was opened (owner, 2026-09-23).
  const identity = useRef({ userId, profile });
  useEffect(() => {
    profileRef.current = profile;
    if (identity.current.userId === userId && identity.current.profile === profile) return;
    identity.current = { userId, profile };
    const current = sockets.current;
    for (const socket of current.values()) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    current.clear();
    setState('offline');
    setEpoch((n) => n + 1);
  }, [userId, profile]);

  useEffect(
    () => () => {
      for (const socket of sockets.current.values()) socket.disconnect();
    },
    [],
  );

  // Lets the effect below reach `socket()` without re-running on every change of `state`.
  const valueRef = useRef<RealtimeValue | null>(null);

  const value = useMemo<RealtimeValue>(
    () => ({
      state,
      epoch,
      socket(name) {
        const existing = sockets.current.get(name);
        if (existing) return existing;
        const socket = connectNamespace({
          baseUrl,
          namespace: NAMESPACES[name],
          token: () => tokenRef.current,
          profile: () => profileRef.current,
          // The sessions socket hears every profile the lists gather (ADR 0016); the
          // others stay with the profile the person is in.
          ...(name === 'sessions' ? { profiles: 'all' as const } : {}),
          // The hub refuses a handshake whose token expired (every namespace needs a valid
          // one). A newer token may be here already — the HTTP client refreshes on its
          // own — then just come back; otherwise ask for one, once per token: the effect
          // below reconnects when it arrives, and a refused refresh signs out.
          onAuthRefused(refused, used) {
            if (used !== tokenRef.current) return void refused.connect();
            if (!used || refreshedFor.current === used) return;
            refreshedFor.current = used;
            void refreshRef.current();
          },
        });
        if (name === 'sessions') {
          setState('connecting');
          socket.on('connect', () => setState('connected'));
          socket.on('disconnect', () => setState('offline'));
          // A hub that cannot be reached never "disconnects" — it was never connected. Without
          // this the footer would say "Connecting" for as long as the hub is down.
          socket.on('connect_error', () => setState('offline'));
          socket.io.on('reconnect_attempt', () => setState('connecting'));
        }
        sockets.current.set(name, socket);
        return socket;
      },
    }),
    [baseUrl, state, epoch],
  );
  valueRef.current = value;

  // The footer reports the sessions socket, and the footer is on every page — but until now
  // only the conversation list and an open conversation asked for that socket. Inside Settings
  // the sidebar is the settings list, so a reload there left nothing asking: no socket, and the
  // footer showing its first value, "Offline", for good (owner, 2026-09-23: «اذا دخلت الاعدادات
  // وحدثت الصفحة يعطيني اوفلاين»). The provider opens it itself, on every page, and again after
  // every drop (`epoch`). `socket()` hands back the one a page already opened, if any.
  useEffect(() => {
    if (!userId) return;
    valueRef.current?.socket('sessions');
  }, [userId, epoch]);

  // A new access token brings back every socket the hub refused with the old one. A socket
  // that is connected, or still retrying on its own (`active`), picks the token up by itself.
  useEffect(() => {
    if (!token) return;
    for (const socket of sockets.current.values()) {
      if (!socket.connected && !socket.active) socket.connect();
    }
  }, [token]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime outside RealtimeProvider');
  return value;
}
