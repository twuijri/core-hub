/**
 * The last four settings pages whose module already answers: Knowledge, Plugins,
 * Updates and About.
 *
 * They have almost nothing in common except that, so they share a file rather than four
 * files of six lines each. What they do share is worth saying once: three of the four are
 * **global** (`x-scope: global`) — a plugin, a release and the hub's own identity belong
 * to the hub, not to a workspace. Knowledge is the exception, and its key carries the
 * profile because journal entries and notes are a workspace's.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';

export type ItemKind = 'journal' | 'note' | 'file';

export interface KnowledgeItem {
  id: string;
  kind: ItemKind;
  title: string | null;
  content: string | null;
  date: string | null;
  mood: string | null;
  tags: string[];
  attachment_ids: string[];
  created_at: string;
}

export interface HubPlugin {
  id: string;
  slug: string;
  name: string;
  version: string;
  kind: 'docker' | 'mcp';
  status: 'running' | 'stopped' | 'error';
  url: string | null;
}

export type ReleaseChannel = 'stable' | 'test';
export type ClientPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'linux';

export interface Release {
  id: string;
  platform: ClientPlatform;
  channel: ReleaseChannel;
  version: string;
  build: number;
  notes: { ar: string; en: string };
  size_bytes: number;
  sha256: string;
  mandatory: boolean;
  published_at: string;
}

export interface UpdateSettings {
  default_channel: ReleaseChannel;
  source: { kind: 'manual' | 'github_release'; repo: string | null; token: string | null };
  auto_publish: boolean;
}

export interface Meta {
  name: string;
  server_version: string;
  contract_version: string;
  api_versions: string[];
  realtime_namespaces: string[];
  locales: string[];
}

export const hubKeys = {
  knowledge: (profile: string, kind: string) => ['knowledge', profile, kind] as const,
  plugins: () => ['plugins'] as const,
  releases: () => ['releases'] as const,
  updateSettings: () => ['update-settings'] as const,
};

export function useKnowledge(kind: ItemKind | 'all', search: string) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: [...hubKeys.knowledge(profile, kind), search],
    queryFn: async () =>
      (
        await client.request('get', '/knowledge/items', {
          query: {
            limit: 50,
            ...(kind === 'all' ? {} : { kind }),
            ...(search ? { q: search } : {}),
          },
        })
      ).data as unknown as { items: KnowledgeItem[]; next_cursor: string | null },
    enabled: !!session,
  });
}

export function usePlugins() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: hubKeys.plugins(),
    queryFn: async () =>
      (await client.request('get', '/plugins')).data as unknown as { items: HubPlugin[] },
    enabled: !!session,
  });
}

export function useReleases() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: hubKeys.releases(),
    queryFn: async () =>
      (await client.request('get', '/updates/releases', { query: { limit: 50 } }))
        .data as unknown as { items: Release[] },
    enabled: !!session,
  });
}

export function useUpdateSettings() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: hubKeys.updateSettings(),
    queryFn: async () =>
      (await client.request('get', '/updates/settings')).data as unknown as UpdateSettings,
    enabled: !!session,
  });
}

export interface UpdateSettingsWrite {
  default_channel?: ReleaseChannel;
  source?: { kind: 'manual' | 'github_release'; repo?: string | null; token?: string | null };
  auto_publish?: boolean;
}

export function useSaveUpdateSettings() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateSettingsWrite) =>
      (await client.request('put', '/updates/settings', { body: body as never })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: hubKeys.updateSettings() });
    },
  });
}

export function useDeleteRelease() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('delete', '/updates/releases/{release_id}', {
          params: { release_id: id },
        })
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: hubKeys.releases() });
    },
  });
}
