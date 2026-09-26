/**
 * `ProviderAdapter` — the one interface the models service sees for a provider's HTTP
 * surface. Five verbs, each of which either did a real thing or says why it could not:
 *
 *     adapter.test(ctx)        -> one small authenticated request; `ok` is the truth
 *     adapter.listModels(ctx)  -> the provider's own model list, or `supported: false`
 *     adapter.listVoices(ctx)  -> a TTS provider's voices, or `supported: false`
 *     adapter.synthesize(ctx)  -> audio bytes, or `supported: false`
 *     adapter.transcribe(ctx)  -> a transcript, or `supported: false` (optional: only the
 *                                 OpenAI-shaped surface has one the hub drives today)
 *     adapter.chat(ctx, req)   -> a streamed turn, for the `direct` agent
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
  /**
   * Whether this provider *requires* a key. Default `true`, because most do.
   *
   * When it is false the adapter asks with no key and reports whatever the endpoint
   * answers — including its 401 if it does want one after all. An adapter must never
   * invent "no API key" for a provider the hub did not demand a key from: that is the
   * contradiction the owner hit on 2026-09-22 (a card badged "No key needed" and, on the
   * same card, a red "Missing API key").
   */
  requiresKey?: boolean;
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
  | {
      supported: true;
      models: DiscoveredModel[];
      /**
       * `fallback` when the list is not the provider's answer (decision §83) — for a speech
       * provider with no model endpoint, its documented list (§94), with `reason` saying so.
       */
      source?: 'provider' | 'fallback';
      reason?: string;
    }
  | { supported: false; reason: string };

export interface DiscoveredVoice {
  id: string;
  name: string;
  language: string | null;
  gender: 'female' | 'male' | 'neutral' | null;
  /** The provider's own short words about the voice (accent, style), when it gives any. */
  description?: string | null;
  /** The models this voice speaks with; absent is every model of the provider. */
  models?: readonly string[] | null;
}

/**
 * Where a voice list came from (DECISIONS §94): the provider's own endpoint, or — for a
 * provider that has none — its public documentation (`speech/documented.ts`).
 */
export type VoiceSource = 'provider' | 'documented';

export type ListVoicesResult =
  | { supported: true; voices: DiscoveredVoice[]; source?: VoiceSource }
  | { supported: false; reason: string };

/** `SpeechFormat` in the contract: the audio a client can play (`ogg` is Ogg Opus). */
export type SpeechFormat = 'mp3' | 'aac' | 'wav' | 'ogg';

export interface SynthesizeRequest {
  text: string;
  language: string | null;
  voice: string | null;
  /** Overrides the row's model for this request (the Models page's preview). */
  model?: string | null;
  /**
   * The audio the client asked for (`SpeechRequest.format`, DECISIONS §91). An adapter asks
   * its provider for it when the provider lets it choose; otherwise it returns its own format
   * and says so in `contentType`. Absent or null: the adapter's default.
   */
  format?: SpeechFormat | null;
}

export type SynthesizeResult =
  | { supported: true; audio: Uint8Array; contentType: string }
  | { supported: false; reason: string; detail?: string | null };

export interface TranscribeRequest {
  /** The recording exactly as the client sent it. */
  audio: Uint8Array;
  /** The name the provider sees; its extension is how OpenAI-shaped servers tell the format. */
  filename: string;
  mime: string;
  /** A BCP-47 hint (`ar`, `en`); null lets the provider detect it. */
  language: string | null;
}

export type TranscribeResult =
  | {
      supported: true;
      text: string;
      /** What the provider detected or was told; null when it said nothing. */
      language: string | null;
      /** How long the provider says the take was; null when it did not say. */
      durationMs: number | null;
    }
  | { supported: false; reason: string; detail?: string | null };

// ------------------------------------------------------------------- streamed chat

/** An image handed to the model inline, already read off disk by the caller. */
export interface ChatImage {
  mime: string;
  /** Base64 of the file's bytes, with no `data:` prefix. */
  dataBase64: string;
  name: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
  /** Only ever set on a `user` message, and only for a model that accepts images. */
  images?: ChatImage[];
}

export interface ChatRequest {
  /** The provider's own model id, never the catalogue's `"<slug>/<model>"` key. */
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: string | null;
  /** Aborting it closes the socket; the stream then ends as `cancelled`. */
  signal?: AbortSignal;
  maxOutputTokens?: number | null;
}

/**
 * Why a streamed turn stopped, in the vocabulary the service maps to the contract's
 * error codes. It is deliberately the same list `ProviderTestResult.reason` uses, plus
 * the two a turn can hit that a connectivity check cannot.
 */
export type ChatFailureReason =
  | 'no_key'
  | 'unauthorized'
  | 'rate_limited'
  | 'unreachable'
  | 'http_error'
  | 'unsupported'
  | 'model_not_found'
  | 'cancelled';

/**
 * One streamed item of a direct turn. Deliberately smaller than `AgentEvent`: there are
 * no tools on this path (ADOPTION-BACKLOG §2.16), so there is nothing to approve and
 * nothing to report running.
 */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      /**
       * Cumulative totals for the turn. `inputTokens` are the prompt tokens **not** served
       * from or written to the cache (Anthropic's convention); an adapter whose provider
       * counts the cached part in its prompt total subtracts it. Cost estimates and the
       * trajectory's cache hit rate both rely on it.
       */
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
    }
  | { type: 'completed' }
  | {
      type: 'failed';
      reason: ChatFailureReason;
      /** The provider's own words, kept verbatim and capped. Null when it sent none. */
      detail: string | null;
      status: number | null;
    };

export interface ProviderAdapter {
  readonly protocol: string;
  test(ctx: ProviderContext): Promise<ProviderTestResult>;
  listModels(ctx: ProviderContext): Promise<ListModelsResult>;
  listVoices(ctx: ProviderContext): Promise<ListVoicesResult>;
  synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult>;
  /** Speech to text. Absent on a protocol the hub cannot transcribe with. */
  transcribe?(ctx: ProviderContext, request: TranscribeRequest): Promise<TranscribeResult>;
  /**
   * One streamed turn against the provider's chat surface, for the `direct` agent.
   *
   * Never throws: every way this can go wrong is a final `failed` event, so the run
   * loop that consumes it has one shape to handle.
   */
  chat(ctx: ProviderContext, request: ChatRequest): AsyncIterable<ChatEvent>;
}

/** The `chat` of a provider that is not a chat provider at all. */
export async function* chatUnsupported(why: string): AsyncIterable<ChatEvent> {
  yield { type: 'failed', reason: 'unsupported', detail: why, status: null };
}
