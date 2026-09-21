// Opens one session: HTTP for the base document (`sessions.get` + `sessions.listMessages`),
// `/rt/sessions` for everything after, `after_seq` on every reconnect, and the documented
// resync when the hub says the replay was truncated (events/README.md §Resuming).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { SESSION_EVENTS, isEnvelope, type Envelope } from '../realtime/envelope.js';
import { subscribeSession, unsubscribeSession } from '../realtime/socket.js';
import { hydrate, initialChat, reduce, type ChatState } from './transcript.js';

export type StreamStatus = 'loading' | 'ready' | 'error';

export interface StreamInfo {
  state: ChatState;
  status: StreamStatus;
  error: unknown;
  /** Set after a reconnect: how many envelopes the hub replayed, or that it resynced. */
  lastResume: { replayed: number; truncated: boolean } | null;
  reload(): void;
}

export function useSessionStream(sessionId: string | undefined): StreamInfo {
  const { client, profile } = useAuth();
  const realtime = useRealtime();
  const [state, setState] = useState<ChatState>(initialChat);
  const [status, setStatus] = useState<StreamStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  const [lastResume, setLastResume] = useState<StreamInfo['lastResume']>(null);
  const [generation, setGeneration] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let hydrated = false;
    const buffer: Envelope[] = [];
    setState(initialChat());
    setStatus('loading');
    setError(null);
    setLastResume(null);
    const socket = realtime.socket('sessions');

    const apply = (envelope: Envelope) => {
      setState((current) => {
        const next = reduce(current, envelope, sessionId);
        stateRef.current = next;
        return next;
      });
    };
    const onEnvelope = (raw: unknown) => {
      if (disposed || !isEnvelope(raw)) return;
      if (!hydrated) buffer.push(raw);
      else apply(raw);
    };

    const fetchBase = async () => {
      const [detail, page] = await Promise.all([
        client.request('get', '/sessions/{session_id}', { params: { session_id: sessionId } }),
        client.request('get', '/sessions/{session_id}/messages', {
          params: { session_id: sessionId },
          query: { limit: 100 },
        }),
      ]);
      return { detail: detail.data, messages: page.data.items };
    };

    const resync = async () => {
      const { detail, messages } = await fetchBase();
      if (disposed) return;
      setState((current) => {
        const next = hydrate(current, detail, messages);
        stateRef.current = next;
        return next;
      });
    };

    // The first successful subscribe is the fresh one; every later `connect` is a resume.
    let subscribedOnce = false;
    const subscribe = async () => {
      const initial = !subscribedOnce;
      const afterSeq = initial ? 0 : stateRef.current.lastSeq;
      const ack = await subscribeSession(socket, sessionId, afterSeq);
      if (disposed) return;
      if (!ack.ok) throw new Error(`${ack.code ?? 'subscribe_failed'}: ${ack.error ?? ''}`);
      subscribedOnce = true;
      if (!initial) {
        setLastResume({ replayed: ack.replayed ?? 0, truncated: ack.truncated === true });
        if (ack.truncated && afterSeq > 0) await resync();
      }
    };

    const onConnect = () => {
      subscribe().catch((err: unknown) => {
        if (!disposed) setError(err);
      });
    };

    for (const name of SESSION_EVENTS) socket.on(name, onEnvelope);
    socket.on('connect', onConnect);

    (async () => {
      try {
        if (socket.connected) await subscribe();
        else socket.connect();
        const { detail, messages } = await fetchBase();
        if (disposed) return;
        setState((current) => {
          let next = hydrate(current, detail, messages);
          for (const envelope of buffer) next = reduce(next, envelope, sessionId);
          buffer.length = 0;
          stateRef.current = next;
          return next;
        });
        hydrated = true;
        setStatus('ready');
      } catch (err) {
        if (!disposed) {
          setError(err);
          setStatus('error');
        }
      }
    })();

    return () => {
      disposed = true;
      for (const name of SESSION_EVENTS) socket.off(name, onEnvelope);
      socket.off('connect', onConnect);
      if (socket.connected) unsubscribeSession(socket, sessionId);
    };
    // `realtime` changes identity with the connection state; the socket object itself is stable.
  }, [sessionId, profile, client, generation]);

  return { state, status, error, lastResume, reload };
}
