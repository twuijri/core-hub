/**
 * The Schedules and Workflows pages follow `/rt/schedules`, which hears every profile the
 * person may enter (`profiles: 'all'`, realtime/context.tsx): a schedule made, changed or
 * fired anywhere — another tab, Hermes — redraws it, and so does a workflow run however it
 * started (the Run button, a schedule, a trigger's delivery).
 *
 * It lived inside `SchedulesScreen` while Workflows was one of its tabs; the Workflows page
 * got its own address on 2026-09-28 (DECISIONS §126) without it, so a run a trigger started
 * showed there only after a reload (owner, 2026-09-29).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRealtime } from '../realtime/context.js';
import { SCHEDULE_EVENTS, isEnvelope } from '../realtime/envelope.js';

export function useScheduleEvents(): void {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = realtime.socket('schedules');
    const handler = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    };
    // What happened while the socket was away is not replayed on this namespace: a
    // (re)connection asks again.
    const reconnected = () => void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    for (const name of SCHEDULE_EVENTS) socket.on(name, handler);
    socket.on('connect', reconnected);
    // Only a socket neither connected nor on its way: a second `connect()` while the first is
    // in flight sends the namespace's CONNECT twice (background/queries.ts).
    if (!socket.connected && !socket.active) socket.connect();
    return () => {
      for (const name of SCHEDULE_EVENTS) socket.off(name, handler);
      socket.off('connect', reconnected);
    };
  }, [queryClient, realtime.epoch]);
}
