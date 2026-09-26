/**
 * An agent's incoming webhook routes (contract `agents.*Webhook*`, decision §97): the list, making
 * one, deleting one, and the local test. Plus the small rules the section draws from.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import type { Schemas } from '../types.js';

export type HermesWebhook = Schemas['HermesWebhook'];
export type HermesWebhookList = Schemas['HermesWebhookList'];
export type HermesWebhookCreate = Schemas['HermesWebhookCreate'];
export type HermesWebhookTestResult = Schemas['HermesWebhookTestResult'];

/** Hermes's rule for a route's name. */
export const WEBHOOK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const webhookKeys = {
  list: (profile: string, agentId: string) => ['agent-webhooks', profile, agentId] as const,
};

export function useWebhooks(agentId: string | undefined, enabled = true) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: webhookKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/webhooks', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as HermesWebhookList,
    enabled: !!session && !!agentId && enabled,
    // A listener switched on a moment ago is starting with its gateway: read again until it says.
    refetchInterval: (query) => {
      const data = query.state.data as HermesWebhookList | undefined;
      return data?.listener?.enabled && data.listener.status === 'unknown' ? 3000 : false;
    },
  });
}

export function useCreateWebhook(agentId: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: HermesWebhookCreate) =>
      (
        await client.request('post', '/agents/{agent_id}/webhooks', {
          params: { agent_id: agentId },
          body,
        })
      ).data as HermesWebhook,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: webhookKeys.list(profile, agentId) });
      void queryClient.invalidateQueries({ queryKey: ['agent-channels', profile, agentId] });
    },
  });
}

export function useDeleteWebhook(agentId: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      await client.request('delete', '/agents/{agent_id}/webhooks/{route_name}', {
        params: { agent_id: agentId, route_name: name },
      });
      return name;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: webhookKeys.list(profile, agentId) });
      void queryClient.invalidateQueries({ queryKey: ['agent-channels', profile, agentId] });
    },
  });
}

export function useTestWebhook(agentId: string) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (name: string) =>
      (
        await client.request('post', '/agents/{agent_id}/webhooks/{route_name}/test', {
          params: { agent_id: agentId, route_name: name },
        })
      ).data as HermesWebhookTestResult,
  });
}

/** The route's full address: the hub's origin as this page reached it, then the route's path. */
export function webhookUrl(origin: string, route: Pick<HermesWebhook, 'path'>): string {
  return `${origin.replace(/\/+$/, '')}${route.path}`;
}

/**
 * Whether the hub's address, as this page reached it, is one an outside service cannot reach:
 * this machine, a private network, or a `.local` / `.lan` / `.internal` name. A public name may
 * still be closed to the internet — the section says so either way.
 */
export function isPrivateOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return true;
  }
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) return /^(fc|fd|fe80)/.test(host);
  if (!host.includes('.')) return true;
  return /\.(local|lan|internal|home|test|localdomain)$/.test(host);
}

/** `issues, push` → `['issues', 'push']`. */
export function eventsOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,،\s]+/)
        .map((event) => event.trim())
        .filter(Boolean),
    ),
  ];
}
