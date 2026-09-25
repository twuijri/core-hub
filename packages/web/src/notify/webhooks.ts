/**
 * The webhooks of the notify module: addresses the hub calls on its own.
 *
 * **Global in the contract, scoped in the rows.** The operations are `x-scope: global`,
 * but the hub keeps each webhook in the profile the request came from, so switching
 * profiles lists a different set — the key carries the profile for that reason.
 *
 * **Deliveries happen in the background** (contract decision §53): an event is queued,
 * sent, and retried with backoff by the hub; the table here follows it and can send a
 * failed one again.
 *
 * **A signing secret is written once and never read back.** The hub answers `[stored]`
 * for one that exists; the only moment the real value is on screen is right after this
 * client made it (`newSigningSecret`), which is why it is generated here rather than asked
 * of the hub.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  profiles: string[];
  enabled: boolean;
  secret: '[stored]' | null;
  include_content: boolean;
  allow_private_network: boolean;
  max_retries: number;
  stats: {
    delivered: number;
    failed: number;
    last_delivery_at: string | null;
    last_error: string | null;
  };
  created_at: string;
  updated_at: string;
}

export interface WebhookWrite {
  name?: string;
  url?: string;
  events?: string[];
  /** Empty: every profile the person saving it may enter. */
  profiles?: string[];
  enabled?: boolean;
  secret?: string | null;
  include_content?: boolean;
  allow_private_network?: boolean;
  max_retries?: number;
}

/** What a new webhook retries when nobody changes it (the contract's default). */
export const DEFAULT_MAX_RETRIES = 5;
/** The contract's bounds for `max_retries`. */
export const MAX_RETRIES_LIMIT = 10;

export type DeliveryStatus = 'queued' | 'delivered' | 'failed' | 'dead';

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  status: DeliveryStatus;
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
}

/**
 * Whether a person may send this delivery again: it is over and did not arrive. One still
 * waiting for its retry will be sent anyway (the hub answers 409 for it).
 */
export function canRedeliver(delivery: WebhookDelivery): boolean {
  return (
    delivery.status === 'dead' ||
    (delivery.status === 'failed' && delivery.next_attempt_at === null)
  );
}

/** A number for the retries field, within the contract's 0–10. */
export function clampRetries(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
  return Math.min(Math.max(Math.round(value), 0), MAX_RETRIES_LIMIT);
}

export interface WebhookEvent {
  name: string;
  description: { ar: string; en: string };
}

/** What the test job reports when it is done (`notify.testWebhook`'s job result). */
export interface TestOutcome {
  delivered: boolean;
  status: number;
  error: string | null;
}

export const webhookKeys = {
  all: (profile: string) => ['webhooks', profile] as const,
  deliveries: (profile: string, id: string) => ['webhooks', profile, 'deliveries', id] as const,
  events: () => ['webhook-events'] as const,
};

/**
 * A new HMAC key: 32 random bytes as hex, with a prefix that says what it is when it
 * turns up in somebody's password manager.
 */
export function newSigningSecret(random: (bytes: Uint8Array) => Uint8Array = defaultRandom) {
  const bytes = random(new Uint8Array(32));
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  return crypto.getRandomValues(bytes);
}

export function useWebhooks() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: webhookKeys.all(profile),
    queryFn: async () =>
      (await client.request('get', '/notify/webhooks')).data as unknown as { items: Webhook[] },
    enabled: !!session,
  });
}

export function useWebhookEvents() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: webhookKeys.events(),
    queryFn: async () =>
      (await client.request('get', '/notify/webhook-events')).data as unknown as {
        items: WebhookEvent[];
      },
    enabled: !!session,
    staleTime: Infinity,
  });
}

export function useWebhookDeliveries(id: string, enabled: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: webhookKeys.deliveries(profile, id),
    queryFn: async () =>
      (
        await client.request('get', '/notify/webhooks/{webhook_id}/deliveries', {
          params: { webhook_id: id },
          query: { limit: 10 },
        })
      ).data as unknown as { items: WebhookDelivery[] },
    enabled: !!session && enabled,
    // The hub sends in the background, so an open table follows it: quickly while
    // something is waiting to be sent, slowly otherwise, to show new events arriving.
    refetchInterval: (query) =>
      query.state.data?.items.some((d) => d.status === 'queued' || d.next_attempt_at !== null)
        ? 1_500
        : 5_000,
  });
}

function useWebhookInvalidation() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  // The prefix covers the list and every open delivery table.
  return () => queryClient.invalidateQueries({ queryKey: webhookKeys.all(profile) });
}

export function useCreateWebhook() {
  const { client } = useAuth();
  const invalidate = useWebhookInvalidation();
  return useMutation({
    mutationFn: async (body: WebhookWrite) =>
      (await client.request('post', '/notify/webhooks', { body: body as never }))
        .data as unknown as Webhook,
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateWebhook() {
  const { client } = useAuth();
  const invalidate = useWebhookInvalidation();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: WebhookWrite }) =>
      (
        await client.request('patch', '/notify/webhooks/{webhook_id}', {
          params: { webhook_id: id },
          body: body as never,
        })
      ).data as unknown as Webhook,
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteWebhook() {
  const { client } = useAuth();
  const invalidate = useWebhookInvalidation();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/notify/webhooks/{webhook_id}', {
        params: { webhook_id: id },
      });
    },
    onSuccess: () => void invalidate(),
  });
}

/** Send a failed delivery again; the hub queues a new one with the same body. */
export function useRedeliver() {
  const { client } = useAuth();
  const invalidate = useWebhookInvalidation();
  return useMutation({
    mutationFn: async ({ webhookId, deliveryId }: { webhookId: string; deliveryId: string }) =>
      (
        await client.request(
          'post',
          '/notify/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver',
          { params: { webhook_id: webhookId, delivery_id: deliveryId } },
        )
      ).data as unknown as WebhookDelivery,
    onSuccess: () => void invalidate(),
  });
}

/** Queue the test delivery; the answer is a job, followed by `useTestJob`. */
export function useSendTest() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('post', '/notify/webhooks/{webhook_id}/test', {
          params: { webhook_id: id },
        })
      ).data as unknown as { job_id: string },
  });
}

interface JobState {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: Record<string, unknown> | null;
  error: { error: string; code: string } | null;
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * The test job until it finishes. Polled rather than waited for on `/rt/jobs`: it is one
 * short job on one page, and a poll that stops by itself cannot miss an event sent before
 * the socket joined. When it finishes the list and its deliveries are refetched, because
 * the job just wrote both.
 */
export function useTestJob(jobId: string | null) {
  const { client, session } = useAuth();
  const invalidate = useWebhookInvalidation();
  return useQuery({
    queryKey: ['webhook-test-job', jobId],
    queryFn: async () => {
      const job = (await client.request('get', '/jobs/{job_id}', { params: { job_id: jobId! } }))
        .data as unknown as JobState;
      if (FINISHED.has(job.status)) void invalidate();
      return job;
    },
    enabled: !!session && !!jobId,
    refetchInterval: (query) =>
      query.state.data && FINISHED.has(query.state.data.status) ? false : 700,
  });
}

/** The outcome of a finished test, or null while it runs. */
export function testOutcomeOf(job: JobState | undefined): TestOutcome | null {
  if (!job || !FINISHED.has(job.status)) return null;
  if (job.status === 'succeeded' && job.result) return job.result as unknown as TestOutcome;
  return { delivered: false, status: 0, error: job.error?.error ?? null };
}
