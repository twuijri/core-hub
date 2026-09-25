/**
 * A coding agent's own config files (contract decision §77): its instructions file and its
 * settings file, one set for every profile, so the keys carry no profile.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';

export interface ConfigFile {
  key: string;
  label: { ar: string; en: string };
  path: string;
  language: 'markdown' | 'json' | 'yaml' | 'toml' | 'text';
  exists: boolean;
  size_bytes: number;
  revision: string | null;
  updated_at: string | null;
  content: string | null;
}

export const configFileKeys = {
  list: (agentId: string) => ['agent-config-files', agentId] as const,
  file: (agentId: string, key: string) => ['agent-config-files', agentId, key] as const,
};

export function useConfigFiles(agentId: string | undefined) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: configFileKeys.list(agentId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/config-files', {
          params: { agent_id: agentId ?? '' },
        })
      ).data as unknown as { items: ConfigFile[] },
    enabled: !!session && !!agentId,
  });
}

export function useConfigFile(agentId: string | undefined, key: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: configFileKeys.file(agentId ?? '', key ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/config-files/{file_key}', {
          params: { agent_id: agentId ?? '', file_key: key ?? '' },
        })
      ).data as unknown as ConfigFile,
    enabled: !!session && !!agentId && !!key,
    // An edit in progress is never replaced behind the person's back.
    refetchOnWindowFocus: false,
  });
}

export function useSaveConfigFile(agentId: string | undefined) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: string; content: string; revision: string | null }) =>
      (
        await client.request('put', '/agents/{agent_id}/config-files/{file_key}', {
          params: { agent_id: agentId ?? '', file_key: input.key },
          body: { content: input.content, revision: input.revision },
        })
      ).data as unknown as ConfigFile,
    onSuccess: (file) => {
      queryClient.setQueryData(configFileKeys.file(agentId ?? '', file.key), file);
      void queryClient.invalidateQueries({ queryKey: configFileKeys.list(agentId ?? '') });
    },
  });
}
