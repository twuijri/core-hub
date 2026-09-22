/**
 * The bundled provider catalogue: the provider **types** a person can add, and the one
 * place that says what each provider's credential is *called* in the outside world.
 *
 * Nothing here is a provider the workspace *has*. A row in `providers` exists because
 * somebody added it (`models.createProvider`); this file is what the "Add provider"
 * dialog and `majlis providers presets` list (contract decision §26).
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
  'lmstudio',
  'litellm',
  'custom',
] as const;
export type CredentialFamily = (typeof CREDENTIAL_FAMILIES)[number];

/** How a provider's HTTP surface is driven (`adapters/`). */
export type ProviderProtocol = 'anthropic' | 'openai' | 'google' | 'ollama' | 'elevenlabs';

/**
 * Whether the endpoint needs a key. There is deliberately no third value meaning "a key
 * is refused": LM Studio, LiteLLM, `cli-proxy-api` and vLLM are all routinely put behind
 * one, so `optional` means *the hub does not demand it*, never *you may not type it*
 * (contract decision §26).
 */
export type KeyRequirement = 'required' | 'optional';

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
  /** Whether the hub demands a key. A key is always *accepted* (`KeyRequirement`). */
  keyRequirement: KeyRequirement;
  /**
   * What to prefill in the dialog, or null when no default could be right — LiteLLM and
   * a bare OpenAI-compatible endpoint have no address anybody could guess, so the person
   * must supply one (`base_url_required` in the contract is `baseUrl === null`).
   */
  baseUrl: string | null;
  capabilities: ProviderCapabilities;
  /** Runs on the person's own machine or network: the loopback warning applies. */
  local?: boolean;
  /** May be added more than once, each instance named by the person (custom endpoints). */
  repeatable?: boolean;
  /** Defaults for a speech provider's `settings` (model, language, voice). */
  settings?: SpeechProviderSettings;
  /** Documentation link shown next to the key field, so nobody has to search for it. */
  keysUrl: string | null;
}

/**
 * The row's `auth.kind`. `none` is the contract's "no key is required" — the client still
 * offers the field, and only the endpoint's own 401 may say a key is missing.
 */
export function authKindOf(entry: Pick<ProviderCatalogueEntry, 'keyRequirement'>): AuthKind {
  return entry.keyRequirement === 'required' ? 'api_key' : 'none';
}

/**
 * The presets. Every entry is a provider the hub knows how to talk to today: it has an
 * adapter in `adapters/`, a real model list endpoint (or an honest `listModels: false`),
 * and a documented place to get a key when it needs one.
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    // Ollama itself authenticates nothing, but people put it behind a reverse proxy that
    // does; `optional` is "not demanded", never "not accepted" (the defect of 2026-09-22).
    keyRequirement: 'optional',
    baseUrl: 'http://127.0.0.1:11434',
    capabilities: { chat: true, embeddings: true, listModels: true },
    local: true,
    keysUrl: null,
  },
  {
    slug: 'lmstudio',
    label: 'LM Studio',
    kind: 'llm',
    family: 'lmstudio',
    // A local server's key, if it has one, is nobody else's variable: stored here, and
    // propagated nowhere (there is no LM Studio slug in Hermes and no world-wide name).
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'chat_completions',
    keyRequirement: 'optional',
    // LM Studio's developer server, as its own UI prints it.
    baseUrl: 'http://127.0.0.1:1234/v1',
    capabilities: { chat: true, embeddings: true, listModels: true },
    local: true,
    keysUrl: null,
  },
  {
    slug: 'litellm',
    label: 'LiteLLM',
    kind: 'llm',
    family: 'litellm',
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'chat_completions',
    // LiteLLM proxies are commonly run with a master key, and just as commonly without.
    keyRequirement: 'optional',
    // No default: a LiteLLM proxy is wherever its owner put it, and a wrong guess here
    // would be a URL the person has to notice and undo.
    baseUrl: null,
    capabilities: { chat: true, embeddings: true, listModels: true },
    local: true,
    keysUrl: 'https://docs.litellm.ai/docs/proxy/virtual_keys',
  },
  {
    slug: 'openai-compatible',
    label: 'OpenAI-compatible',
    kind: 'llm',
    // Somebody's own endpoint is its own credential family (`custom:<slug>` per row):
    // sharing a key with a built-in provider of a similar name would be a guess.
    family: 'custom',
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: null,
    protocol: 'openai',
    apiMode: 'chat_completions',
    keyRequirement: 'optional',
    baseUrl: null,
    capabilities: { chat: true, listModels: true },
    local: false,
    repeatable: true,
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    keyRequirement: 'required',
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
    if (entry.keyRequirement === 'required' && !entry.envVar) {
      throw new Error(`provider catalogue: "${entry.slug}" needs a key but names no variable`);
    }
    // An entry with no variable is one whose key the hub stores and propagates nowhere:
    // a local server has no world-wide name for its key, and no slug in Hermes either.
    if (!entry.envVar && (entry.hermesEnvVars.length > 0 || entry.hermesProvider)) {
      throw new Error(
        `provider catalogue: "${entry.slug}" names no variable but claims a Hermes name`,
      );
    }
    const known = envByFamily.get(entry.family);
    if (known !== undefined && known !== entry.envVar) {
      throw new Error(
        `provider catalogue: family "${entry.family}" disagrees on its variable ` +
          `("${known ?? 'null'}" vs "${entry.envVar ?? 'null'}") — one family is one key`,
      );
    }
    envByFamily.set(entry.family, entry.envVar);
    if (entry.baseUrl !== null) {
      try {
        void new URL(entry.baseUrl);
      } catch {
        throw new Error(`provider catalogue: "${entry.slug}" has no usable base URL`);
      }
    }
    // A repeatable entry is added more than once, so it cannot own a shared family row.
    if (entry.repeatable && entry.family !== 'custom') {
      throw new Error(`provider catalogue: repeatable "${entry.slug}" must be its own family`);
    }
  }
}
