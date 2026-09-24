/**
 * An agent's plugins and its scheduled jobs, in the selected profile.
 *
 * Plugins are what Hermes itself lists for the profile (`agents.listPlugins`, Hermes's own
 * `hermes plugins` command): every change is Hermes's, so the list is read again from Hermes
 * after it rather than patched here.
 *
 * Jobs are the agent's schedules — for Hermes, the jobs in Hermes's own scheduler — read from
 * the same list the Schedules page reads (`schedules.list`), narrowed to this agent and this
 * profile. Creating and editing stay on the Schedules page; this page runs, pauses and deletes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { SCHEDULE_EVENTS, isEnvelope } from '../realtime/envelope.js';

export interface AgentPlugin {
  key: string;
  name: string;
  kind: 'standalone' | 'bundled' | 'preset';
  source: 'bundled' | 'user' | 'external';
  status: 'enabled' | 'disabled' | 'not_enabled';
  version: string | null;
  description: string | null;
  enabled: boolean;
  manageable: boolean;
  removable: boolean;
}

export const pluginKeys = {
  list: (profile: string, agentId: string) => ['agent-plugins', profile, agentId] as const,
};

export function usePlugins(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: pluginKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/plugins', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { items: AgentPlugin[]; warnings: string[] },
    enabled: !!session && !!agentId,
  });
}

export function useRefreshPlugins(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () =>
    void queryClient.invalidateQueries({ queryKey: pluginKeys.list(profile, agentId ?? '') });
}

export function useSetPlugin(agentId: string | undefined) {
  const { client } = useAuth();
  const refresh = useRefreshPlugins(agentId);
  return useMutation({
    mutationFn: async (input: { key: string; enabled: boolean }) =>
      (
        await client.request('patch', '/agents/{agent_id}/plugins/{plugin_key}', {
          params: { agent_id: agentId ?? '', plugin_key: input.key },
          body: { enabled: input.enabled },
        })
      ).data as unknown as AgentPlugin,
    onSettled: refresh,
  });
}

export function useRemovePlugin(agentId: string | undefined) {
  const { client } = useAuth();
  const refresh = useRefreshPlugins(agentId);
  return useMutation({
    mutationFn: async (key: string) => {
      await client.request('delete', '/agents/{agent_id}/plugins/{plugin_key}', {
        params: { agent_id: agentId ?? '', plugin_key: key },
      });
      return key;
    },
    onSettled: refresh,
  });
}

export function useInstallPlugin(agentId: string | undefined) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (identifier: string) =>
      (
        await client.request('post', '/agents/{agent_id}/plugins', {
          params: { agent_id: agentId ?? '' },
          body: { identifier },
        })
      ).data as { job_id: string },
  });
}

// ------------------------------------------------------------------- jobs

export interface AgentJob {
  id: string;
  profile: string;
  name: string;
  enabled: boolean;
  state: 'scheduled' | 'running' | 'paused' | 'exhausted';
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  trigger: {
    kind: 'cron' | 'interval' | 'once';
    expression: string | null;
    every_minutes: number | null;
    run_at: string | null;
    timezone: string;
    display?: string | null;
  };
  target: { prompt: string | null };
  /** Set when the job lives in the agent's own scheduler (Hermes's cron). */
  external?: { source: 'hermes'; id: string } | null;
}

export const jobKeys = {
  // Under `schedules`, so whatever refreshes the Schedules page refreshes this one too.
  list: (profile: string, agentId: string) => ['schedules', 'agent', profile, agentId] as const,
};

export function useAgentJobs(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: jobKeys.list(profile, agentId ?? ''),
    queryFn: async () => {
      // One profile, one agent: small enough for one page; the hub pages it anyway.
      const items: AgentJob[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const { data } = await client.request('get', '/schedules', {
          query: {
            profile,
            agent_id: agentId ?? '',
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
        });
        const body = data as unknown as { items: AgentJob[]; next_cursor: string | null };
        items.push(...body.items);
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      return { items };
    },
    enabled: !!session && !!agentId,
  });
}

/** `/rt/schedules`: a job changed or fired anywhere — Hermes, another tab — redraws the page. */
export function useAgentJobEvents(): void {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = realtime.socket('schedules');
    const handler = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    };
    for (const name of SCHEDULE_EVENTS) socket.on(name, handler);
    if (!socket.connected) socket.connect();
    return () => {
      for (const name of SCHEDULE_EVENTS) socket.off(name, handler);
    };
  }, [queryClient, realtime.epoch]);
}

export function useAgentJobWrite() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['schedules'] });
  const inProfile = (job: AgentJob) => ({ headers: { 'X-Hub-Profile': job.profile } });
  return {
    pause: useMutation({
      mutationFn: async ({ job, enabled }: { job: AgentJob; enabled: boolean }) =>
        (
          await client.request('patch', '/schedules/{schedule_id}', {
            params: { schedule_id: job.id },
            body: { enabled } as never,
            ...inProfile(job),
          })
        ).data,
      onSettled: refresh,
    }),
    run: useMutation({
      mutationFn: async (job: AgentJob) =>
        (
          await client.request('post', '/schedules/{schedule_id}/run', {
            params: { schedule_id: job.id },
            ...inProfile(job),
          })
        ).data,
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: async (job: AgentJob) => {
        await client.request('delete', '/schedules/{schedule_id}', {
          params: { schedule_id: job.id },
          ...inProfile(job),
        });
        return job.id;
      },
      onSettled: refresh,
    }),
  };
}
