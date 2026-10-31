// The `models` screen's reads and writes, over the generated client (ADR 0003).
// Every key carries the workspace slug, so switching the chip refetches (NAVIGATION rule 4).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HubApiError } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import type {
  ProviderAccount,
  ProviderAccounts,
  ProviderMove,
  SubscriptionVendors,
  Model,
  ModelDefaults,
  Provider,
  ProviderHost,
  ProviderPreset,
  ProviderProbeResult,
  ProviderSignIn,
  LocalModels,
  LocalRuntime,
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
  localRuntime: (profile: string) => ['models', 'local-runtime', profile] as const,
  localModels: (profile: string) => ['models', 'local-models', profile] as const,
};

export function useProviders() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.providers(profile),
    queryFn: async () =>
      (await client.request('get', '/models/providers')).data.items as Provider[],
    enabled: !!session,
    // A model list being fetched (a refresh the hub started itself, such as after a local model
    // download) is followed until it lands.
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.catalogue.status === 'loading') ? 2_000 : false,
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
    // The hub restarts Hermes by itself after a change (DECISIONS §145): while that restart is
    // on its way, ask again until it has happened, so the card turns green on its own.
    refetchInterval: (query) =>
      restartOnItsWay(query.state.data as RuntimeReport | undefined) ? RUNTIME_POLL_MS : false,
  });
}

/** How often a report whose automatic restart is on its way is asked again. */
const RUNTIME_POLL_MS = 2_000;

/** Whether the hub said its own restart of Hermes is scheduled or waiting for a reply. */
export function restartOnItsWay(report: RuntimeReport | undefined): boolean {
  const check = report?.checks?.find((each) => each.id === 'gateway_reloaded');
  return (
    !!check && !check.ok && (check.detail === 'scheduled' || check.detail === 'waiting_for_run')
  );
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
    // Every page, not the first: a hub with OpenRouter has more than one page of models, and
    // a model past the first was missing from every picker (the fallback list among them).
    queryFn: async () => {
      const models: Model[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < CATALOGUE_MAX_PAGES; page += 1) {
        const data = (
          await client.request('get', '/models', {
            query: { limit: 200, ...(cursor ? { cursor } : {}) },
          })
        ).data as { items: Model[]; next_cursor?: string | null };
        models.push(...data.items);
        cursor = data.next_cursor ?? null;
        if (!cursor) break;
      }
      return models;
    },
    enabled: !!session,
  });
}

/** 200 models a page: ten pages is a catalogue of 2 000, far past any provider's list. */
const CATALOGUE_MAX_PAGES = 10;

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
    async (body: {
      default?: ModelRef | null;
      /** The image model (decision §72); null goes back to inheriting. */
      image?: ModelRef | null;
      /** The chat model's fallback chain, in order (contract decision §54). */
      fallbacks?: ModelRef[];
      assignments?: Record<string, ModelRef | null>;
    }) => (await client.request('put', '/models/defaults', { body })).data as ModelDefaults,
  );
}

/** Starts a device-code sign-in for a provider used by signing in (contract decision §55). */
export function useStartSignIn() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (providerId: string) =>
      (
        await client.request('post', '/models/providers/{provider_id}/sign-in', {
          params: { provider_id: providerId },
        })
      ).data as ProviderSignIn,
  });
}

/** How often a pending sign-in is asked about: Hermes itself polls the provider every 5 s. */
export const SIGN_IN_POLL_MS = 3000;

/**
 * Polls a sign-in until it is no longer `pending`. On `approved` the provider list is read
 * again, so the card says it is signed in and its models arrive.
 */
export function useSignInStatus(providerId: string, signInId: string | null) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['models', 'sign-in', profile, providerId, signInId] as const,
    enabled: signInId !== null,
    queryFn: async () => {
      const signIn = (
        await client.request('get', '/models/providers/{provider_id}/sign-in/{sign_in_id}', {
          params: { provider_id: providerId, sign_in_id: signInId as string },
        })
      ).data as ProviderSignIn;
      if (signIn.status === 'approved') {
        // The card and the pickers, not this query: it would ask again, and again.
        for (const key of ['providers', 'catalogue', 'defaults']) {
          void queryClient.invalidateQueries({ queryKey: ['models', key] });
        }
      }
      return signIn;
    },
    refetchInterval: (query) =>
      !query.state.data || query.state.data.status === 'pending' ? SIGN_IN_POLL_MS : false,
  });
}

/** `<provider_id>|<model>` — one string a picker can carry for a `ModelRef`. */
/**
 * The models a chat can be held with: chat models, less the ones that only draw (contract
 * decision §87 — `gpt-image-*`, DALL·E, FLUX …, which fail a chat turn). Every chat-model
 * picker lists these: the composer, the defaults, the fallback chain, a provider's default, a
 * workflow step. The image-only ones are offered on the Images tab alone.
 */
export function chatModels<T extends Pick<Model, 'kind' | 'image_only'>>(
  models: readonly T[],
): T[] {
  return models.filter((model) => model.kind === 'chat' && model.image_only !== true);
}

export function refValue(ref: ModelRef | null | undefined): string {
  return ref ? `${ref.provider_id}|${ref.model}` : '';
}

export function parseRef(value: string): ModelRef | null {
  const separator = value.indexOf('|');
  if (separator <= 0) return null;
  return { provider_id: value.slice(0, separator), model: value.slice(separator + 1) };
}

// -------------------------------------------------------------------- speech (§63)

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

/** One voice as `models.listVoices` answers it (DECISIONS §94). */
export interface SpeechVoice {
  id: string;
  name: string;
  language: string | null;
  gender: 'female' | 'male' | 'neutral' | null;
  description?: string | null;
  models?: string[] | null;
}

/**
 * The voices a TTS provider offers, for one model when it is given: the provider's own list,
 * its documented list (`source: documented`) when it has no endpoint, or none (`source:
 * none`) for a provider whose voice is typed by hand.
 */
export function useVoices(providerId: string | null, model?: string | null) {
  const { client, profile, session } = useAuth();
  const wanted = model?.trim() || null;
  return useQuery({
    queryKey: ['models', 'voices', profile, providerId, wanted] as const,
    queryFn: async () =>
      (
        await client.request('get', '/models/speech/voices', {
          query: { provider_id: providerId as string, ...(wanted ? { model: wanted } : {}) },
        })
      ).data as { items: SpeechVoice[]; source: 'provider' | 'documented' | 'none' },
    enabled: !!session && !!providerId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The models of one speech provider, of its own kind, as its catalogue holds them. */
export function useSpeechModels(providerId: string | null, kind: 'stt' | 'tts') {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['models', 'speech-models', profile, providerId, kind] as const,
    queryFn: async () =>
      (
        (
          await client.request('get', '/models', {
            query: { provider_id: providerId as string, kind, limit: 200 },
          })
        ).data as { items: Model[] }
      ).items,
    enabled: !!session && !!providerId,
    staleTime: 60_000,
    retry: false,
  });
}

// ------------------------------------------ subscriptions through the gateway (§143)

/** A hub older than the operation answers 404: the feature is then not offered at all. */
export function isUnsupported(error: unknown): boolean {
  return error instanceof HubApiError && (error.status === 404 || error.status === 501);
}

/** "Sign in with a subscription": the vendors the hub's gateway signs in to. */
export function useSubscriptionVendors() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['models', 'subscription-vendors', profile] as const,
    queryFn: async () =>
      (await client.request('get', '/models/subscription-vendors')).data as SubscriptionVendors,
    enabled: !!session,
    retry: (count, error) => !isUnsupported(error) && count < 2,
  });
}

/** How often the provider dialog reads its accounts again while it is open. */
export const ACCOUNTS_POLL_MS = 15_000;

export function useProviderAccounts(providerId: string, open: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['models', 'accounts', profile, providerId] as const,
    queryFn: async () =>
      (
        await client.request('get', '/models/providers/{provider_id}/accounts', {
          params: { provider_id: providerId },
        })
      ).data as ProviderAccounts,
    enabled: !!session && open,
    refetchInterval: open ? ACCOUNTS_POLL_MS : false,
    retry: (count, error) => !isUnsupported(error) && count < 1,
  });
}

/** After an action on an account: the dialog's list, and the cards' counts. */
function useAccountsChanged() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['models', 'accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['models', 'providers'] });
  };
}

type AccountAction = { providerId: string; accountId: string };

export function useAccountAction(action: 'check' | 'refresh') {
  const { client } = useAuth();
  const changed = useAccountsChanged();
  return useMutation({
    mutationFn: async ({ providerId, accountId }: AccountAction) =>
      (
        await client.request(
          'post',
          action === 'check'
            ? '/models/providers/{provider_id}/accounts/{account_id}/check'
            : '/models/providers/{provider_id}/accounts/{account_id}/refresh',
          { params: { provider_id: providerId, account_id: accountId } },
        )
      ).data as ProviderAccount,
    onSuccess: changed,
  });
}

export function useSetAccountDisabled() {
  const { client } = useAuth();
  const changed = useAccountsChanged();
  return useMutation({
    mutationFn: async ({
      providerId,
      accountId,
      disabled,
    }: AccountAction & { disabled: boolean }) =>
      (
        await client.request('patch', '/models/providers/{provider_id}/accounts/{account_id}', {
          params: { provider_id: providerId, account_id: accountId },
          body: { disabled },
        })
      ).data as ProviderAccount,
    onSuccess: changed,
  });
}

export function useRemoveAccount() {
  const { client } = useAuth();
  const changed = useAccountsChanged();
  return useMutation({
    mutationFn: async ({ providerId, accountId }: AccountAction) => {
      await client.request('delete', '/models/providers/{provider_id}/accounts/{account_id}', {
        params: { provider_id: providerId, account_id: accountId },
      });
    },
    onSuccess: changed,
  });
}

/** The address a link sign-in landed on, pasted back. */
export function useCompleteSignIn() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async ({
      providerId,
      signInId,
      code,
    }: {
      providerId: string;
      signInId: string;
      code: string;
    }) =>
      (
        await client.request('post', '/models/providers/{provider_id}/sign-in/{sign_in_id}', {
          params: { provider_id: providerId, sign_in_id: signInId },
          body: { code },
        })
      ).data as ProviderSignIn,
  });
}

/** "Move this sign-in to Core Hub's gateway": the new provider and its sign-in. */
export function useMoveToGateway() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) =>
      (
        await client.request('post', '/models/providers/{provider_id}/move-to-gateway', {
          params: { provider_id: providerId },
        })
      ).data as ProviderMove,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['models', 'providers'] }),
  });
}

// ------------------------------------------------------ local models (ADR 0032)

/**
 * Ollama on the computer the hub runs on: absent, installed by the hub, or already there.
 * Only the desktop app's own hub answers `available: true`; anywhere else, and for a member
 * (`403`), the card is simply not there, so a refusal is not asked again.
 */
export function useLocalRuntime(enabled: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.localRuntime(profile),
    queryFn: async () =>
      (await client.request('get', '/models/local-runtime')).data as LocalRuntime,
    enabled: !!session && enabled,
    retry: false,
    // A starting Ollama turns running (or error) by itself: asked again until it has.
    refetchInterval: (query) =>
      (query.state.data as LocalRuntime | undefined)?.state === 'starting' ? LOCAL_POLL_MS : false,
  });
}

/** How often a starting Ollama is asked about again. */
const LOCAL_POLL_MS = 2_000;

/** "Check for updates": the newest Ollama release asked for now, not from the last hours. */
export function useCheckLocalRuntime() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await client.request('get', '/models/local-runtime', { query: { fresh: true } }))
        .data as LocalRuntime,
    onSuccess: (runtime) => queryClient.setQueryData(modelKeys.localRuntime(profile), runtime),
  });
}

/** Install and update answer a job; start and stop answer the runtime as it is now. */
export function useLocalRuntimeAction() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: 'install' | 'update' | 'start' | 'stop',
    ): Promise<{ job_id: string } | LocalRuntime> => {
      switch (action) {
        case 'install':
          return (await client.request('post', '/models/local-runtime/install')).data;
        case 'update':
          return (await client.request('post', '/models/local-runtime/update')).data;
        case 'start':
          return (await client.request('post', '/models/local-runtime/start')).data as LocalRuntime;
        case 'stop':
          return (await client.request('post', '/models/local-runtime/stop')).data as LocalRuntime;
      }
    },
    onSuccess: (answer) => {
      if ('available' in answer) {
        queryClient.setQueryData(modelKeys.localRuntime(profile), answer);
      } else {
        void queryClient.invalidateQueries({ queryKey: modelKeys.localRuntime(profile) });
      }
      void queryClient.invalidateQueries({ queryKey: modelKeys.localModels(profile) });
    },
  });
}

/** Remove the Ollama the hub installed; its models go too unless they are kept. */
export function useRemoveLocalRuntime() {
  const { client } = useAuth();
  const changed = useLocalModelsChanged();
  return useMutation({
    mutationFn: async (keepModels: boolean) => {
      await client.request('delete', '/models/local-runtime', {
        query: { keep_models: keepModels },
      });
    },
    onSuccess: changed,
  });
}

/** The local models: installed, loaded now, suggested, and the downloads running now. */
export function useLocalModels(enabled: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: modelKeys.localModels(profile),
    queryFn: async () =>
      (await client.request('get', '/models/local-runtime/models')).data as LocalModels,
    enabled: !!session && enabled,
    retry: false,
  });
}

/**
 * After a model arrives or goes, or Ollama itself: the local lists, and the providers and the
 * catalogue — the hub keeps an `ollama` provider pointed at it, and the pickers list its models.
 */
export function useLocalModelsChanged() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: modelKeys.localRuntime(profile) });
    void queryClient.invalidateQueries({ queryKey: modelKeys.localModels(profile) });
    for (const key of ['providers', 'catalogue', 'runtime'] as const) {
      void queryClient.invalidateQueries({ queryKey: ['models', key] });
    }
  };
}

/** Download a model: a job, followed by the card until it ends. */
export function usePullLocalModel() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      (await client.request('post', '/models/local-runtime/models', { body: { name } })).data,
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: modelKeys.localModels(profile) }),
  });
}

export function useDeleteLocalModel() {
  const { client } = useAuth();
  const changed = useLocalModelsChanged();
  return useMutation({
    mutationFn: async (name: string) => {
      await client.request('delete', '/models/local-runtime/models', { query: { name } });
    },
    onSuccess: changed,
  });
}
