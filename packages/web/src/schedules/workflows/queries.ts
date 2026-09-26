/**
 * The workflow editor's calls. Every call about a workflow goes to that workflow's own
 * profile (`X-Hub-Profile`), whichever one the top selector shows (ADR 0016); the list is
 * every profile the person may enter (`profiles=all`, DECISIONS §52).
 *
 * Keys start with `schedules`, so the page's realtime handler (`/rt/schedules`: runs,
 * steps, workflows) refreshes them with everything else on the page.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/context.js';
import type { Limits } from '../WorkflowLimits.js';
import type { Agent, Model } from '../../types.js';
import { toWrite, type Draft, type RunStep, type Validation } from './model.js';

export interface WorkflowRow {
  id: string;
  profile: string;
  name: string;
  description: string | null;
  working_dir: string | null;
  nodes: unknown[];
  edges: unknown[];
  status: 'idle' | 'running' | 'waiting' | 'error';
  active_run_id: string | null;
  run_count: number;
  schedule_count: number;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  input: string | null;
  steps: RunStep[];
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** How often a run still going is asked about, besides the realtime events. */
const LIVE_POLL_MS = 2_000;

const inProfile = (profile: string) => ({ headers: { 'X-Hub-Profile': profile } });

export const workflowKeys = {
  all: ['schedules', 'workflows'] as const,
  one: (profile: string, id: string) => ['schedules', 'workflows', profile, id] as const,
  runs: (profile: string, id: string) => ['schedules', 'workflows', profile, id, 'runs'] as const,
  run: (profile: string, id: string) => ['schedules', 'workflow-run', profile, id] as const,
};

export function useWorkflows() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: workflowKeys.all,
    queryFn: async () => {
      const { data } = await client.request('get', '/workflows', {
        query: { profiles: 'all' } as never,
      });
      return (data as unknown as { items: WorkflowRow[] }).items;
    },
    enabled: !!session,
  });
}

export function useWorkflow(profile: string, id: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: workflowKeys.one(profile, id ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/workflows/{workflow_id}', {
          params: { workflow_id: id! },
          ...inProfile(profile),
        })
      ).data as unknown as WorkflowRow,
    enabled: !!session && !!id,
  });
}

export function useWorkflowRuns(profile: string, id: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: workflowKeys.runs(profile, id ?? ''),
    queryFn: async () => {
      const { data } = await client.request('get', '/workflows/{workflow_id}/runs', {
        params: { workflow_id: id! },
        query: { limit: 20 },
        ...inProfile(profile),
      });
      return (data as unknown as { items: WorkflowRunRow[] }).items;
    },
    enabled: !!session && !!id,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'queued' || run.status === 'running')
        ? LIVE_POLL_MS
        : false,
  });
}

export function useWorkflowRun(profile: string, runId: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: workflowKeys.run(profile, runId ?? ''),
    queryFn: async () =>
      (
        await client.request('get', '/workflow-runs/{workflow_run_id}', {
          params: { workflow_run_id: runId! },
          ...inProfile(profile),
        })
      ).data as unknown as WorkflowRunRow,
    enabled: !!session && !!runId,
    refetchInterval: (query) =>
      query.state.data?.status === 'queued' || query.state.data?.status === 'running'
        ? LIVE_POLL_MS
        : false,
  });
}

/** The agents of the workflow's own profile, for its agent steps. */
export function useProfileAgents(profile: string) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['agents', profile, 'workflow-editor'],
    queryFn: async () =>
      (await client.request('get', '/agents', inProfile(profile))).data.items as Agent[],
    enabled: !!session,
    staleTime: 30_000,
  });
}

/** The chat models the workflow's profile can run, for an agent step's own model. */
export function useProfileModels(profile: string) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['models', 'catalogue', profile, 'workflow-editor'],
    queryFn: async () =>
      (
        await client.request('get', '/models', {
          query: { limit: 200 },
          ...inProfile(profile),
        })
      ).data.items as Model[],
    enabled: !!session,
    staleTime: 60_000,
  });
}

/** The hub's check of a drawing nobody saved (`schedules.validateWorkflow`). */
export async function validateDraft(
  client: ReturnType<typeof useAuth>['client'],
  profile: string,
  draft: Draft,
): Promise<Validation> {
  const { data } = await client.request('post', '/workflows/validate', {
    body: toWrite(draft) as never,
    ...inProfile(profile),
  });
  return data as unknown as Validation;
}

export function useWorkflowWrites() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['schedules'] });
  return {
    create: useMutation({
      mutationFn: async ({ profile, draft }: { profile: string; draft: Draft }) =>
        (
          await client.request('post', '/workflows', {
            body: toWrite(draft) as never,
            ...inProfile(profile),
          })
        ).data as unknown as WorkflowRow,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ profile, id, draft }: { profile: string; id: string; draft: Draft }) =>
        (
          await client.request('patch', '/workflows/{workflow_id}', {
            params: { workflow_id: id },
            body: toWrite(draft) as never,
            ...inProfile(profile),
          })
        ).data as unknown as WorkflowRow,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async ({ profile, id }: { profile: string; id: string }) => {
        await client.request('delete', '/workflows/{workflow_id}', {
          params: { workflow_id: id },
          ...inProfile(profile),
        });
        return id;
      },
      onSuccess: refresh,
    }),
    run: useMutation({
      mutationFn: async ({
        profile,
        id,
        input,
        startNodeIds,
        limits,
      }: {
        profile: string;
        id: string;
        input: string | null;
        startNodeIds?: string[] | null;
        /** This run's own limits (`WorkflowLimitsOverride`); absent keeps the workflow's. */
        limits?: Limits | null;
      }) =>
        (
          await client.request('post', '/workflows/{workflow_id}/run', {
            params: { workflow_id: id },
            body: {
              input,
              start_node_ids: startNodeIds ?? null,
              ...(limits ? { limits } : {}),
            } as never,
            ...inProfile(profile),
          })
        ).data as unknown as { workflow_run_id: string },
      onSuccess: refresh,
    }),
    rerun: useMutation({
      mutationFn: async ({
        profile,
        runId,
        nodeId,
      }: {
        profile: string;
        runId: string;
        nodeId: string;
      }) =>
        (
          await client.request('post', '/workflow-runs/{workflow_run_id}/rerun', {
            params: { workflow_run_id: runId },
            body: { from_node_id: nodeId } as never,
            ...inProfile(profile),
          })
        ).data as unknown as { workflow_run_id: string },
      onSuccess: refresh,
    }),
    cancel: useMutation({
      mutationFn: async ({ profile, runId }: { profile: string; runId: string }) =>
        (
          await client.request('post', '/workflow-runs/{workflow_run_id}/cancel', {
            params: { workflow_run_id: runId },
            ...inProfile(profile),
          })
        ).data,
      onSuccess: refresh,
    }),
  };
}
