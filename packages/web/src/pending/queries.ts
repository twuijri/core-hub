/**
 * The data behind the pending-actions bar and the global agent's page.
 *
 * Approvals are asked of every profile the person may enter (ADR 0016: what waits for a
 * person does not hide in the profile they are not looking at), one `sessions.listApprovals`
 * per profile, and refreshed by `approval.requested` / `approval.resolved` on the sessions
 * socket — which hears every profile — with a slow poll behind it for a missed event.
 * Senders waiting to pair are an admin's errand, read in the profile they are in only.
 */
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '../auth/context.js';
import { usePendingWrites } from '../agents/PendingWritesCard.js';
import { installedAgents } from '../chat/AgentChips.js';
import { useAgents, useProfiles } from '../hub/queries.js';
import { canOpen } from '../navigation/manifest.js';
import { useRealtime } from '../realtime/context.js';
import type { Approval, Session } from '../types.js';
import { mergePending, type PendingItem, type PendingPairing } from './pending.js';

export const pendingKeys = {
  approvals: (profile: string) => ['approvals', profile, 'pending'] as const,
  pairing: (profile: string, agentId: string) => ['agent-pairing', profile, agentId] as const,
  globalAgent: (profile: string) => ['global-agent', profile] as const,
};

/** A missed event is caught up with at this pace; the socket does the real work. */
const APPROVALS_POLL_MS = 60_000;
/** Pairing has no event: Hermes is asked again at this pace while the app is open. */
const PAIRING_POLL_MS = 60_000;

const inProfile = (profile: string) => ({ headers: { 'X-Hub-Profile': profile } });

export function usePendingActions(): {
  items: PendingItem[];
  isPending: boolean;
  /** The person's global-agent conversation in a profile, once this app has opened it. */
  globalAgentOf(profile: string): string | null;
} {
  const { client, profile, session, user } = useAuth();
  const queryClient = useQueryClient();
  const realtime = useRealtime();
  const profiles = useProfiles();
  const slugs = profiles.data?.length ? profiles.data.map((p) => p.slug) : [profile];

  const approvals = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: pendingKeys.approvals(slug),
      queryFn: async () =>
        (
          await client.request('get', '/approvals', {
            query: { status: 'pending', limit: 100 },
            ...inProfile(slug),
          })
        ).data as unknown as { items: Approval[] },
      enabled: !!session,
      refetchInterval: APPROVALS_POLL_MS,
      retry: false,
    })),
  });

  // Pairing belongs to an admin, and to an agent that has channels.
  const isAdmin = canOpen('agent_manager', user?.role ?? 'member');
  const agents = useAgents();
  const channelAgent = isAdmin
    ? installedAgents(agents.data ?? []).find((agent) =>
        (agent.capabilities ?? []).includes('channels'),
      )
    : undefined;
  const pairing = useQuery({
    queryKey: pendingKeys.pairing(profile, channelAgent?.id ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/pairing', {
          params: { agent_id: channelAgent?.id ?? '' },
        })
      ).data as unknown as { pending: PendingPairing[] },
    enabled: !!session && !!channelAgent,
    refetchInterval: PAIRING_POLL_MS,
    retry: false,
  });

  // Writes the agent staged for review (§58): an admin's, for Hermes, in the profile they are
  // in — shared with the list on the agent's settings page, so answering either updates both.
  const hermes = isAdmin
    ? installedAgents(agents.data ?? []).find((agent) => agent.kind === 'hermes')
    : undefined;
  const writes = usePendingWrites(hermes?.id ?? '', !!hermes);

  useEffect(() => {
    if (!session) return;
    const socket = realtime.socket('sessions');
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    socket.on('approval.requested', refresh);
    socket.on('approval.resolved', refresh);
    if (!socket.connected) socket.connect();
    return () => {
      socket.off('approval.requested', refresh);
      socket.off('approval.resolved', refresh);
    };
  }, [session, realtime, realtime.epoch, queryClient]);

  const items = mergePending(
    slugs.map((slug, i) => ({ profile: slug, items: approvals[i]?.data?.items ?? [] })),
    channelAgent && pairing.data
      ? [{ profile, agentId: channelAgent.id, items: pairing.data.pending ?? [] }]
      : [],
    hermes && writes.data ? [{ profile, agentId: hermes.id, items: writes.data.items ?? [] }] : [],
  );
  return {
    items,
    isPending: approvals.some((q) => q.isPending),
    globalAgentOf: (slug) =>
      queryClient.getQueryData<Session>(pendingKeys.globalAgent(slug))?.id ?? null,
  };
}
