// One socket per namespace for the whole app, created lazily and rebuilt when the signed-in
// person or the workspace changes. The sessions socket's state feeds the footer's connection dot.
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
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { baseUrl, session, profile } = useAuth();
  const token = session?.token;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const profileRef = useRef(profile);
  const [state, setState] = useState<ConnectionState>('offline');
  const sockets = useRef(new Map<NamespaceName, Socket>());
  const userId = session?.user.id;

  // A new person or workspace means new rooms on the hub: drop every socket and start over.
  useEffect(() => {
    profileRef.current = profile;
    const current = sockets.current;
    for (const socket of current.values()) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    current.clear();
    setState('offline');
  }, [userId, profile]);

  useEffect(
    () => () => {
      for (const socket of sockets.current.values()) socket.disconnect();
    },
    [],
  );

  const value = useMemo<RealtimeValue>(
    () => ({
      state,
      socket(name) {
        const existing = sockets.current.get(name);
        if (existing) return existing;
        const socket = connectNamespace({
          baseUrl,
          namespace: NAMESPACES[name],
          token: () => tokenRef.current,
          profile: () => profileRef.current,
        });
        if (name === 'sessions') {
          setState('connecting');
          socket.on('connect', () => setState('connected'));
          socket.on('disconnect', () => setState('offline'));
          socket.io.on('reconnect_attempt', () => setState('connecting'));
        }
        sockets.current.set(name, socket);
        return socket;
      },
    }),
    [baseUrl, state],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime outside RealtimeProvider');
  return value;
}
