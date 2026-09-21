/**
 * `ProviderAdapter` — the one interface the models service sees for a provider's HTTP
 * surface. Four verbs, each of which either did a real thing or says why it could not:
 *
 *     adapter.test(ctx)        -> one small authenticated request; `ok` is the truth
 *     adapter.listModels(ctx)  -> the provider's own model list, or `supported: false`
 *     adapter.listVoices(ctx)  -> a TTS provider's voices, or `supported: false`
 *     adapter.synthesize(ctx)  -> audio bytes, or `supported: false`
 *
 * There is deliberately no "assume it worked" path: `test` returning `ok: true` means a
 * request left this process and the provider answered it.
 *
 * `fetchImpl` is always injected, so every adapter test in this repository runs against a
 * scripted response and the suite never reaches the network.
 */
import type { ModelCapability, ModelKind, ModelPricing } from '../schema.js';

/** Everything an adapter needs about the provider row it is acting for. */
export interface ProviderContext {
  slug: string;
  label: string;
  baseUrl: string;
  /** Plaintext, resolved from the secret store at the moment of the call. Never logged. */
  apiKey: string | null;
  headers: Record<string, string>;
  /** STT/TTS settings of the provider row (model, language, voice). */
  settings: { model?: string | null; language?: string | null; voice?: string | null };
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export interface ProviderTestResult {
  ok: boolean;
  /**
   * A machine-readable reason, translated by the route
   * (`i18n` key `models.test.<reason>`): `ok`, `no_key`, `unauthorized`,
   * `rate_limited`, `unreachable`, `http_error`, `unsupported`.
   */
  reason: string;
  /** The provider's own words when it sent any, trimmed. Never the key. */
  detail: string | null;
  status: number | null;
  durationMs: number;
}

/** One model as the provider describes it. Everything optional is genuinely unknown. */
export interface DiscoveredModel {
  /** The provider's own id, e.g. `claude-sonnet-4-5`. */
  key: string;
  label: string;
  kind: ModelKind;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: ModelCapability[];
  /** Only when the provider reports prices (OpenRouter does; most do not). */
  pricing?: ModelPricing;
  preview?: boolean;
}

export type ListModelsResult =
  { supported: true; models: DiscoveredModel[] } | { supported: false; reason: string };

export interface DiscoveredVoice {
  id: string;
  name: string;
  language: string | null;
  gender: 'female' | 'male' | 'neutral' | null;
}

export type ListVoicesResult =
  { supported: true; voices: DiscoveredVoice[] } | { supported: false; reason: string };

export interface SynthesizeRequest {
  text: string;
  language: string | null;
  voice: string | null;
}

export type SynthesizeResult =
  | { supported: true; audio: Uint8Array; contentType: string }
  | { supported: false; reason: string; detail?: string | null };

export interface ProviderAdapter {
  readonly protocol: string;
  test(ctx: ProviderContext): Promise<ProviderTestResult>;
  listModels(ctx: ProviderContext): Promise<ListModelsResult>;
  listVoices(ctx: ProviderContext): Promise<ListVoicesResult>;
  synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult>;
}
