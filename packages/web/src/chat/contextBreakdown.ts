/**
 * The window by category for the context meter (decision §102), read only while its details
 * are open, and again when the window changes (`revision`: the count the ring shows).
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import type { ContextBreakdown } from './ContextRing.js';

export function useContextBreakdown(sessionId: string | null, open: boolean, revision: number) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['context-breakdown', profile, sessionId ?? '', revision],
    queryFn: async () =>
      (
        await client.request('get', '/sessions/{session_id}/context', {
          params: { session_id: sessionId ?? '' },
        })
      ).data as ContextBreakdown,
    enabled: !!session && !!sessionId && open,
    retry: false,
    staleTime: 10_000,
  });
}
