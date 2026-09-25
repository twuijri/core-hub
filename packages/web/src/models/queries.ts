// The `models` screen's reads and writes, over the generated client (ADR 0003).
// Every key carries the workspace slug, so switching the chip refetches (NAVIGATION rule 4).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import type {
  Model,
  ModelDefaults,
  Provider,
  ProviderHost,
  ProviderPreset,
  ProviderProbeResult,
  RuntimeReport,
  SpeechSettings,
} from '../types.js';

export const modelKeys = {
  providers: (profile: string) => ['models', 'providers', profile] as const,
  presets: (profile: string) => ['models', 'presets', profile] as const,
  catalogue: (profile: string) => ['models', 'catalogue', profile] as const,
  defaults: (profile: string) => ['models', 'defaults', profile] as const,
  speech: (profile: string) => ['models', 'speech', profile] as const,
  runtime: (profile: string) => ['models', 'runtime', profile] as const,
};

export function useProviders() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.providers(profile),
    queryFn: async () =>
      (await client.request('get', '/models/providers')).data.items as Provider[],
    enabled: !!session,
  });
}

/**
 * What can be added, which is not what has been added: the providers list answers the
 * second question and this one the first (contract decision §26). `host` says whether a
 * loopback base URL would reach the container instead of the person's machine.
 */
export function useProviderPresets() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.presets(profile),
    queryFn: async () =>
      (await client.request('get', '/models/provider-presets')).data as {
        items: ProviderPreset[];
        host: ProviderHost;
      },
    enabled: !!session,
  });
}

/**
 * Did the runtime actually take what was configured (ADR 0010)?
 *
 * The answer is about files and a process, not rows, so it is never cached for long: a
 * gateway that is restarting says one thing a second before it says another, and a stale
 * "all good" is exactly the silence this check exists to end.
 */
export function useRuntimeReport(options: { enabled?: boolean } = {}) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.runtime(profile),
    queryFn: async () => (await client.request('get', '/models/runtime')).data as RuntimeReport,
    // The chat screen asks only once a run has actually failed for want of a provider:
    // a check nobody is looking at is a request nobody needed.
    enabled: !!session && (options.enabled ?? true),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useModelDefaults() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.defaults(profile),
    queryFn: async () => (await client.request('get', '/models/defaults')).data as ModelDefaults,
    enabled: !!session,
  });
}

export function useSpeechSettings() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.speech(profile),
    queryFn: async () => (await client.request('get', '/models/speech')).data as SpeechSettings,
    enabled: !!session,
  });
}

/** Every model of every enabled provider, for the default pickers. */
export function useCatalogue() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.catalogue(profile),
    queryFn: async () =>
      (await client.request('get', '/models', { query: { limit: 200 } })).data.items as Model[],
    enabled: !!session,
  });
}

/**
 * Everything the screen writes invalidates the same reads: one rule, no drift. In **every**
 * profile, not just this one: providers are the hub's (contract decision §34), and a profile
 * that chose no model shows the default profile's, so a save here changes what the others
 * show too.
 */
function useModelsMutation<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      for (const key of ['providers', 'catalogue', 'defaults', 'speech', 'runtime'] as const) {
        void queryClient.invalidateQueries({ queryKey: ['models', key] });
      }
      // An inherited model is shown on every agent card (ADR 0010 §4).
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export interface ProviderPatch {
  id: string;
  /** A value sets the key; `''` clears it. Never the mask — the caller drops that. */
  api_key?: string;
  enabled?: boolean;
  label?: string;
  base_url?: string | null;
  visibility?: { mode: 'all' | 'include'; models: string[] };
}

export function useSaveProvider() {
  const { client } = useAuth();
  return useModelsMutation(async ({ id, ...patch }: ProviderPatch) => {
    const response = await client.request('patch', '/models/providers/{provider_id}', {
      params: { provider_id: id },
      body: patch,
    });
    return response.data as Provider;
  });
}

export interface ProviderCreate {
  /** A `ProviderPreset.id`, or absent for a bare OpenAI-compatible endpoint. */
  preset?: string;
  label: string;
  kind: 'llm' | 'stt' | 'tts';
  base_url: string;
  /** Sent only when the person typed one; every provider accepts one, none demands it. */
  api_key?: string;
  /** Every profile (`all`, shared) or only the one selected at the top (decision §37). */
  scope: 'all' | 'profile';
}

export function useCreateProvider() {
  const { client } = useAuth();
  return useModelsMutation(async (input: ProviderCreate) => {
    // The contract gives `api_mode` a default, but the generated type still requires
    // it: every endpoint a client here adds is an OpenAI-compatible one.
    const body = { ...input, api_mode: 'chat_completions' as const };
    return (await client.request('post', '/models/providers', { body })).data as Provider;
  });
}

/**
 * The dialog's **Fetch**: the model list of an endpoint that has not been saved. Nothing
 * is stored, and a failure comes back as `ok: false` with the endpoint's own words.
 */
export function useProbeProvider() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (input: { preset?: string; base_url: string; api_key?: string }) =>
      (await client.request('post', '/models/provider-probes', { body: input }))
        .data as ProviderProbeResult,
  });
}

/** An alias, a visibility, or registering a model the provider does not list. */
export function useSaveModel() {
  const { client } = useAuth();
  return useModelsMutation(
    async (input: {
      provider_id: string;
      model: string;
      alias?: string | null;
      visible?: boolean;
      custom?: boolean;
    }) => {
      const { provider_id, model, ...patch } = input;
      return (
        await client.request('put', '/models/providers/{provider_id}/models/{model}', {
          params: { provider_id, model: encodeURIComponent(model) },
          body: patch,
        })
      ).data as Model;
    },
  );
}

export function useDeleteProvider() {
  const { client } = useAuth();
  return useModelsMutation(async (id: string) => {
    await client.request('delete', '/models/providers/{provider_id}', {
      params: { provider_id: id },
    });
    return id;
  });
}

export function useRefreshProvider() {
  const { client } = useAuth();
  return useModelsMutation(
    async (id: string) =>
      (
        await client.request('post', '/models/providers/{provider_id}/refresh', {
          params: { provider_id: id },
        })
      ).data,
  );
}

export interface TestResult {
  ok: boolean;
  message: string | null;
  duration_ms: number;
}

/** A failure is a `200` with `ok: false`; the screen shows the provider's own words. */
export function useTestProvider() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('post', '/models/providers/{provider_id}/test', {
          params: { provider_id: id },
        })
      ).data as TestResult,
    onSuccess: () => {
      // The provider is the same row in every profile (contract decision §34).
      void queryClient.invalidateQueries({ queryKey: ['models', 'providers'] });
    },
  });
}

export interface ModelRef {
  provider_id: string;
  model: string;
}

export function useSaveDefaults() {
  const { client } = useAuth();
  return useModelsMutation(
    async (body: { default?: ModelRef | null; assignments?: Record<string, ModelRef | null> }) =>
      (await client.request('put', '/models/defaults', { body })).data as ModelDefaults,
  );
}

/** `<provider_id>|<model>` — one string a picker can carry for a `ModelRef`. */
export function refValue(ref: ModelRef | null | undefined): string {
  return ref ? `${ref.provider_id}|${ref.model}` : '';
}

export function parseRef(value: string): ModelRef | null {
  const separator = value.indexOf('|');
  if (separator <= 0) return null;
  return { provider_id: value.slice(0, separator), model: value.slice(separator + 1) };
}

// -------------------------------------------------------------------- speech (§54)

export interface SpeechChoice {
  kind: 'stt' | 'tts';
  providerId: string | null;
  /** The chosen provider's settings; only what the person can edit here. */
  settings?: { model?: string | null; language?: string | null; voice?: string | null };
}

/** Choose the profile's STT or TTS provider and set its model, language or voice. */
export function useUpdateSpeech() {
  const { client } = useAuth();
  return useModelsMutation(async ({ kind, providerId, settings }: SpeechChoice) => {
    const body = {
      ...(kind === 'stt' ? { stt_provider_id: providerId } : { tts_provider_id: providerId }),
      ...(providerId && settings ? { providers: [{ id: providerId, settings }] } : {}),
    };
    return (await client.request('patch', '/models/speech', { body })).data as SpeechSettings;
  });
}

/** The voices a TTS provider lists; empty for one that takes a free-form voice id. */
export function useVoices(providerId: string | null) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['models', 'voices', profile, providerId] as const,
    queryFn: async () =>
      (
        await client.request('get', '/models/speech/voices', {
          query: { provider_id: providerId as string },
        })
      ).data.items as { id: string; name: string; language: string | null }[],
    enabled: !!session && !!providerId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
