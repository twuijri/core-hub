/**
 * An agent's skills. They are files in the agent's own home, so every write is a write to
 * that folder and the list is refetched from it rather than patched here — the folder is
 * the truth, and a cache that disagreed with it would be a second, wrong truth.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';

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
