/**
 * Google's Generative Language API: the key travels in the `x-goog-api-key` header (not
 * the query string, where it would land in every proxy log), and `GET /models` is both
 * the connectivity check and the catalogue
 * (<https://ai.google.dev/api/models#method:-models.list>).
 *
 * Google names a model `models/gemini-2.5-pro`; the hub stores the part after the slash,
 * which is what a person types and what a run sends.
 */
import { detailOf, joinUrl, reasonOf, requestJson } from './http.js';
import { chatFailure, openStream, parseFrame, sseData } from './stream.js';
import type {
  ChatEvent,
  ChatRequest,
  DiscoveredModel,
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SynthesizeResult,
} from './types.js';
import type { ModelCapability, ModelKind } from '../schema.js';

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { 'x-goog-api-key': ctx.apiKey } : {}),
    ...ctx.headers,
  };
}

interface GoogleModel {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
}

function kindOf(methods: unknown, id: string): ModelKind {
  const list = Array.isArray(methods) ? (methods as string[]) : [];
  if (list.includes('embedContent') || id.includes('embedding')) return 'embedding';
  return 'chat';
}

// ------------------------------------------------------------------- streamed chat

interface GoogleFrame {
  candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] } }[];
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
  };
  error?: { message?: unknown };
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * One turn against `POST {base}/models/{id}:streamGenerateContent?alt=sse`
 * (<https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent>).
 *
 * `alt=sse` is not decoration: without it the endpoint answers with a streamed JSON
 * *array*, which cannot be parsed frame by frame.
 *
 * Gemini's roles are `user` and `model`; a `system` message goes in
 * `systemInstruction`, not in the turn list.
 */
export async function* googleChat(
  ctx: ProviderContext,
  request: ChatRequest,
): AsyncIterable<ChatEvent> {
  if (!ctx.apiKey && ctx.requiresKey !== false) {
    yield { type: 'failed', reason: 'no_key', detail: null, status: null };
    return;
  }
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.text)
    .filter(Boolean)
    .join('\n\n');
  const contents = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [
        ...(message.text ? [{ text: message.text }] : []),
        ...(message.images ?? []).map((image) => ({
          inline_data: { mime_type: image.mime, data: image.dataBase64 },
        })),
      ],
    }));
  const open = await openStream({
    url: joinUrl(
      ctx.baseUrl,
      `models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
    ),
    headers: headers(ctx),
    body: {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(request.maxOutputTokens
        ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } }
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
    const frame = parseFrame(payload) as GoogleFrame | null;
    if (!frame) continue;
    if (frame.error) {
      const detail = typeof frame.error.message === 'string' ? frame.error.message : null;
      yield {
        type: 'failed',
        reason: 'http_error',
        detail: detail?.slice(0, 500) ?? null,
        status: null,
      };
      return;
    }
    for (const part of frame.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part?.text !== 'string' || !part.text) continue;
      // Gemini marks a reasoning part with `thought: true` and puts the text in the
      // same field, so the flag is the only thing that separates the two.
      yield part.thought === true
        ? { type: 'reasoning', text: part.text }
        : { type: 'delta', text: part.text };
    }
    const usage = frame.usageMetadata;
    if (usage) {
      const event: Extract<ChatEvent, { type: 'usage' }> = { type: 'usage' };
      const input = count(usage.promptTokenCount);
      const output = count(usage.candidatesTokenCount);
      const cached = count(usage.cachedContentTokenCount);
      const thoughts = count(usage.thoughtsTokenCount);
      if (input !== undefined) event.inputTokens = input;
      if (output !== undefined) event.outputTokens = output;
      if (cached !== undefined) event.cacheReadTokens = cached;
      if (thoughts !== undefined) event.reasoningTokens = thoughts;
      yield event;
    }
  }
  if (request.signal?.aborted) {
    yield { type: 'failed', reason: 'cancelled', detail: null, status: null };
    return;
  }
  yield { type: 'completed' };
}

export const googleAdapter: ProviderAdapter = {
  protocol: 'google',

  chat(ctx: ProviderContext, request: ChatRequest): AsyncIterable<ChatEvent> {
    return googleChat(ctx, request);
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!ctx.apiKey) {
      return { ok: false, reason: 'no_key', detail: null, status: null, durationMs: 0 };
    }
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'models?pageSize=1'),
      headers: headers(ctx),
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
    const models: DiscoveredModel[] = [];
    let url = joinUrl(ctx.baseUrl, 'models?pageSize=200');
    for (let page = 0; page < 10; page += 1) {
      const answer = await requestJson({
        url,
        headers: headers(ctx),
        fetchImpl: ctx.fetchImpl,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      });
      if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
      const body = answer.body as { models?: GoogleModel[]; nextPageToken?: unknown } | null;
      if (!Array.isArray(body?.models)) {
        return { supported: false, reason: 'the provider did not answer with a model list' };
      }
      for (const item of body.models) {
        const name = typeof item?.name === 'string' ? item.name : null;
        if (!name) continue;
        const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
        const capabilities: ModelCapability[] = ['tools', 'streaming'];
        const contextWindow =
          typeof item.inputTokenLimit === 'number' ? Math.trunc(item.inputTokenLimit) : null;
        const maxOutput =
          typeof item.outputTokenLimit === 'number' ? Math.trunc(item.outputTokenLimit) : null;
        models.push({
          key: id,
          label: typeof item.displayName === 'string' && item.displayName ? item.displayName : id,
          kind: kindOf(item.supportedGenerationMethods, id),
          ...(contextWindow !== null ? { contextWindow } : {}),
          ...(maxOutput !== null ? { maxOutputTokens: maxOutput } : {}),
          capabilities,
        });
      }
      const token = body.nextPageToken;
      if (typeof token !== 'string' || !token) break;
      url = joinUrl(ctx.baseUrl, `models?pageSize=200&pageToken=${encodeURIComponent(token)}`);
    }
    return { supported: true, models };
  },

  listVoices(): Promise<ListVoicesResult> {
    return Promise.resolve({
      supported: false,
      reason: 'the hub does not drive this provider for speech yet',
    });
  },

  synthesize(): Promise<SynthesizeResult> {
    return Promise.resolve({
      supported: false,
      reason: 'the hub does not drive this provider for speech yet',
    });
  },
};
