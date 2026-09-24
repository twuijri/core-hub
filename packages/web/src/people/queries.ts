/**
 * The people on this hub and the workspaces they may enter.
 *
 * Both are `auth`'s, both are **global** (`x-scope: global`): a person is not a member of
 * one workspace's list of people, and a workspace is not inside another. So neither key
 * carries a profile, and switching the workspace chip does not refetch them.
 *
 * The hub's own rules are mirrored here as predicates rather than as guesses in a screen:
 * the owner cannot be demoted, disabled, given a new password or deleted; nobody may
 * disable or delete themselves; the default workspace stays. A screen asks these
 * questions instead of offering an action the hub will refuse.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useJobs } from '../agents/useJobs.js';
import { useAuth } from '../auth/context.js';
import type { Job } from '../types.js';

export type Role = 'owner' | 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';

export interface HubUser {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  status: UserStatus;
  locale: 'ar' | 'en';
  profiles: string[];
  default_profile: string;
  last_login_at: string | null;
  created_at: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  default_model: { provider_id: string; model: string } | null;
  agent_count: number;
  session_count: number;
  owner_id: string;
  created_at: string;
}

export interface Lockout {
  ip: string;
  kind: 'password' | 'token' | 'pairing';
  failures: number;
  locked_until: string;
}

export const peopleKeys = {
  users: () => ['users'] as const,
  workspaces: () => ['workspaces'] as const,
  lockouts: () => ['lockouts'] as const,
};

/** True when this person's role, status or password may not be touched at all. */
export const isOwner = (user: HubUser): boolean => user.role === 'owner';
/** True when the actor is looking at their own row: they may not disable or delete it. */
export const isSelf = (user: HubUser, actorId: string | undefined): boolean => user.id === actorId;

export function useUsers() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: peopleKeys.users(),
    queryFn: async () =>
      (await client.request('get', '/auth/users', { query: { limit: 100 } })).data as unknown as {
        items: HubUser[];
      },
    enabled: !!session,
  });
}

export function useLockouts() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: peopleKeys.lockouts(),
    queryFn: async () =>
      (await client.request('get', '/auth/lockouts')).data as unknown as { items: Lockout[] },
    enabled: !!session,
  });
}

function useUsersInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: peopleKeys.users() });
  };
}

export interface NewUser {
  username: string;
  password: string;
  display_name?: string;
  role: 'admin' | 'member';
  profiles?: string[];
  locale?: 'ar' | 'en';
}

export function useCreateUser() {
  const { client } = useAuth();
  const invalidate = useUsersInvalidation();
  return useMutation({
    mutationFn: async (body: NewUser) =>
      (await client.request('post', '/auth/users', { body: body as never })).data,
    onSuccess: invalidate,
  });
}

export interface UserPatch {
  display_name?: string;
  role?: 'admin' | 'member';
  status?: UserStatus;
  profiles?: string[];
  default_profile?: string;
  password?: string;
}

export function useUpdateUser() {
  const { client } = useAuth();
  const invalidate = useUsersInvalidation();
  return useMutation({
    mutationFn: async (input: { id: string; patch: UserPatch }) =>
      (
        await client.request('patch', '/auth/users/{user_id}', {
          params: { user_id: input.id },
          body: input.patch as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useDeleteUser() {
  const { client } = useAuth();
  const invalidate = useUsersInvalidation();
  return useMutation({
    mutationFn: async (id: string) =>
      (await client.request('delete', '/auth/users/{user_id}', { params: { user_id: id } })).data,
    onSuccess: invalidate,
  });
}

export function useClearLockouts() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await client.request('delete', '/auth/lockouts')).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peopleKeys.lockouts() });
    },
  });
}

/** The contract's `ProfileName`: at most Hermes's own limit for a display name. */
export const PROFILE_NAME_MAX = 64;

export function useWorkspaces() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: peopleKeys.workspaces(),
    queryFn: async () =>
      (await client.request('get', '/profiles')).data as unknown as { items: Workspace[] },
    enabled: !!session,
  });
}

function useWorkspacesInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: peopleKeys.workspaces() });
    // A new or archived workspace changes the footer chip and everybody's membership list.
    void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    void queryClient.invalidateQueries({ queryKey: peopleKeys.users() });
  };
}

export function useCreateWorkspace() {
  const { client } = useAuth();
  const invalidate = useWorkspacesInvalidation();
  return useMutation({
    mutationFn: async (body: { slug: string; name: string; clone_from?: string | null }) =>
      (await client.request('post', '/profiles', { body: body as never })).data,
    onSuccess: invalidate,
  });
}

export function useUpdateWorkspace() {
  const { client } = useAuth();
  const invalidate = useWorkspacesInvalidation();
  return useMutation({
    mutationFn: async (input: { id: string; patch: { name?: string } }) =>
      (
        await client.request('patch', '/profiles/{profile_id}', {
          params: { profile_id: input.id },
          body: input.patch as never,
        })
      ).data,
    onSuccess: invalidate,
  });
}

/**
 * Archives the workspace — the hub's own word. Its rows are not purged; that is the
 * owner-only job described in `docs/domain/README.md`. The screen says "archive" for the
 * same reason: a button labelled delete that archives is a lie the person finds out later.
 */
export function useArchiveWorkspace() {
  const { client } = useAuth();
  const invalidate = useWorkspacesInvalidation();
  return useMutation({
    mutationFn: async (id: string) =>
      (await client.request('delete', '/profiles/{profile_id}', { params: { profile_id: id } }))
        .data,
    onSuccess: invalidate,
  });
}

/**
 * A profile moved as Hermes's own archive (ADR 0014 stage 2, contract decision §34). Both
 * operations answer a job at once; the job lives in the profile the person is in, so the
 * `/rt/jobs` room this client already listens to hears it, and `jobs.get` finds it.
 */
export interface ProfileExportResult {
  attachment_id: string;
  profile: string;
  name: string;
  size_bytes: number;
  expires_at: string;
  /** Paths inside the archive the hub left out (credential files). */
  removed: string[];
  /** Paths inside the archive where a stored provider key was overwritten. */
  masked: string[];
  /** How many providers the archive carries, keys included (0 without; decision §37). */
  providers?: number;
}

export interface ProfileImportResult {
  profile_id: string;
  slug: string;
  name: string;
  /** Providers the archive carried, now the imported profile's own (decision §37). */
  providers?: number;
}

export function useExportWorkspace() {
  const { client } = useAuth();
  return useMutation({
    // With the profile's providers and their keys only when the person chose it (§37).
    mutationFn: async ({ id, providers }: { id: string; providers: boolean }) =>
      (
        await client.request('post', '/profiles/{profile_id}/export', {
          params: { profile_id: id },
          body: { providers },
        })
      ).data.job_id,
  });
}

export function useImportWorkspace() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (body: { attachment_id: string; slug: string; name?: string }) =>
      (await client.request('post', '/profile-imports', { body })).data.job_id,
  });
}

const FINISHED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);
export const jobFinished = (job: Job | undefined): boolean => !!job && FINISHED.has(job.status);

/**
 * One job, followed to its end: the `/rt/jobs` events as they arrive, and a read every
 * second until it has finished — an event that went out before this screen subscribed is
 * then still seen, a second later at worst. Whichever copy has finished wins.
 */
export function useFollowedJob(jobId: string | null): Job | undefined {
  const { client, profile } = useAuth();
  const live = useJobs();
  const polled = useQuery({
    queryKey: ['job', profile, jobId],
    queryFn: async () =>
      (await client.request('get', '/jobs/{job_id}', { params: { job_id: jobId ?? '' } }))
        .data as Job,
    enabled: jobId !== null,
    refetchInterval: (query) => (jobFinished(query.state.data) ? false : 1000),
  });
  if (!jobId) return undefined;
  const pushed = live[jobId];
  if (jobFinished(pushed)) return pushed;
  if (jobFinished(polled.data)) return polled.data;
  return pushed ?? polled.data;
}
