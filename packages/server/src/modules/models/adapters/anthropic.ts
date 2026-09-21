/**
 * Anthropic's own API: `x-api-key` plus a dated `anthropic-version` header, and
 * `GET /v1/models` as both the connectivity check and the catalogue
 * (<https://docs.claude.com/en/api/models-list>).
 *
 * The version header is pinned here rather than configured: a provider row that silently
 * follows whatever Anthropic ships next is a provider row that breaks without a commit.
 */
import { detailOf, joinUrl, reasonOf, requestJson } from './http.js';
import type {
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

export const anthropicAdapter: ProviderAdapter = {
  protocol: 'anthropic',

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
