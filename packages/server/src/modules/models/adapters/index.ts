// The provider adapters the hub ships with. The service asks for one by protocol and
// then sees only `ProviderAdapter`, the same way the rest of the server sees only
// `AgentAdapter` for agents (ADR 0002's shape, applied to providers).
import type { ProviderProtocol } from '../catalogue.js';
import { anthropicAdapter } from './anthropic.js';
import { elevenLabsAdapter } from './elevenlabs.js';
import { googleAdapter } from './google.js';
import { ollamaAdapter } from './ollama.js';
import { openAiAdapter } from './openai.js';
import type { ProviderAdapter } from './types.js';

export * from './types.js';
export { anthropicAdapter } from './anthropic.js';
export { elevenLabsAdapter } from './elevenlabs.js';
export { googleAdapter } from './google.js';
export { ollamaAdapter } from './ollama.js';
export { openAiAdapter, perMillionMicroUsd } from './openai.js';
export { joinUrl, requestJson, requestBytes } from './http.js';

const ADAPTERS: Record<ProviderProtocol, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openAiAdapter,
  google: googleAdapter,
  ollama: ollamaAdapter,
  elevenlabs: elevenLabsAdapter,
};

export function providerAdapter(protocol: ProviderProtocol): ProviderAdapter {
  return ADAPTERS[protocol] ?? openAiAdapter;
}

export function allProviderAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}
