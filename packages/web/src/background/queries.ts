/**
 * The Background panel's data (contract decision §49): `background.list` over every profile the
 * person may enter, read again when something changes — a run, a subagent, a workflow run or a
 * job — at most once a second, with a slow poll behind it for what no event reports.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { JOB_EVENTS, SUBAGENT_EVENTS } from '../realtime/envelope.js';
import type { BackgroundItem, BackgroundList } from '../types.js';

export const backgroundKeys = {
  list: (profile: string) => ['background', profile] as const,
};

/** With something running the list is read this often; otherwise only on events. */
const RUNNING_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;
/** Events come in bursts (a tool call a second); the list is read at most this often. */
const REFRESH_EVERY_MS = 1_000;

/** What on `/rt/sessions` means the list changed: a run, a conversation, a subagent. */
const SESSION_CHANGES = [
  'session.updated',
  'run.queued',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  ...SUBAGENT_EVENTS,
] as const;
const SCHEDULE_CHANGES = [
  'schedule_run.started',
  'schedule_run.completed',
  'schedule_run.failed',
  'workflow_run.started',
  'workflow_run.completed',
  'workflow_run.failed',
  'workflow_run.cancelled',
] as const;

export function useBackground() {
  const { client, profile, session } = useAuth();
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const key = backgroundKeys.list(profile);

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const data = (await client.request('get', '/background', { query: { profiles: 'all' } }))
        .data as unknown as Partial<BackgroundList>;
      return { running: data.running ?? [], finished: data.finished ?? [] } as BackgroundList;
    },
    enabled: !!session,
    retry: false,
    refetchInterval: (current) =>
      (current.state.data?.running.length ?? 0) > 0 ? RUNNING_POLL_MS : IDLE_POLL_MS,
  });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!session) return;
    const refresh = () => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void queryClient.invalidateQueries({ queryKey: ['background'] });
      }, REFRESH_EVERY_MS);
    };
    const sessions = realtime.socket('sessions');
    const schedules = realtime.socket('schedules');
    const jobs = realtime.socket('jobs');
    for (const name of SESSION_CHANGES) sessions.on(name, refresh);
    for (const name of SCHEDULE_CHANGES) schedules.on(name, refresh);
    for (const name of JOB_EVENTS) jobs.on(name, refresh);
    // Only a socket that is neither connected nor on its way: a second `connect()` while the
    // first is in flight sends the namespace's CONNECT twice, and the hub drops the connection.
    for (const socket of [sessions, schedules, jobs]) {
      if (!socket.connected && !socket.active) socket.connect();
    }
    return () => {
      for (const name of SESSION_CHANGES) sessions.off(name, refresh);
      for (const name of SCHEDULE_CHANGES) schedules.off(name, refresh);
      for (const name of JOB_EVENTS) jobs.off(name, refresh);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [session, realtime, realtime.epoch, queryClient]);

  const stop = useMutation({
    mutationFn: async (item: BackgroundItem) =>
      (
        await client.request('post', '/background/{item_id}/stop', {
          params: { item_id: item.id },
          // Stopped where it lives, whichever profile the top selector shows.
          headers: { 'X-Hub-Profile': item.profile },
        })
      ).data as unknown as BackgroundItem,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['background'] }),
  });

  return { query, stop, key };
}
