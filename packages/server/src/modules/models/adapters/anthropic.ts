/**
 * Anthropic's own API: `x-api-key` plus a dated `anthropic-version` header, and
 * `GET /v1/models` as both the connectivity check and the catalogue
 * (<https://docs.claude.com/en/api/models-list>).
 *
 * The version header is pinned here rather than configured: a provider row that silently
 * follows whatever Anthropic ships next is a provider row that breaks without a commit.
 */
import { detailOf, joinUrl, reasonOf, requestJson } from './http.js';
import { chatFailure, openStream, parseFrame, sseData } from './stream.js';
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  DiscoveredModel,
  ListModelsResult,
  ListVoicesResult,
  ProviderAdapter,
  ProviderContext,
  ProviderTestResult,
  SynthesizeResult,
} from './types.js';

/** Pinned; bumping it is a reviewed change, never a runtime surprise. */
export const ANTHROPIC_VERSION = '2023-06-01';

function headers(ctx: ProviderContext): Record<string, string> {
  return {
    ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
    ...ctx.headers,
  };
}

// ------------------------------------------------------------------- streamed chat

/**
 * Anthropic has no `max_tokens`-less mode: the field is required on `/v1/messages`. This
 * is the ceiling used when the caller names none, and it is a ceiling, not a target.
 */
const DEFAULT_MAX_TOKENS = 8_192;

function content(message: ChatMessage): unknown {
  if (!message.images || message.images.length === 0) return message.text;
  return [
    ...message.images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mime, data: image.dataBase64 },
    })),
    ...(message.text ? [{ type: 'text', text: message.text }] : []),
  ];
}

interface AnthropicFrame {
  type?: unknown;
  delta?: { type?: unknown; text?: unknown; thinking?: unknown };
  message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  error?: { message?: unknown };
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * One turn against `POST {base}/v1/messages` with `stream: true`
 * (<https://docs.claude.com/en/api/messages-streaming>).
 *
 * Anthropic separates the system prompt from the conversation, so a `system` message is
 * lifted out rather than sent as a turn — sending it as a `user` turn is how a system
 * prompt quietly becomes something the model can argue with.
 *
 * Token totals arrive twice: `message_start` carries the input count, and
 * `message_delta` the output count. Both are cumulative for the turn, so each is emitted
 * as it lands and the last one the run saw wins.
 */
export async function* anthropicChat(
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
  const turns = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: content(message) }));
  const open = await openStream({
    url: joinUrl(ctx.baseUrl, 'v1/messages'),
    headers: headers(ctx),
    body: {
      model: request.model,
      messages: turns,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(system ? { system } : {}),
    },
    fetchImpl: ctx.fetchImpl,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!open.ok) {
    yield chatFailure(open);
    return;
  }
  for await (const payload of sseData(open.lines)) {
    const frame = parseFrame(payload) as AnthropicFrame | null;
    if (!frame) continue;
    if (frame.type === 'error') {
      const detail = typeof frame.error?.message === 'string' ? frame.error.message : null;
      yield {
        type: 'failed',
        reason: 'http_error',
        detail: detail?.slice(0, 500) ?? null,
        status: null,
      };
      return;
    }
    if (frame.type === 'content_block_delta') {
      if (typeof frame.delta?.text === 'string' && frame.delta.text) {
        yield { type: 'delta', text: frame.delta.text };
      }
      if (typeof frame.delta?.thinking === 'string' && frame.delta.thinking) {
        yield { type: 'reasoning', text: frame.delta.thinking };
      }
      continue;
    }
    const usage = frame.type === 'message_start' ? frame.message?.usage : frame.usage;
    if (usage) {
      const event: Extract<ChatEvent, { type: 'usage' }> = { type: 'usage' };
      const input = count(usage.input_tokens);
      const output = count(usage.output_tokens);
      const cacheRead = count(
        (usage as { cache_read_input_tokens?: unknown }).cache_read_input_tokens,
      );
      const cacheWrite = count(
        (usage as { cache_creation_input_tokens?: unknown }).cache_creation_input_tokens,
      );
      if (input !== undefined) event.inputTokens = input;
      if (output !== undefined) event.outputTokens = output;
      if (cacheRead !== undefined) event.cacheReadTokens = cacheRead;
      if (cacheWrite !== undefined) event.cacheWriteTokens = cacheWrite;
      yield event;
    }
  }
  if (request.signal?.aborted) {
    yield { type: 'failed', reason: 'cancelled', detail: null, status: null };
    return;
  }
  yield { type: 'completed' };
}

export const anthropicAdapter: ProviderAdapter = {
  protocol: 'anthropic',

  chat(ctx: ProviderContext, request: ChatRequest): AsyncIterable<ChatEvent> {
    return anthropicChat(ctx, request);
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    if (!ctx.apiKey) {
      return { ok: false, reason: 'no_key', detail: null, status: null, durationMs: 0 };
    }
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'v1/models?limit=1'),
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
    let url = joinUrl(ctx.baseUrl, 'v1/models?limit=100');
    // The list is paged with `after_id`; ten pages is far past any real account.
    for (let page = 0; page < 10; page += 1) {
      const answer = await requestJson({
        url,
        headers: headers(ctx),
        fetchImpl: ctx.fetchImpl,
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      });
      if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
      const body = answer.body as {
        data?: { id?: unknown; display_name?: unknown }[];
        has_more?: unknown;
        last_id?: unknown;
      } | null;
      if (!Array.isArray(body?.data)) {
        return { supported: false, reason: 'the provider did not answer with a model list' };
      }
      for (const item of body.data) {
        const id = typeof item?.id === 'string' ? item.id : null;
        if (!id) continue;
        models.push({
          key: id,
          label:
            typeof item.display_name === 'string' && item.display_name ? item.display_name : id,
          kind: 'chat',
          capabilities: ['tools', 'vision', 'streaming'],
        });
      }
      if (body.has_more !== true || typeof body.last_id !== 'string') break;
      url = joinUrl(
        ctx.baseUrl,
        `v1/models?limit=100&after_id=${encodeURIComponent(body.last_id)}`,
      );
    }
    return { supported: true, models };
  },

  listVoices(): Promise<ListVoicesResult> {
    return Promise.resolve({ supported: false, reason: 'this provider does not speak' });
  },

  synthesize(): Promise<SynthesizeResult> {
    return Promise.resolve({ supported: false, reason: 'this provider does not speak' });
  },
};
