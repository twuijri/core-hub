/**
 * The Trajectory tab's data: `sessions.getTrajectory`, read while the tab is open and read
 * again whenever the live transcript changes (`revisionOf` in trajectory.ts) — at most once
 * a second, so a streaming reply does not turn into a request per word.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../auth/context.js';
import type { Trajectory } from './trajectory.js';

/** The least time between two reads while a run streams. */
export const REFRESH_MS = 1000;

export function useTrajectory(sessionId: string, enabled: boolean, revision: string) {
  const { client, profile } = useAuth();
  const query = useQuery({
    queryKey: ['trajectory', profile, sessionId] as const,
    queryFn: async () =>
      (
        await client.request('get', '/sessions/{session_id}/trajectory', {
          params: { session_id: sessionId },
        })
      ).data as Trajectory,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

  // Follow the transcript: a changed revision asks again, no sooner than REFRESH_MS after
  // the last answer.
  const { refetch, dataUpdatedAt } = query;
  const seen = useRef(revision);
  useEffect(() => {
    if (!enabled || seen.current === revision) return;
    const wait = Math.max(0, dataUpdatedAt + REFRESH_MS - Date.now());
    const timer = setTimeout(() => {
      seen.current = revision;
      void refetch();
    }, wait);
    return () => clearTimeout(timer);
  }, [enabled, revision, dataUpdatedAt, refetch]);

  return query;
}

/** Save the session log: the same document, sent by the hub as a file. */
export function useDownloadTrajectory(sessionId: string) {
  const { client } = useAuth();
  return useCallback(async () => {
    const res = await client.request('get', '/sessions/{session_id}/trajectory', {
      params: { session_id: sessionId },
      query: { download: true },
    });
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `session-${sessionId}-log.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  }, [client, sessionId]);
}
