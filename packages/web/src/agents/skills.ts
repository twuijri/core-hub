/**
 * An agent's skills. They are files in the agent's own home, so every write is a write to
 * that folder and the list is refetched from it rather than patched here — the folder is
 * the truth, and a cache that disagreed with it would be a second, wrong truth.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeleteAttachment, useUploadAttachment } from '../attachments/queries.js';
import { useAuth } from '../auth/context.js';
import type { Job } from '../types.js';

export interface Skill {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  pinned: boolean;
  source: 'builtin' | 'user' | 'external';
  use_count: number;
  updated_at: string | null;
  content: string | null;
}

export interface SkillCategory {
  key: string;
  name: string;
  description: string | null;
  skills: Skill[];
}

export const skillKeys = {
  list: (profile: string, agentId: string) => ['agent-skills', profile, agentId] as const,
  one: (profile: string, agentId: string, key: string) =>
    ['agent-skills', profile, agentId, key] as const,
};

export function useSkills(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: skillKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/skills', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { categories: SkillCategory[]; home: string | null },
    enabled: !!session && !!agentId,
  });
}

export function useSkill(agentId: string | undefined, key: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: skillKeys.one(profile, agentId ?? '', key ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: key ?? '' },
        })
      ).data as unknown as Skill,
    enabled: !!session && !!agentId && !!key,
  });
}

function useSkillInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.list(profile, agentId ?? '') });
  };
}

export function useSaveSkill(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { key: string; content: string }) =>
      (
        await client.request('put', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: input.key },
          body: { content: input.content } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function usePatchSkill(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { key: string; enabled?: boolean; pinned?: boolean }) =>
      (
        await client.request('patch', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: input.key },
          body: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteSkill(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (key: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/skills/{skill_key}', {
          params: { agent_id: agentId ?? '', skill_key: key },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------------- MCP

export interface McpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  enabled: boolean;
  connected: boolean;
  tools: Array<{ name: string; description: string }>;
  error: string | null;
  config: Record<string, unknown>;
  updated_at: string;
}

export const mcpKeys = {
  list: (profile: string, agentId: string) => ['agent-mcp', profile, agentId] as const,
};

export function useMcpServers(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: mcpKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/mcp-servers', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { items: McpServer[] },
    enabled: !!session && !!agentId,
  });
}

function useMcpInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: mcpKeys.list(profile, agentId ?? '') });
  };
}

export function useCreateMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: {
      name: string;
      transport: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }) =>
      (
        await client.request('post', '/agents/{agent_id}/mcp-servers', {
          params: { agent_id: agentId ?? '' },
          body: input as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useUpdateMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: {
      name: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }) =>
      (
        await client.request('patch', '/agents/{agent_id}/mcp-servers/{server_name}', {
          params: { agent_id: agentId ?? '', server_name: input.name },
          body: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.config === undefined ? {} : { config: input.config }),
          } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMcpInvalidation(agentId);
  return useMutation({
    mutationFn: async (name: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/mcp-servers/{server_name}', {
          params: { agent_id: agentId ?? '', server_name: name },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- memory

export interface MemoryItem {
  id: string;
  kind: 'document' | 'entry';
  title: string;
  content: string | null;
  tags: string[];
  revision: number;
  updated_at: string | null;
}

export const memoryKeys = {
  list: (profile: string, agentId: string, search: string) =>
    ['agent-memory', profile, agentId, search] as const,
};

export function useMemory(agentId: string | undefined, search: string) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: memoryKeys.list(profile, agentId ?? '', search),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/memory', {
          params: { agent_id: agentId ?? '' },
          query: search ? { q: search } : {},
        })
      ).data as unknown as { items: MemoryItem[] },
    enabled: !!session && !!agentId,
  });
}

function useMemoryInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['agent-memory', profile, agentId ?? ''] });
  };
}

export function useSaveMemory(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMemoryInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: { id: string; content: string }) =>
      (
        await client.request('put', '/agents/{agent_id}/memory/{item_id}', {
          params: { agent_id: agentId ?? '', item_id: input.id },
          body: { content: input.content } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteMemory(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useMemoryInvalidation(agentId);
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/memory/{item_id}', {
          params: { agent_id: agentId ?? '', item_id: id },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// -------------------------------------------------------------- channels

export interface ChannelField {
  key: string;
  label: { ar: string; en: string };
  kind: 'text' | 'secret' | 'toggle' | 'list';
  target: 'credentials' | 'configuration';
  value: unknown;
  hint: string | null;
}

export interface Channel {
  platform: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  exclusive: boolean;
  status: 'online' | 'offline' | 'error' | 'unknown';
  error: string | null;
  login: 'qr' | null;
  fields: ChannelField[];
}

export const channelKeys = {
  list: (profile: string, agentId: string) => ['agent-channels', profile, agentId] as const,
};

export function useChannels(agentId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: channelKeys.list(profile, agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/channels', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { items: Channel[] },
    enabled: !!session && !!agentId,
  });
}

function useChannelInvalidation(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: channelKeys.list(profile, agentId ?? '') });
  };
}

export function useUpdateChannel(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (input: {
      platform: string;
      enabled?: boolean;
      credentials?: Record<string, string>;
      configuration?: Record<string, unknown>;
    }) =>
      (
        await client.request('put', '/agents/{agent_id}/channels/{platform}', {
          params: { agent_id: agentId ?? '', platform: input.platform },
          body: {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.credentials ? { credentials: input.credentials } : {}),
            ...(input.configuration ? { configuration: input.configuration } : {}),
          } as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useClearChannel(agentId: string | undefined) {
  const { client } = useAuth();
  const invalidate = useChannelInvalidation(agentId);
  return useMutation({
    mutationFn: async (platform: string) =>
      (
        await client.request('delete', '/agents/{agent_id}/channels/{platform}', {
          params: { agent_id: agentId ?? '', platform },
        })
      ).data,
    onSuccess: invalidate,
  });
}

// ------------------------------------------------------------ live tools
//
// The three things these pages ask Hermes to *do* (ADR 0015): connect to an MCP server
// once, pair a channel by QR, install a pack of skills. Each acts on the selected profile.

export interface McpTestResult {
  ok: boolean;
  tools: Array<{ name: string; description: string | null }>;
  error: string | null;
  duration_ms: number;
}

export function useTestMcpServer(agentId: string | undefined) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (name: string) =>
      (
        await client.request('post', '/agents/{agent_id}/mcp-servers/{server_name}/test', {
          params: { agent_id: agentId ?? '', server_name: name },
        })
      ).data as unknown as McpTestResult,
  });
}

/**
 * Upload the files as skill packs, install them, and take the uploads back out: the pack is
 * in the agent's folder now, and a copy left in the profile's files would be clutter nobody
 * asked for.
 */
export function useImportSkills(agentId: string | undefined) {
  const { client } = useAuth();
  const { upload } = useUploadAttachment();
  const remove = useDeleteAttachment();
  const invalidate = useSkillInvalidation(agentId);
  return useMutation({
    mutationFn: async (files: readonly File[]) => {
      const ids: string[] = [];
      try {
        for (const file of files) ids.push((await upload({ file, purpose: 'skill' })).id);
        return (
          await client.request('post', '/agents/{agent_id}/skills', {
            params: { agent_id: agentId ?? '' },
            body: { attachment_ids: ids } as never,
          })
        ).data as unknown as { items: Skill[] };
      } finally {
        for (const id of ids) remove.mutate(id);
      }
    },
    onSuccess: invalidate,
  });
}

/** What a `channel_login` job carries while it runs (`agents.loginChannel`). */
export interface PairingState {
  status?: string;
  qr?: string | null;
  expires_at?: string | null;
  account_name?: string | null;
  account_phone?: string | null;
}

export function useLoginChannel(agentId: string | undefined) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (platform: string) =>
      (
        await client.request('post', '/agents/{agent_id}/channels/{platform}/login', {
          params: { agent_id: agentId ?? '', platform },
        })
      ).data as { job_id: string },
  });
}

/**
 * One job, read again every two seconds until it ends: the fallback under `/rt/jobs`, so a
 * dropped socket never leaves a QR code on screen that Hermes has already replaced.
 */
export function useJob(jobId: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['job', profile, jobId ?? ''],
    queryFn: async () =>
      (await client.request('get', '/jobs/{job_id}', { params: { job_id: jobId ?? '' } }))
        .data as unknown as Job,
    enabled: !!session && !!jobId,
    refetchInterval: (query) => {
      const status = (query.state.data as Job | undefined)?.status;
      return status === 'succeeded' || status === 'failed' || status === 'cancelled'
        ? false
        : 2000;
    },
  });
}

export function useCancelJob() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (jobId: string) =>
      (await client.request('post', '/jobs/{job_id}/cancel', { params: { job_id: jobId } })).data,
  });
}
