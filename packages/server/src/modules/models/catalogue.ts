/**
 * The bundled provider catalogue: the providers a fresh workspace is offered, and the one
 * place that says what each provider's credential is *called* in the outside world.
 *
 * Two things live on an entry and nowhere else:
 *
 * 1. **The credential family.** `openai` (chat), `openai-stt` and `openai-tts` are three
 *    provider rows because the contract gives a provider one `kind`, but they are one
 *    key. Entries that share `family` share the `secrets` row, which is what makes
 *    "the owner pastes the key once" true across chat, dictation and speech (ADR 0010).
 * 2. **The environment variable the world expects** (`ANTHROPIC_API_KEY`, …). Agents are
 *    started with these names; an agent that wants a different one says so in its own
 *    catalog entry (`modules/agents/catalog/`), one line, maintained by us.
 *
 * No model ids are seeded. A model list is only ever what a provider itself answered to
 * `models.refreshProvider` (`adapters/`), so the picker never offers a model that was
 * true when this file was written and is not true today.
 */
import type {
  ApiMode,
  AuthKind,
  ProviderCapabilities,
  ProviderKind,
  SpeechProviderSettings,
} from './schema.js';

/**
 * A credential family. One API key, one account, however many provider rows use it.
 * The value is also the default environment-variable family name used by
 * `propagation.ts` when an agent does not rename it.
 */
export const CREDENTIAL_FAMILIES = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'xai',
  'elevenlabs',
  'ollama',
  'custom',
] as const;
export type CredentialFamily = (typeof CREDENTIAL_FAMILIES)[number];

/** How a provider's HTTP surface is driven (`adapters/`). */
export type ProviderProtocol = 'anthropic' | 'openai' | 'google' | 'ollama' | 'elevenlabs';

export interface ProviderCatalogueEntry {
  slug: string;
  label: string;
  kind: ProviderKind;
  family: CredentialFamily;
  /**
   * The environment variable name the wider world uses for this family's key. Agents
   * inherit it under this name unless their own catalog entry renames it.
   */
  envVar: string | null;
  protocol: ProviderProtocol;
  /**
   * Every variable name Hermes reads this family's key from
   * (`plugins/model-providers/<id>/__init__.py` §env_vars, and the reference table in
   * docs/inspirations/hermes-agent.md). Usually just `envVar`; Google is the case where
   * Hermes prefers `GOOGLE_API_KEY` while the Gemini CLI wants `GEMINI_API_KEY`, so the
   * hub writes both into Hermes's `.env` and hands the agent the one it asked for.
   */
  hermesEnvVars: string[];
  /**
   * Hermes's own provider slug, for `model.provider` in its `config.yaml`, or null when
   * Hermes has no provider for this endpoint. Null matters: Hermes aliases `openai` to
   * **OpenRouter**, so guessing a slug would silently route a run to the wrong account.
   * With null the hub leaves Hermes's model selection alone and says so.
   */
  hermesProvider: string | null;
  apiMode: ApiMode;
  authKind: AuthKind;
  baseUrl: string;
  capabilities: ProviderCapabilities;
  /** Defaults for a speech provider's `settings` (model, language, voice). */
  settings?: SpeechProviderSettings;
  /** Documentation link shown next to the key field, so nobody has to search for it. */
  keysUrl: string | null;
}

/**
 * The seed. Every entry is a provider the hub knows how to talk to today: it has an
 * adapter in `adapters/`, a real model list endpoint (or an honest `listModels: false`),
 * and a documented place to get a key.
 */
export const PROVIDER_CATALOGUE: readonly ProviderCatalogueEntry[] = [
  {
    slug: 'anthropic',
    label: 'Anthropic',
    kind: 'llm',
    family: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    hermesEnvVars: ['ANTHROPIC_API_KEY'],
    hermesProvider: 'anthropic',
    protocol: 'anthropic',
    apiMode: 'native',
    authKind: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    slug: 'openai',
    label: 'OpenAI',
    kind: 'llm',
    family: 'openai',
    envVar: 'OPENAI_API_KEY',
    hermesEnvVars: ['OPENAI_API_KEY'],
    hermesProvider: 'openai-api',
    protocol: 'openai',
    apiMode: 'responses',
    authKind: 'api_key',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: { chat: true, embeddings: true, listModels: true },
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    slug: 'openrouter',
    label: 'OpenRouter',
    kind: 'llm',
    family: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    hermesEnvVars: ['OPENROUTER_API_KEY'],
    hermesProvider: 'openrouter',
    protocol: 'openai',
    apiMode: 'chat_completions',
    authKind: 'api_key',
    baseUrl: 'https://openrouter.ai/api/v1',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://openrouter.ai/keys',
  },
  {
    slug: 'google',
    label: 'Google Gemini',
    kind: 'llm',
    family: 'google',
    envVar: 'GEMINI_API_KEY',
    hermesEnvVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    hermesProvider: 'gemini',
    protocol: 'google',
    apiMode: 'native',
    authKind: 'api_key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    capabilities: { chat: true, embeddings: true, listModels: true },
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  {
    slug: 'groq',
    label: 'Groq',
    kind: 'llm',
    family: 'groq',
    envVar: 'GROQ_API_KEY',
    hermesEnvVars: ['GROQ_API_KEY'],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'chat_completions',
    authKind: 'api_key',
    baseUrl: 'https://api.groq.com/openai/v1',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://console.groq.com/keys',
  },
  {
    slug: 'mistral',
    label: 'Mistral',
    kind: 'llm',
    family: 'mistral',
    envVar: 'MISTRAL_API_KEY',
    hermesEnvVars: ['MISTRAL_API_KEY'],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'chat_completions',
    authKind: 'api_key',
    baseUrl: 'https://api.mistral.ai/v1',
    capabilities: { chat: true, embeddings: true, listModels: true },
    keysUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    slug: 'deepseek',
    label: 'DeepSeek',
    kind: 'llm',
    family: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    hermesEnvVars: ['DEEPSEEK_API_KEY'],
    hermesProvider: 'deepseek',
    protocol: 'openai',
    apiMode: 'chat_completions',
    authKind: 'api_key',
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    slug: 'xai',
    label: 'xAI',
    kind: 'llm',
    family: 'xai',
    envVar: 'XAI_API_KEY',
    hermesEnvVars: ['XAI_API_KEY'],
    hermesProvider: 'xai',
    protocol: 'openai',
    apiMode: 'chat_completions',
    authKind: 'api_key',
    baseUrl: 'https://api.x.ai/v1',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://console.x.ai',
  },
  {
    slug: 'ollama',
    label: 'Ollama',
    kind: 'llm',
    family: 'ollama',
    // A local runtime takes no key; nothing to propagate, nothing to hide.
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: null,
    protocol: 'ollama',
    apiMode: 'chat_completions',
    authKind: 'none',
    baseUrl: 'http://127.0.0.1:11434',
    capabilities: { chat: true, embeddings: true, listModels: true },
    keysUrl: null,
  },
  {
    slug: 'openai-stt',
    label: 'OpenAI — speech to text',
    kind: 'stt',
    family: 'openai',
    envVar: 'OPENAI_API_KEY',
    hermesEnvVars: ['OPENAI_API_KEY'],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'native',
    authKind: 'api_key',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: { stt: true, listModels: true },
    settings: { model: 'whisper-1', language: null, voice: null },
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    slug: 'openai-tts',
    label: 'OpenAI — text to speech',
    kind: 'tts',
    family: 'openai',
    envVar: 'OPENAI_API_KEY',
    hermesEnvVars: ['OPENAI_API_KEY'],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'native',
    authKind: 'api_key',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: { tts: true, listModels: true, listVoices: false },
    settings: { model: 'gpt-4o-mini-tts', language: null, voice: 'alloy' },
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'tts',
    family: 'elevenlabs',
    envVar: 'ELEVENLABS_API_KEY',
    hermesEnvVars: ['ELEVENLABS_API_KEY'],
    hermesProvider: null,
    protocol: 'elevenlabs',
    apiMode: 'native',
    authKind: 'api_key',
    baseUrl: 'https://api.elevenlabs.io/v1',
    capabilities: { tts: true, listModels: false, listVoices: true },
    settings: { model: 'eleven_multilingual_v2', language: null, voice: null },
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
];

export function catalogueEntry(slug: string): ProviderCatalogueEntry | undefined {
  return PROVIDER_CATALOGUE.find((entry) => entry.slug === slug);
}

/** Every entry of one credential family: what "one key, many rows" resolves to. */
export function familyEntries(family: string): ProviderCatalogueEntry[] {
  return PROVIDER_CATALOGUE.filter((entry) => entry.family === family);
}

/** The environment-variable name a family's key is known by, or null for keyless ones. */
export function envVarOf(family: string): string | null {
  return PROVIDER_CATALOGUE.find((entry) => entry.family === family)?.envVar ?? null;
}

/** The name the `secrets` row gets: one per family, so the key is stored exactly once. */
export function secretNameOf(family: string): string {
  return `provider:${family}`;
}

/** Guard, asserted by a unit test: ids are usable, families agree on their variable. */
export function assertCatalogueIsWellFormed(
  catalogue: readonly ProviderCatalogueEntry[] = PROVIDER_CATALOGUE,
): void {
  const seen = new Set<string>();
  const envByFamily = new Map<string, string | null>();
  for (const entry of catalogue) {
    if (!/^[a-z0-9-]{2,40}$/.test(entry.slug)) {
      throw new Error(`provider catalogue: "${entry.slug}" is not a usable slug`);
    }
    if (seen.has(entry.slug)) throw new Error(`provider catalogue: duplicate "${entry.slug}"`);
    seen.add(entry.slug);
    if (entry.authKind === 'api_key' && !entry.envVar) {
      throw new Error(`provider catalogue: "${entry.slug}" needs a key but names no variable`);
    }
    if (entry.authKind === 'none' && entry.envVar) {
      throw new Error(`provider catalogue: "${entry.slug}" needs no key but names a variable`);
    }
    const known = envByFamily.get(entry.family);
    if (known !== undefined && known !== entry.envVar) {
      throw new Error(
        `provider catalogue: family "${entry.family}" disagrees on its variable ` +
          `("${known ?? 'null'}" vs "${entry.envVar ?? 'null'}") — one family is one key`,
      );
    }
    envByFamily.set(entry.family, entry.envVar);
    try {
      void new URL(entry.baseUrl);
    } catch {
      throw new Error(`provider catalogue: "${entry.slug}" has no usable base URL`);
    }
  }
}
