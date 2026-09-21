// TanStack Query over the generated client. Every key carries the workspace slug so switching
// the workspace chip refetches everything (NAVIGATION rule 4) without touching the route.
import { HubApiError } from '@majlis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import type { Preferences, Session } from '../types.js';

export const keys = {
  meta: () => ['meta'] as const,
  me: () => ['me'] as const,
  preferences: () => ['preferences'] as const,
  profiles: () => ['profiles'] as const,
  sessions: (profile: string, filters: Record<string, string | boolean | number | undefined>) =>
    ['sessions', profile, filters] as const,
  session: (profile: string, id: string) => ['session', profile, id] as const,
  messages: (profile: string, id: string) => ['messages', profile, id] as const,
  agents: (profile: string) => ['agents', profile] as const,
  jobs: (profile: string) => ['jobs', profile] as const,
};

export function useMeta() {
  const { anonymous } = useAuth();
  return useQuery({
    queryKey: keys.meta(),
    queryFn: async () => (await anonymous.request('get', '/meta')).data,
    retry: false,
    staleTime: 60_000,
  });
}

export function useMe() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: keys.me(),
    queryFn: async () => (await client.request('get', '/auth/me')).data,
    enabled: !!session,
    staleTime: 60_000,
  });
}

export function useProfiles() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: keys.profiles(),
    queryFn: async () => (await client.request('get', '/profiles')).data.items,
    enabled: !!session,
    staleTime: 60_000,
  });
}

export function usePreferences() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: keys.preferences(),
    queryFn: async () => (await client.request('get', '/auth/me/preferences')).data,
    enabled: !!session,
    staleTime: 60_000,
  });
}

export function useSavePreferences() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (preferences: Preferences) =>
      (await client.request('put', '/auth/me/preferences', { body: preferences })).data,
    onSuccess: (data) => queryClient.setQueryData(keys.preferences(), data),
  });
}

export interface SessionFilters {
  q?: string | undefined;
  archived?: 'true' | 'false' | 'all' | undefined;
  pinned?: boolean | undefined;
  agent_id?: string | undefined;
}

export interface SessionPage {
  items: Session[];
  next_cursor: string | null;
}

export function useSessions(filters: SessionFilters = {}) {
  const { client, profile, session } = useAuth();
  const query: Record<string, string | number | boolean | undefined> = {
    limit: 100,
    archived: filters.archived ?? 'false',
  };
  if (filters.q) query.q = filters.q;
  if (filters.pinned !== undefined) query.pinned = filters.pinned;
  if (filters.agent_id) query.agent_id = filters.agent_id;
  return useQuery({
    queryKey: keys.sessions(profile, { ...query }),
    // The contract types `Page.items` per operation through allOf; the generated union leaves
    // `items` open, so the page is narrowed once here (the CLI does the same).
    queryFn: async () => (await client.request('get', '/sessions', { query })).data as SessionPage,
    enabled: !!session,
  });
}

export function useAgents() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: keys.agents(profile),
    queryFn: async () => (await client.request('get', '/agents')).data.items,
    enabled: !!session,
    staleTime: 30_000,
  });
}

/** Optimistically patch one session in every cached list. */
export function useUpdateSession() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Pick<Session, 'title' | 'pinned' | 'archived'>>;
    }) =>
      (
        await client.request('patch', '/sessions/{session_id}', {
          params: { session_id: id },
          body: patch,
        })
      ).data,
    onSuccess: (updated) => {
      queryClient.setQueriesData<SessionPage>(
        { queryKey: ['sessions', profile] },
        (page) =>
          page && { ...page, items: page.items.map((s) => (s.id === updated.id ? updated : s)) },
      );
      void queryClient.invalidateQueries({ queryKey: ['sessions', profile] });
      void queryClient.invalidateQueries({ queryKey: keys.session(profile, updated.id) });
    },
  });
}

export function useDeleteSession() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/sessions/{session_id}', { params: { session_id: id } });
      return id;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions', profile] }),
  });
}

export function useCreateSession() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { agent_id: string; title?: string | null }) =>
      (await client.request('post', '/sessions', { body })).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions', profile] }),
  });
}

export const isNotImplemented = (error: unknown): boolean =>
  error instanceof HubApiError && error.status === 501;
