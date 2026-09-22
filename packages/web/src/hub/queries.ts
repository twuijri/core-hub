// TanStack Query over the generated client. Every key carries the workspace slug so switching
// the workspace chip refetches everything (NAVIGATION rule 4) without touching the route.
import { HubApiError } from '@majlis/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import type { Preferences, Session } from '../types.js';

export const keys = {
  meta: () => ['meta'] as const,
  setup: () => ['setup'] as const,
  me: () => ['me'] as const,
  preferences: () => ['preferences'] as const,
  profiles: () => ['profiles'] as const,
  sessions: (profile: string, filters: Record<string, string | boolean | number | undefined>) =>
    ['sessions', profile, filters] as const,
  session: (profile: string, id: string) => ['session', profile, id] as const,
  messages: (profile: string, id: string) => ['messages', profile, id] as const,
  agents: (profile: string) => ['agents', profile] as const,
  agentSettings: (profile: string, agentId: string) =>
    ['agents', profile, agentId, 'settings'] as const,
  workingDirs: (profile: string) => ['working-dirs', profile] as const,
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

/**
 * First run (ADR 0011): does this hub still need its owner account created? Unauthenticated,
 * always fetched fresh — it decides between the sign-in screen and the setup screen.
 */
export function useSetupState() {
  const { anonymous } = useAuth();
  return useQuery({
    queryKey: keys.setup(),
    queryFn: async () => (await anonymous.request('get', '/auth/setup')).data,
    retry: false,
    staleTime: 0,
    gcTime: 0,
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
    mutationFn: async (body: {
      agent_id: string;
      title?: string | null;
      model?: string | null;
      working_dir?: string | null;
    }) => (await client.request('post', '/sessions', { body })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', profile] });
      // The hub may have created the folder this session works in.
      void queryClient.invalidateQueries({ queryKey: keys.workingDirs(profile) });
    },
  });
}

/** The hub's workspace root and the folders already under it (`sessions.listWorkingDirs`). */
export function useWorkingDirs() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: keys.workingDirs(profile),
    queryFn: async () => (await client.request('get', '/sessions/working-dirs')).data,
    enabled: !!session,
    staleTime: 15_000,
  });
}

/**
 * One session's own fields: the model it runs on and the folder it works in. Separate from
 * `useUpdateSession` (the list's pin/archive/rename) because it invalidates the open session.
 */
export function usePatchSession(sessionId: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { model?: string | null; working_dir?: string | null }) =>
      (
        await client.request('patch', '/sessions/{session_id}', {
          params: { session_id: sessionId },
          body: patch,
        })
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.session(profile, sessionId) });
      void queryClient.invalidateQueries({ queryKey: ['sessions', profile] });
      void queryClient.invalidateQueries({ queryKey: keys.workingDirs(profile) });
    },
  });
}

/**
 * Continue this conversation with a different agent (contract decision §26).
 *
 * Not a patch: `Session.agent_id` is who the conversation is *with*, and rewriting it in
 * place would leave a transcript half of which the row no longer accounts for. The hub
 * forks — the messages travel, the fork runs on the new agent, no run starts, and the
 * original is left exactly as it was. Changing the **model** is still `sessions.update`.
 */
export function useForkSession(sessionId: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { agent_id?: string; model?: string | null }) =>
      (
        await client.request('post', '/sessions/{session_id}/fork', {
          params: { session_id: sessionId },
          body,
        })
      ).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sessions', profile] }),
  });
}

/**
 * `agent_settings` as the adapter describes them (ADR 0002). The composer reads one field
 * out of them — `approval_mode` in the `session` section — and writes it back the same way;
 * an adapter that does not declare it simply has no selector to offer.
 */
export function useAgentSettings(agentId: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: keys.agentSettings(profile, agentId ?? 'none'),
    queryFn: async () =>
      (
        await client.request('get', '/agents/{agent_id}/settings', {
          params: { agent_id: agentId as string },
        })
      ).data,
    enabled: !!session && !!agentId,
    retry: false,
    staleTime: 30_000,
  });
}

export function useSaveAgentSetting(agentId: string | null) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ section, values }: { section: string; values: Record<string, unknown> }) =>
      (
        await client.request('patch', '/agents/{agent_id}/settings', {
          params: { agent_id: agentId as string },
          body: { section, values },
        })
      ).data,
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: keys.agentSettings(profile, agentId ?? 'none'),
      }),
  });
}

export const isNotImplemented = (error: unknown): boolean =>
  error instanceof HubApiError && error.status === 501;
