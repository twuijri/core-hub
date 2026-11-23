/**
 * The hub's models in the harness (ADR 0033 §3, the plugin's part): one "Core Hub" provider
 * under `llm-pi-ai.providers` in the active profile's patch, pointing at the hub's external
 * gateway entrance on the OpenAI Chat Completions wire, with the models the entrance lists.
 *
 * The token is never written into the patch, the harness's credential store, or this process's
 * environment (where the harness's shell tools would see it): the row carries a placeholder
 * `Authorization` header, and the plugin's `llm-pi-ai/request-headers` listener puts the real
 * bearer on each request to this provider, from memory (the plugin's 0600 file). The harness
 * reads credentials from a snapshot of its launch environment, so a variable set later would
 * not reach it anyway. Every other provider the person has is kept as it is (the edit goes
 * through the harness's ConfigEditor, which writes the whole row's config).
 */
import { API_BASE, GATEWAY, PRODUCT_NAME, PROVIDER_ID, TOKEN_PLACEHOLDER } from './names.js';
import type { GatewayModel } from './hub.js';

/** pi-ai's per-model `input` (`PiAiModelProfile.input`): a model without it is text only. */
export type ModelInput = 'text' | 'image';

export interface ProviderRow {
  displayName: string;
  api: 'openai-completions';
  baseURL: string;
  headers: { Authorization: string };
  compat: { supportsDeveloperRole: boolean; maxTokensField: 'max_tokens' };
  models: Array<{ id: string; name?: string; contextWindow?: number; input: ModelInput[] }>;
}

export function gatewayBase(hub: string): string {
  return `${hub}${API_BASE}${GATEWAY.openai}`;
}

export function providerRow(hub: string, models: readonly GatewayModel[]): ProviderRow {
  return {
    displayName: PRODUCT_NAME,
    api: 'openai-completions',
    baseURL: gatewayBase(hub),
    headers: { Authorization: TOKEN_PLACEHOLDER },
    // The gateway translates to each provider's own wire; the plainest OpenAI shape is safest.
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.context_window ? { contextWindow: m.context_window } : {}),
      // Per model, never the provider's `defaultInput`: claiming images for a model that cannot
      // take them makes the provider refuse mid-turn (the hub says which can, §156 amendment).
      input: m.image ? (['text', 'image'] as ModelInput[]) : (['text'] as ModelInput[]),
    })),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The `llm-pi-ai` config with the Core Hub provider set (or replaced); others untouched. */
export function withProvider(
  current: Record<string, unknown>,
  row: ProviderRow,
): Record<string, unknown> {
  const providers = isRecord(current.providers) ? current.providers : {};
  return { ...current, providers: { ...providers, [PROVIDER_ID]: row } };
}

/** The `llm-pi-ai` config without the Core Hub provider. */
export function withoutProvider(current: Record<string, unknown>): Record<string, unknown> {
  const providers = isRecord(current.providers) ? { ...current.providers } : {};
  delete providers[PROVIDER_ID];
  return { ...current, providers };
}

/** Whether the config already says exactly this (no write needed). */
export function sameProvider(current: Record<string, unknown>, row: ProviderRow): boolean {
  const providers = isRecord(current.providers) ? current.providers : {};
  return JSON.stringify(providers[PROVIDER_ID] ?? null) === JSON.stringify(row);
}

/**
 * The `llm-pi-ai/request-headers` step: the real bearer on a request to the Core Hub provider,
 * nothing on any other.
 */
export function withBearer(
  provider: string | undefined,
  headers: Headers,
  token: string | null,
): void {
  if (provider !== PROVIDER_ID || !token) return;
  headers.set('Authorization', `Bearer ${token}`);
}
