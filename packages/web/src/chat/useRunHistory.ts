/**
 * The session's finished runs, for what a turn says about itself after a reload — which model
 * answered it and what that model took over from (contract decision §54). The session's own
 * detail carries only its live runs; the history is one page of `sessions.listRuns`, read once
 * per conversation. Live runs, which the socket keeps current, win over the page.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import type { Run } from '../types.js';

/** The most recent runs a conversation shows notes for; older turns show none. */
export const RUN_HISTORY_LIMIT = 100;

export function useRunHistory(sessionId: string, live: Record<string, Run>): Record<string, Run> {
  const { client, profile, session } = useAuth();
  const history = useQuery({
    // Not under `['sessions']`: the session list updates every query of that prefix as a
    // page of sessions, and would rewrite this list of runs as one.
    queryKey: ['run-history', profile, sessionId] as const,
    enabled: !!session,
    queryFn: async () =>
      (
        await client.request('get', '/sessions/{session_id}/runs', {
          params: { session_id: sessionId },
          query: { limit: RUN_HISTORY_LIMIT },
        })
      ).data.items as Run[],
  });
  return useMemo(() => {
    const known: Record<string, Run> = {};
    for (const run of history.data ?? []) known[run.id] = run;
    return { ...known, ...live };
  }, [history.data, live]);
}
