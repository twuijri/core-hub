/**
 * The OpenAI-shaped adapter: OpenAI itself and every provider that copied its
 * `GET /models` and `Authorization: Bearer` surface — OpenRouter, Groq, Mistral,
 * DeepSeek, xAI, and any "OpenAI-compatible" endpoint a person adds by hand.
 *
 * `GET {base}/models` is the connectivity check *and* the catalogue: one authenticated
 * request that proves the key works and returns what the account may use. Nothing is
 * inferred — a provider that answers with an empty list gets an empty catalogue.
 *
 * OpenRouter is the one provider here that reports prices and context windows, so those
 * fields are read when present and left null when not.
 */
import { detailOf, joinUrl, reasonOf, requestBytes, requestJson } from './http.js';
import type {
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SynthesizeRequest,
  SynthesizeResult,
  DiscoveredModel,
} from './types.js';
import type { ModelCapability, ModelKind, ModelPricing } from '../schema.js';

function authHeaders(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
    ...ctx.headers,
  };
}

/** USD per token, as a decimal string, to integer micro-USD per million tokens. */
export function perMillionMicroUsd(perToken: unknown): number | undefined {
  if (typeof perToken !== 'string' && typeof perToken !== 'number') return undefined;
  const value = Number(perToken);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000 * 1_000_000);
}

function kindOf(id: string): ModelKind {
  const lower = id.toLowerCase();
  if (lower.includes('embedding') || lower.includes('embed')) return 'embedding';
  if (lower.includes('whisper') || lower.includes('transcribe')) return 'stt';
  if (lower.includes('tts') || lower.includes('speech')) return 'tts';
  return 'chat';
}

interface OpenAiModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
  architecture?: { input_modalities?: unknown; modality?: unknown };
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown };
}

/** OpenRouter's extra fields, read when present. Everything else stays unknown. */
function enrich(raw: OpenAiModel, model: DiscoveredModel): DiscoveredModel {
  const contextWindow =
    numberOf(raw.context_length) ?? numberOf(raw.top_provider?.context_length) ?? null;
  const maxOutput = numberOf(raw.top_provider?.max_completion_tokens) ?? null;
  const capabilities: ModelCapability[] = [];
  const modalities = raw.architecture?.input_modalities;
  if (Array.isArray(modalities) && modalities.includes('image')) capabilities.push('vision');
  const parameters = raw.supported_parameters;
  if (Array.isArray(parameters)) {
    if (parameters.includes('tools')) capabilities.push('tools');
    if (parameters.includes('reasoning') || parameters.includes('include_reasoning')) {
      capabilities.push('reasoning');
    }
  }
  const pricing: ModelPricing = {};
  const input = perMillionMicroUsd(raw.pricing?.prompt);
  const output = perMillionMicroUsd(raw.pricing?.completion);
  const cacheRead = perMillionMicroUsd(raw.pricing?.input_cache_read);
  if (input !== undefined) pricing.inputPerMillion = input;
  if (output !== undefined) pricing.outputPerMillion = output;
  if (cacheRead !== undefined) pricing.cacheReadPerMillion = cacheRead;
  return {
    ...model,
    ...(contextWindow !== null ? { contextWindow } : {}),
    ...(maxOutput !== null ? { maxOutputTokens: maxOutput } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(Object.keys(pricing).length > 0 ? { pricing } : {}),
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

export const openAiAdapter: ProviderAdapter = {
  protocol: 'openai',

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!ctx.apiKey) {
      return { ok: false, reason: 'no_key', detail: null, status: null, durationMs: 0 };
    }
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'models'),
      headers: authHeaders(ctx),
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    return {
      ok: answer.ok,
      reason: reasonOf(answer),
      detail: answer.ok ? null : detailOf(answer),
      status: answer.status,
      durationMs: answer.durationMs,
    };
  },

  async listModels(ctx: ProviderContext): Promise<ListModelsResult> {
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'models'),
      headers: authHeaders(ctx),
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
    const data = (answer.body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      return { supported: false, reason: 'the provider did not answer with a model list' };
    }
    const models: DiscoveredModel[] = [];
    for (const item of data as OpenAiModel[]) {
      const id = typeof item?.id === 'string' ? item.id : null;
      if (!id) continue;
      const label = typeof item.name === 'string' && item.name ? item.name : id;
      models.push(enrich(item, { key: id, label, kind: kindOf(id) }));
    }
    return { supported: true, models };
  },

  listVoices(_ctx: ProviderContext): Promise<ListVoicesResult> {
    // OpenAI's voices are a fixed set named in its documentation, not an endpoint. The
    // contract allows an empty list for "providers that take free-form voice ids", which
    // is the honest answer: the field is typed by hand.
    return Promise.resolve({
      supported: false,
      reason: 'this provider has no voice list endpoint; type the voice id',
    });
  },

  async synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult> {
    if (!ctx.apiKey) return { supported: false, reason: 'no_key' };
    const voice = request.voice ?? ctx.settings.voice ?? null;
    if (!voice) return { supported: false, reason: 'no_voice' };
    const answer = await requestBytes({
      url: joinUrl(ctx.baseUrl, 'audio/speech'),
      method: 'POST',
      headers: { ...authHeaders(ctx), accept: 'audio/mpeg' },
      body: {
        model: ctx.settings.model ?? 'gpt-4o-mini-tts',
        input: request.text,
        voice,
        response_format: 'mp3',
      },
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok || !answer.bytes) {
      return {
        supported: false,
        reason: answer.error ? 'unreachable' : 'http_error',
        detail: answer.detail ?? answer.error,
      };
    }
    return {
      supported: true,
      audio: answer.bytes,
      contentType: answer.contentType ?? 'audio/mpeg',
    };
  },
};
