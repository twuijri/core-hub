// The profile's session categories over the generated client (contract decision §54).
// A category is the profile's, so every call names the profile it acts in; the list across
// profiles is one request (`profiles=all`, ADR 0016), like the chats list itself.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { ALL_PROFILES_KEY } from '../hub/queries.js';
import type { SessionCategory } from './groups.js';

export const categoryKeys = {
  all: ['session-categories'] as const,
  list: (profile: string) => ['session-categories', profile] as const,
};

const inProfile = (profile: string | undefined) =>
  profile ? { headers: { 'X-Hub-Profile': profile } } : {};

export function useCategories(filters: { allProfiles?: boolean; profile?: string } = {}) {
  const { client, profile, session } = useAuth();
  const listed = filters.profile ?? profile;
  return useQuery({
    queryKey: categoryKeys.list(filters.allProfiles ? ALL_PROFILES_KEY : listed),
    queryFn: async () =>
      (
        await client.request('get', '/session-categories', {
          ...(filters.allProfiles ? { query: { profiles: 'all' as const } } : {}),
          ...inProfile(filters.profile),
        })
      ).data.items as SessionCategory[],
    enabled: !!session,
  });
}

/** After any category write: every list of categories, and the chats (a delete moves some). */
function useRefresh() {
  const queryClient = useQueryClient();
  return (sessionsToo: boolean) => {
    void queryClient.invalidateQueries({ queryKey: categoryKeys.all });
    if (sessionsToo) void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
}

export function useCreateCategory() {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ name, profile }: { name: string; profile?: string | undefined }) =>
      (
        await client.request('post', '/session-categories', {
          body: { name },
          ...inProfile(profile),
        })
      ).data as SessionCategory,
    onSuccess: () => refresh(false),
  });
}

export function useUpdateCategory() {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
      profile,
    }: {
      id: string;
      patch: { name?: string; position?: number };
      profile?: string | undefined;
    }) =>
      (
        await client.request('patch', '/session-categories/{category_id}', {
          params: { category_id: id },
          body: patch,
          ...inProfile(profile),
        })
      ).data as SessionCategory,
    onSuccess: () => refresh(false),
  });
}

export function useDeleteCategory() {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ id, profile }: { id: string; profile?: string | undefined }) => {
      await client.request('delete', '/session-categories/{category_id}', {
        params: { category_id: id },
        ...inProfile(profile),
      });
      return id;
    },
    onSuccess: () => refresh(true),
  });
}
