// The provider adapters the hub ships with. The service asks for one by protocol and
// then sees only `ProviderAdapter`, the same way the rest of the server sees only
// `AgentAdapter` for agents (ADR 0002's shape, applied to providers).
import type { ProviderProtocol } from '../catalogue.js';
import { anthropicAdapter } from './anthropic.js';
import { azureAdapter } from './azure.js';
import { deepgramAdapter } from './deepgram.js';
import { elevenLabsAdapter } from './elevenlabs.js';
import { groqAdapter } from './groq.js';
import { googleAdapter } from './google.js';
import { ollamaAdapter } from './ollama.js';
import { openAiAdapter } from './openai.js';
import type { ProviderAdapter } from './types.js';

export * from './types.js';
export { anthropicAdapter, anthropicChat } from './anthropic.js';
export { elevenLabsAdapter } from './elevenlabs.js';
export { azureAdapter, azureLocale, azureSttBase, azureTtsBase } from './azure.js';
export { deepgramAdapter } from './deepgram.js';
export { groqAdapter } from './groq.js';
export { googleAdapter, googleChat } from './google.js';
export { ollamaAdapter } from './ollama.js';
export { openAiAdapter, openAiChat, perMillionMicroUsd } from './openai.js';
export { joinUrl, requestJson, requestBytes, requestUpload } from './http.js';
export { chatFailure, openStream, parseFrame, readLines, sseData } from './stream.js';
export type { StreamOpen, StreamRequest } from './stream.js';

const ADAPTERS: Record<ProviderProtocol, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openAiAdapter,
  google: googleAdapter,
  ollama: ollamaAdapter,
  elevenlabs: elevenLabsAdapter,
  groq: groqAdapter,
  deepgram: deepgramAdapter,
  azure: azureAdapter,
};

export function providerAdapter(protocol: ProviderProtocol): ProviderAdapter {
  return ADAPTERS[protocol] ?? openAiAdapter;
}

export function allProviderAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}
