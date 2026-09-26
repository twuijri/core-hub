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
import { detailOf, joinUrl, reasonOf, requestBytes, requestForm, requestJson } from './http.js';
import { chatFailure, openStream, parseFrame, sseData } from './stream.js';
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
  DiscoveredModel,
} from './types.js';
import type { ModelCapability, ModelKind, ModelPricing } from '../schema.js';
import { documentedVoices } from '../speech/documented.js';

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
  // Groq names its speech models after the model family, not the task (`canopylabs/orpheus-…`).
  if (lower.includes('tts') || lower.includes('speech') || lower.includes('orpheus')) return 'tts';
  return 'chat';
}

interface OpenAiModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
  architecture?: { input_modalities?: unknown; output_modalities?: unknown; modality?: unknown };
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
  // A model that answers with pictures (decision §72): what the Images tab offers.
  const outputs = raw.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.includes('image')) capabilities.push('image_output');
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

// ------------------------------------------------------------------- streamed chat

/** A `chat/completions` message, in the two shapes the surface accepts. */
function chatMessage(message: ChatMessage): Record<string, unknown> {
  if (!message.images || message.images.length === 0) {
    return { role: message.role, content: message.text };
  }
  // The multimodal shape: an array of parts. Used only when there is an image, because
  // some OpenAI-compatible servers accept only the plain-string form.
  return {
    role: message.role,
    content: [
      ...(message.text ? [{ type: 'text', text: message.text }] : []),
      ...message.images.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${image.mime};base64,${image.dataBase64}` },
      })),
    ],
  };
}

interface OpenAiChatFrame {
  choices?: { delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
  error?: { message?: unknown } | string;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One turn against `POST {base}/chat/completions` with `stream: true` — the surface
 * OpenAI defined and every "OpenAI-compatible" endpoint copied, which is why this one
 * function serves OpenAI, OpenRouter, Groq, Mistral, DeepSeek, xAI, LM Studio, LiteLLM,
 * cli-proxy-api, a typed-in endpoint, and Ollama's own `/v1` (ADR 0012).
 *
 * `stream_options.include_usage` asks for the token totals in a final frame. A server
 * that ignores the field simply sends no usage, and the turn reports none rather than
 * an invented number.
 */
export async function* openAiChat(
  ctx: ProviderContext,
  request: ChatRequest,
  options: { baseUrl?: string } = {},
): AsyncIterable<ChatEvent> {
  if (!ctx.apiKey && ctx.requiresKey !== false) {
    yield { type: 'failed', reason: 'no_key', detail: null, status: null };
    return;
  }
  const open = await openStream({
    url: joinUrl(options.baseUrl ?? ctx.baseUrl, 'chat/completions'),
    headers: authHeaders(ctx),
    body: {
      model: request.model,
      messages: request.messages.map(chatMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.reasoningEffort && request.reasoningEffort !== 'none'
        ? { reasoning_effort: request.reasoningEffort }
        : {}),
    },
    fetchImpl: ctx.fetchImpl,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!open.ok) {
    yield chatFailure(open);
    return;
  }
  for await (const payload of sseData(open.lines)) {
    const frame = parseFrame(payload) as OpenAiChatFrame | null;
    if (!frame) continue;
    // Some gateways report a mid-stream failure as a frame rather than a status.
    const inline =
      typeof frame.error === 'string'
        ? frame.error
        : typeof frame.error?.message === 'string'
          ? frame.error.message
          : null;
    if (inline) {
      yield { type: 'failed', reason: 'http_error', detail: inline.slice(0, 500), status: null };
      return;
    }
    const delta = frame.choices?.[0]?.delta;
    const text = textOf(delta?.content);
    if (text) yield { type: 'delta', text };
    const reasoning = textOf(delta?.reasoning) || textOf(delta?.reasoning_content);
    if (reasoning) yield { type: 'reasoning', text: reasoning };
    if (frame.usage) {
      const usage: Extract<ChatEvent, { type: 'usage' }> = { type: 'usage' };
      const input = count(frame.usage.prompt_tokens);
      const output = count(frame.usage.completion_tokens);
      const cached = count(frame.usage.prompt_tokens_details?.cached_tokens);
      const reasoned = count(frame.usage.completion_tokens_details?.reasoning_tokens);
      // `prompt_tokens` counts the cached part too; the hub's input is what was not cached
      // (types.ts), so a cached token is neither billed twice nor hidden in the hit rate.
      if (input !== undefined) usage.inputTokens = Math.max(0, input - (cached ?? 0));
      if (output !== undefined) usage.outputTokens = output;
      if (cached !== undefined) usage.cacheReadTokens = cached;
      if (reasoned !== undefined) usage.reasoningTokens = reasoned;
      yield usage;
    }
  }
  if (request.signal?.aborted) {
    yield { type: 'failed', reason: 'cancelled', detail: null, status: null };
    return;
  }
  yield { type: 'completed' };
}

export const openAiAdapter: ProviderAdapter = {
  protocol: 'openai',

  chat(ctx: ProviderContext, request: ChatRequest): AsyncIterable<ChatEvent> {
    return openAiChat(ctx, request);
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    // Only a provider that *requires* a key is told it is missing one. A local server
    // (LM Studio, LiteLLM, somebody's own proxy) is asked without one, and if it does
    // want a key its own 401 says so — in its own words, not ours.
    if (!ctx.apiKey && ctx.requiresKey !== false) {
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

  listVoices(ctx: ProviderContext): Promise<ListVoicesResult> {
    // OpenAI's voices are a fixed set named in its documentation, not an endpoint: the
    // documented list is answered and labelled as such (decision §91). Somebody's own
    // OpenAI-compatible speech server has neither, and its voice is typed by hand.
    return Promise.resolve(
      documentedVoices(ctx.slug) ?? {
        supported: false,
        reason: 'this provider has no voice list endpoint; type the voice id',
      },
    );
  },

  async synthesize(ctx: ProviderContext, request: SynthesizeRequest): Promise<SynthesizeResult> {
    // A self-hosted OpenAI-compatible speech server is added without a key (the hub does
    // not demand one); it is asked without one, and its own answer stands.
    if (!ctx.apiKey && ctx.requiresKey !== false) return { supported: false, reason: 'no_key' };
    const voice = request.voice ?? ctx.settings.voice ?? null;
    if (!voice) return { supported: false, reason: 'no_voice' };
    const answer = await requestBytes({
      url: joinUrl(ctx.baseUrl, 'audio/speech'),
      method: 'POST',
      headers: { ...authHeaders(ctx), accept: 'audio/mpeg' },
      body: {
        model: request.model ?? ctx.settings.model ?? 'gpt-4o-mini-tts',
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
  /**
   * `POST {base}/audio/transcriptions` (OpenAI's Whisper surface, which every
   * OpenAI-compatible speech server copies): the recording as the `file` part, the row's
   * model, and the language hint when there is one. `response_format: json` is the one
   * format all of them accept; a `language` or `duration` in the answer is read when the
   * server sends it (the verbose servers do) and left null when not.
   */
  async transcribe(ctx: ProviderContext, request: TranscribeRequest): Promise<TranscribeResult> {
    if (!ctx.apiKey && ctx.requiresKey !== false) return { supported: false, reason: 'no_key' };
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(request.audio)], { type: request.mime }),
      request.filename,
    );
    form.append('model', ctx.settings.model ?? 'whisper-1');
    // Whisper takes ISO-639-1 (`ar`), not a full BCP-47 tag (`ar-SA`).
    const hint = (request.language ?? ctx.settings.language ?? '').split('-')[0]?.toLowerCase();
    if (hint) form.append('language', hint);
    form.append('response_format', 'json');
    const answer = await requestForm({
      url: joinUrl(ctx.baseUrl, 'audio/transcriptions'),
      headers: authHeaders(ctx),
      form,
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok) {
      return { supported: false, reason: reasonOf(answer), detail: detailOf(answer) };
    }
    const body = answer.body as { text?: unknown; language?: unknown; duration?: unknown } | null;
    if (typeof body?.text !== 'string') {
      return {
        supported: false,
        reason: 'http_error',
        detail: 'the provider did not answer with a transcript',
      };
    }
    const seconds = typeof body.duration === 'number' ? body.duration : Number.NaN;
    return {
      supported: true,
      text: body.text.trim(),
      language: typeof body.language === 'string' && body.language ? body.language : hint || null,
      durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
    };
  },
};
