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
import { toWrite, type Draft, type RunStep, type Send, type Validation } from './model.js';

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
  /** A run a trigger's delivery started (§123); absent from an older hub. */
  workflow_trigger_id?: string | null;
  delivery_id?: string | null;
  event_id?: string | null;
  task_id?: string | null;
  /** A condition said no and nothing followed: not one to act on. */
  filtered?: boolean;
  /** Where the run is (§127): received, analyzing, needs_input, approved, executing, … */
  phase?: string;
}

export type TriggerPreset = 'clickup' | 'github' | 'generic_hmac' | 'token';

/** An inbound webhook trigger (`WorkflowTrigger`, §123). The secret itself never comes back. */
export interface WorkflowTriggerRow {
  id: string;
  workflow_id: string;
  name: string;
  preset: TriggerPreset;
  enabled: boolean;
  events: string[];
  secret_stored: boolean;
  signature_header: string | null;
  signature_encoding: 'hex' | 'base64' | null;
  signature_prefix: string | null;
  path: string;
  last_delivery_at: string | null;
}

export type DeliveryStatus =
  | 'received'
  | 'duplicate'
  | 'signature_rejected'
  | 'filtered_out'
  | 'run_started'
  | 'run_succeeded'
  | 'run_failed';

export interface TriggerDeliveryRow {
  id: string;
  trigger_id: string;
  workflow_id: string;
  received_at: string;
  status: DeliveryStatus;
  event: string | null;
  event_id: string | null;
  task_id: string | null;
  workflow_run_id: string | null;
  filtered: boolean;
  test: boolean;
  error: string | null;
  body_preview: string | null;
}

/** How often a run still going is asked about, besides the realtime events. */
const LIVE_POLL_MS = 2_000;
/** How often the list is asked again with nothing running, besides the realtime events. */
const LIST_IDLE_POLL_MS = 30_000;

const inProfile = (profile: string) => ({ headers: { 'X-Hub-Profile': profile } });

export const workflowKeys = {
  all: ['schedules', 'workflows'] as const,
  one: (profile: string, id: string) => ['schedules', 'workflows', profile, id] as const,
  runs: (profile: string, id: string) => ['schedules', 'workflows', profile, id, 'runs'] as const,
  run: (profile: string, id: string) => ['schedules', 'workflow-run', profile, id] as const,
  triggers: (profile: string, id: string) =>
    ['schedules', 'workflows', profile, id, 'triggers'] as const,
  deliveries: (profile: string, triggerId: string) =>
    ['schedules', 'workflow-trigger', profile, triggerId, 'deliveries'] as const,
};

/** How often an open delivery log asks for what came in since (deliveries have no event). */
const DELIVERY_POLL_MS = 5_000;

export function useWorkflowTriggers(profile: string, workflowId: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: workflowKeys.triggers(profile, workflowId ?? ''),
    queryFn: async () => {
      const { data } = await client.request('get', '/workflows/{workflow_id}/triggers', {
        params: { workflow_id: workflowId! },
        ...inProfile(profile),
      });
      return (data as unknown as { items: WorkflowTriggerRow[] }).items;
    },
    enabled: !!session && !!workflowId,
  });
}

export function useTriggerDeliveries(profile: string, triggerId: string, open: boolean) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: workflowKeys.deliveries(profile, triggerId),
    queryFn: async () => {
      const { data } = await client.request(
        'get',
        '/workflow-triggers/{workflow_trigger_id}/deliveries',
        {
          params: { workflow_trigger_id: triggerId },
          query: { limit: 20 },
          ...inProfile(profile),
        },
      );
      return (data as unknown as { items: TriggerDeliveryRow[] }).items;
    },
    enabled: !!session && open,
    refetchInterval: open ? DELIVERY_POLL_MS : false,
  });
}

export function useTriggerWrites(profile: string, workflowId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['schedules'] });
  return {
    create: useMutation({
      mutationFn: async (body: { preset: TriggerPreset; name?: string; events?: string[] }) =>
        (
          await client.request('post', '/workflows/{workflow_id}/triggers', {
            params: { workflow_id: workflowId },
            body: body as never,
            ...inProfile(profile),
          })
        ).data as unknown as WorkflowTriggerRow,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
        (
          await client.request('patch', '/workflow-triggers/{workflow_trigger_id}', {
            params: { workflow_trigger_id: id },
            body: patch as never,
            ...inProfile(profile),
          })
        ).data as unknown as WorkflowTriggerRow,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        await client.request('delete', '/workflow-triggers/{workflow_trigger_id}', {
          params: { workflow_trigger_id: id },
          ...inProfile(profile),
        });
        return id;
      },
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: async ({ id, event }: { id: string; event: string | null }) =>
        (
          await client.request('post', '/workflow-triggers/{workflow_trigger_id}/test', {
            params: { workflow_trigger_id: id },
            body: { event } as never,
            ...inProfile(profile),
          })
        ).data as unknown as TriggerDeliveryRow,
      onSuccess: refresh,
    }),
  };
}

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
    // Behind the realtime events (a run a trigger started shows at once): with a run going the
    // list is asked again soon, so the card turns back when it ends; otherwise now and then,
    // for a socket that was away (owner, 2026-09-29).
    refetchInterval: (query) =>
      query.state.data?.some((workflow) => workflow.active_run_id !== null)
        ? LIVE_POLL_MS
        : LIST_IDLE_POLL_MS,
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

/** What a send did (`WorkflowSendResult`, §124). */
export interface SendResult {
  status: 'sent' | 'partial' | 'failed';
  message_id: string | null;
  message_ids: string[];
  delivered_to: string[];
  failures: Array<{ target: string; reason: string }>;
}

/** A conversation of the profile a "Send message" step can post in. */
export interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string;
  /** When someone last wrote in it; shown next to the title in the picker (§136). */
  last_message_at?: string | null;
  updated_at?: string | null;
  source?: string;
}

/** "Test conversation" (§136): how the conversation stands for the step, from the hub. */
export interface ConversationCheck {
  status: 'ready' | 'busy' | 'not_found' | 'not_allowed' | 'agent_mismatch' | (string & {});
  session_id: string;
  title: string | null;
  agent_id: string | null;
  active_run_id: string | null;
  last_message_at?: string | null;
  reason: string | null;
}

/**
 * Whether an agent step may talk in a conversation (§136): the rules the run applies,
 * nothing sent. The profile is the workflow's.
 */
export function useConversationCheck(profile: string) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async ({ sessionId, agentId }: { sessionId: string; agentId: string | null }) =>
      (
        await client.request('post', '/workflows/conversation-check', {
          body: { session_id: sessionId, agent_id: agentId } as never,
          ...inProfile(profile),
        })
      ).data as unknown as ConversationCheck,
  });
}

export function useProfileConversations(profile: string, enabled: boolean) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['sessions', profile, 'workflow-send'],
    queryFn: async () =>
      (
        (
          await client.request('get', '/sessions', {
            query: { limit: 200 } as never,
            ...inProfile(profile),
          })
        ).data as unknown as { items: ConversationRow[] }
      ).items,
    enabled: !!session && enabled,
    staleTime: 30_000,
  });
}

/** "Send test message": the step's words to its targets now (not remembered as sent). */
/** How long a test send may take before the page says the hub did not answer. */
export const SEND_TEST_TIMEOUT_MS = 90_000;

/** The hub gave no answer to a test send in time (`SEND_TEST_TIMEOUT_MS`). */
export class SendTestNoAnswer extends Error {
  constructor(readonly seconds: number) {
    super(`no answer within ${seconds} s`);
    this.name = 'SendTestNoAnswer';
  }
}

/** The hub's answer to a test send was not a `WorkflowSendResult` (a proxy's page, say). */
export class SendTestBadAnswer extends Error {
  constructor() {
    super('the answer was not a send result');
    this.name = 'SendTestBadAnswer';
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

/**
 * A `WorkflowSendResult` read defensively: anything else is `null`, so the page says it could
 * not read the answer instead of drawing nothing.
 */
export function readSendResult(data: unknown): SendResult | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (raw.status !== 'sent' && raw.status !== 'partial' && raw.status !== 'failed') return null;
  const ids = strings(raw.message_ids);
  return {
    status: raw.status,
    message_id: typeof raw.message_id === 'string' ? raw.message_id : (ids[0] ?? null),
    message_ids: ids.length > 0 ? ids : typeof raw.message_id === 'string' ? [raw.message_id] : [],
    delivered_to: strings(raw.delivered_to),
    failures: (Array.isArray(raw.failures) ? raw.failures : []).flatMap((failure: unknown) => {
      const each = (failure ?? {}) as { target?: unknown; reason?: unknown };
      return typeof each.target === 'string'
        ? [{ target: each.target, reason: typeof each.reason === 'string' ? each.reason : '' }]
        : [];
    }),
  };
}

export function useSendTest(profile: string) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async ({
      send,
      text,
      values,
      workflowId,
      nodeId,
    }: {
      send: Send;
      text: string;
      /** A value for each variable of `text`, by its path; the hub renders and sends (§124). */
      values?: Record<string, string>;
      /** Named in the hub's log line for the test only (2026-09-29). */
      workflowId?: string | null;
      nodeId?: string | null;
    }) => {
      const signal = AbortSignal.timeout(SEND_TEST_TIMEOUT_MS);
      let data: unknown;
      try {
        ({ data } = await client.request('post', '/workflows/send-test', {
          body: {
            send,
            text,
            ...(values && Object.keys(values).length > 0 ? { values } : {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
            ...(nodeId ? { node_id: nodeId } : {}),
          } as never,
          signal,
          ...inProfile(profile),
        }));
      } catch (error) {
        if (signal.aborted) throw new SendTestNoAnswer(SEND_TEST_TIMEOUT_MS / 1000);
        throw error;
      }
      const result = readSendResult(data);
      if (!result) throw new SendTestBadAnswer();
      return result;
    },
  });
}

/** What trying one step on its own did (`WorkflowStepTestResult`, §127). */
export interface StepTestResult {
  rendered: string | null;
  answer: boolean | null;
  output: string | null;
  error: string | null;
  executed: boolean;
  /** What each variable read as in the sample, by its path; absent from an older hub. */
  values?: Record<string, string>;
}

/** Try one step with a sample; nothing is saved and no run is made. */
export function useStepTest(profile: string) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (body: {
      node: ReturnType<typeof toWrite>['nodes'][number];
      input?: string | null;
      trigger?: unknown;
      execute?: boolean;
      /** A run to take the sample from (§124). */
      workflow_run_id?: string;
    }) =>
      (
        await client.request('post', '/workflows/test-step', {
          body: body as never,
          ...inProfile(profile),
        })
      ).data as unknown as StepTestResult,
  });
}
