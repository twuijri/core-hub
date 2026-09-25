/**
 * A conversation's subagents over the wire (contract decision §47): `sessions.listSubagents`
 * once, then every `subagent.*` event of that conversation folded in as it arrives — the events
 * are profile-wide, so no subscription is needed, and each carries the whole subagent. Stop,
 * steer and the output's tail are the conversation's own operations.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { SUBAGENT_EVENTS, isEnvelope } from '../realtime/envelope.js';
import type { Subagent, SubagentList } from '../types.js';
import { upsertSubagent } from './subagents.js';

export const subagentKeys = {
  list: (profile: string, sessionId: string) => ['subagents', profile, sessionId] as const,
  tail: (profile: string, sessionId: string, id: string) =>
    ['subagent-tail', profile, sessionId, id] as const,
};

/** A missed event is caught up with at this pace while one is running. */
const RUNNING_POLL_MS = 15_000;

export function useSubagents(sessionId: string) {
  const { client, profile, session } = useAuth();
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const key = subagentKeys.list(profile, sessionId);

  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await client.request('get', '/sessions/{session_id}/subagents', {
          params: { session_id: sessionId },
        })
      ).data as unknown as SubagentList,
    enabled: !!session,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.items.some((item) => item.status === 'running') ? RUNNING_POLL_MS : false,
  });

  useEffect(() => {
    if (!session) return;
    const socket = realtime.socket('sessions');
    const onEvent = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      const subagent = (raw.payload as { subagent?: Subagent }).subagent;
      if (!subagent || subagent.session_id !== sessionId) return;
      queryClient.setQueryData<SubagentList>(key, (current) =>
        current
          ? { ...current, items: upsertSubagent(current.items, subagent) }
          : // The list was not read yet: the event says there is something to read.
            current,
      );
      if (!queryClient.getQueryData(key)) void queryClient.invalidateQueries({ queryKey: key });
    };
    for (const name of SUBAGENT_EVENTS) socket.on(name, onEvent);
    if (!socket.connected && !socket.active) socket.connect();
    return () => {
      for (const name of SUBAGENT_EVENTS) socket.off(name, onEvent);
    };
    // `key` is derived from `profile` and `sessionId`, both listed.
  }, [session, realtime, realtime.epoch, queryClient, profile, sessionId]);

  const settle = (subagent?: Subagent) => {
    if (subagent) {
      queryClient.setQueryData<SubagentList>(key, (current) =>
        current ? { ...current, items: upsertSubagent(current.items, subagent) } : current,
      );
    }
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const stop = useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('post', '/sessions/{session_id}/subagents/{subagent_id}/interrupt', {
          params: { session_id: sessionId, subagent_id: id },
        })
      ).data as unknown as Subagent,
    onSuccess: (subagent) => settle(subagent),
    onError: () => settle(),
  });

  const steer = useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) =>
      (
        await client.request('post', '/sessions/{session_id}/subagents/{subagent_id}/steer', {
          params: { session_id: sessionId, subagent_id: id },
          body: { text },
        })
      ).data as unknown as { status: 'queued' | 'rejected' },
  });

  return { query, stop, steer };
}

/** How often the live output is read again while its sheet is open and it is running. */
const TAIL_POLL_MS = 2_000;

export function useSubagentTail(sessionId: string, id: string | null, running: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: subagentKeys.tail(profile, sessionId, id ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/sessions/{session_id}/subagents/{subagent_id}/tail', {
          params: { session_id: sessionId, subagent_id: id ?? '' },
        })
      ).data as unknown as { available: boolean; text: string; truncated: boolean },
    enabled: !!session && !!id,
    retry: false,
    refetchInterval: running ? TAIL_POLL_MS : false,
  });
}
