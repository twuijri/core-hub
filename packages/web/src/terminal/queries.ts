/**
 * The owner's web terminal (DECISIONS §60), as the hub reports it.
 *
 * The hub decides who may use it; the web only mirrors the answer. `GET /terminal` answers
 * `200` to the owner of a hub started with `COREHUB_WEB_TERMINAL=1`, and `403` to anyone else
 * — so the entry is shown on a `200` and nowhere else, and it is not even asked for someone
 * who is not the owner.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';

export interface TerminalSessionInfo {
  id: string;
  profile: string;
  cwd: string;
  cols: number;
  rows: number;
  attached: boolean;
  started_at: string;
  last_active_at: string;
}

export interface TerminalStatus {
  enabled: boolean;
  pty: boolean;
  shell: string;
  idle_timeout_seconds: number;
  max_sessions: number;
  sessions: TerminalSessionInfo[];
}

export type ExitReason = 'exited' | 'closed' | 'idle' | 'shutdown';

export const terminalKeys = { status: () => ['terminal-status'] as const };

export function useTerminalStatus(options: { fresh?: boolean } = {}) {
  const { client, session, user } = useAuth();
  return useQuery({
    queryKey: terminalKeys.status(),
    queryFn: async () =>
      (await client.request('get', '/terminal')).data as unknown as TerminalStatus,
    enabled: !!session && user?.role === 'owner',
    // A 403 is an answer ("not for you", "not on"), not a hiccup to retry.
    retry: false,
    staleTime: options.fresh ? 0 : 60_000,
    ...(options.fresh ? { refetchOnMount: 'always' as const } : {}),
  });
}

/** Whether to show the Terminal entry: only on the hub's `200`. */
export function useTerminalAvailable(): boolean {
  const status = useTerminalStatus();
  return status.isSuccess && status.data.enabled;
}
