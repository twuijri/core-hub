/**
 * Linked hubs (ADR 0026): other Core Hubs linked to this one, the agents this hub shares with
 * them, and asking one of theirs a question. Admin-only and global (`x-scope: global`), so the
 * keys do not carry the profile.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HubApiError, type components } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import type { Translator } from '../i18n/index.js';

export type Peer = components['schemas']['Peer'];
export type PeerShare = components['schemas']['PeerShare'];
export type PeerAgent = components['schemas']['PeerAgent'];
export type PeerEvent = components['schemas']['PeerEvent'];
export type PeerInvite = components['schemas']['PeerInvite'];

export const peerKeys = {
  list: ['peers'] as const,
  shares: ['peer-shares'] as const,
  agents: (id: string) => ['peer-agents', id] as const,
  events: (id: string) => ['peer-events', id] as const,
};

export function usePeers() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: peerKeys.list,
    queryFn: async () => (await client.request('get', '/peers')).data.items,
    enabled: !!session,
  });
}

export function usePeerShares() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: peerKeys.shares,
    queryFn: async () => (await client.request('get', '/peer-shares')).data.items,
    enabled: !!session,
  });
}

export function usePeerAgents(peerId: string, enabled: boolean) {
  const { client } = useAuth();
  return useQuery({
    queryKey: peerKeys.agents(peerId),
    queryFn: async () =>
      (await client.request('get', '/peers/{peer_id}/agents', { params: { peer_id: peerId } })).data
        .items,
    enabled,
    retry: false,
  });
}

export function usePeerEvents(peerId: string, enabled: boolean) {
  const { client } = useAuth();
  return useQuery({
    queryKey: peerKeys.events(peerId),
    queryFn: async () =>
      (await client.request('get', '/peers/{peer_id}/events', { params: { peer_id: peerId } })).data
        .items,
    enabled,
  });
}

function useRefreshPeers() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: peerKeys.list });
}

export function useCreatePeerInvite() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async () => (await client.request('post', '/peer-invites')).data,
  });
}

export function useRequestPeer() {
  const { client } = useAuth();
  const refresh = useRefreshPeers();
  return useMutation({
    mutationFn: async (input: { url: string; name?: string }) =>
      (await client.request('post', '/peers', { body: input })).data,
    onSuccess: refresh,
  });
}

export function useUpdatePeer() {
  const { client } = useAuth();
  const refresh = useRefreshPeers();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      patch: { name?: string; enabled?: boolean; approve?: true; asks_per_hour?: number };
    }) =>
      (
        await client.request('patch', '/peers/{peer_id}', {
          params: { peer_id: input.id },
          body: input.patch,
        })
      ).data,
    onSuccess: refresh,
  });
}

export function useDeletePeer() {
  const { client } = useAuth();
  const refresh = useRefreshPeers();
  return useMutation({
    mutationFn: async (id: string) =>
      (await client.request('delete', '/peers/{peer_id}', { params: { peer_id: id } })).data,
    onSuccess: refresh,
  });
}

export function useSetPeerShare() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { profile: string; agent_id: string; shared: boolean }) =>
      (await client.request('put', '/peer-shares', { body: input })).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: peerKeys.shares }),
  });
}

export function useAskPeerAgent() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (input: { peerId: string; shareId: string; prompt: string }) =>
      (
        await client.request('post', '/peers/{peer_id}/agents/{share_id}/ask', {
          params: { peer_id: input.peerId, share_id: input.shareId },
          body: { prompt: input.prompt },
        })
      ).data,
  });
}

/**
 * A refusal in the page's own words when the hub names a reason this page knows (the peer's
 * own reason first, then the hub's), the hub's sentence otherwise.
 */
export function describePeerError(error: unknown, t: Translator): string {
  if (error instanceof HubApiError) {
    const details = (error.body as { details?: { reason?: unknown; peer_code?: unknown } } | null)
      ?.details;
    for (const reason of [details?.peer_code, details?.reason]) {
      if (typeof reason !== 'string') continue;
      const key = `linked_hubs.reason.${reason}`;
      const text = t(key);
      if (text !== key) return text;
    }
    if (error.status === 429) return t('linked_hubs.reason.rate_limited');
  }
  return describeError(error, t);
}
