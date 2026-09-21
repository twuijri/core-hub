/**
 * Ollama, the local runtime: no key, `GET /api/tags` for what is pulled on this machine
 * (<https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models>).
 *
 * "Reachable" is the whole connectivity question here — there is nothing to authenticate,
 * so a failed test means the daemon is not running or the base URL is wrong, and the
 * message says so instead of hinting at a key.
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

interface OllamaModel {
  name?: unknown;
  model?: unknown;
  details?: { family?: unknown; parameter_size?: unknown };
}

export const ollamaAdapter: ProviderAdapter = {
  protocol: 'ollama',

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const answer = await requestJson({
      url: joinUrl(ctx.baseUrl, 'api/tags'),
      headers: ctx.headers,
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
      url: joinUrl(ctx.baseUrl, 'api/tags'),
      headers: ctx.headers,
      fetchImpl: ctx.fetchImpl,
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    if (!answer.ok) return { supported: false, reason: detailOf(answer) ?? reasonOf(answer) };
    const body = answer.body as { models?: OllamaModel[] } | null;
    if (!Array.isArray(body?.models)) {
      return { supported: false, reason: 'the provider did not answer with a model list' };
    }
    const models: DiscoveredModel[] = [];
    for (const item of body.models) {
      const id =
        typeof item?.model === 'string' && item.model
          ? item.model
          : typeof item?.name === 'string'
            ? item.name
            : null;
      if (!id) continue;
      const size = item.details?.parameter_size;
      models.push({
        key: id,
        label: typeof size === 'string' && size ? `${id} (${size})` : id,
        kind: id.includes('embed') ? 'embedding' : 'chat',
        capabilities: ['streaming'],
      });
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
