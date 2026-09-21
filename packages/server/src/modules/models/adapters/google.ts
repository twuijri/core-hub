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
import type {
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

export const googleAdapter: ProviderAdapter = {
  protocol: 'google',

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
