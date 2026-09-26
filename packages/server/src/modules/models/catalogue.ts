/**
 * The bundled provider catalogue: the provider **types** a person can add, and the one
 * place that says what each provider's credential is *called* in the outside world.
 *
 * Nothing here is a provider the workspace *has*. A row in `providers` exists because
 * somebody added it (`models.createProvider`); this file is what the "Add provider"
 * dialog and `corehub providers presets` list (contract decision §26).
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
import { LEGACY, derived } from '@corehub/contracts';
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
  'deepgram',
  'azure-speech',
  'ollama',
  'lmstudio',
  'litellm',
  'custom',
  // Signed in to through Hermes (contract decision §55): no key, one account each.
  'nous',
  'openai-codex',
  'xai-oauth',
  'minimax-oauth',
] as const;
export type CredentialFamily = (typeof CREDENTIAL_FAMILIES)[number];

/** How a provider's HTTP surface is driven (`adapters/`). */
export type ProviderProtocol =
  'anthropic' | 'openai' | 'google' | 'ollama' | 'elevenlabs' | 'groq' | 'deepgram' | 'azure';

/**
 * What a speech provider's requests allow, from its public documentation (DECISIONS §87).
 */
export interface SpeechLimits {
  /**
   * The most characters one synthesis request takes. Longer text is split at sentence, then
   * word, boundaries under it (`speech/split.ts`) and the parts' audio joined in order.
   */
  maxInputChars?: number;
}

/**
 * How Hermes's own voice tools say this speech provider (read from Hermes's MIT source,
 * `tools/transcription_tools.py` and `tools/tts_tool*.py`, v2026.9.14): the value of
 * `stt.provider` / `tts.provider`, and the keys of its block (`stt.<section>.model`, …) the
 * hub writes the row's choice into. A provider Hermes has no voice backend for has none, and
 * Hermes's voice in channels is then left as it is.
 */
export interface HermesSpeechRoute {
  provider: string;
  section: string;
  modelKey: string;
  voiceKey: string | null;
  languageKey: string | null;
}

/**
 * Whether the endpoint needs a key. There is deliberately no third value meaning "a key
 * is refused": LM Studio, LiteLLM, `cli-proxy-api` and vLLM are all routinely put behind
 * one, so `optional` means *the hub does not demand it*, never *you may not type it*
 * (contract decision §26).
 */
export type KeyRequirement = 'required' | 'optional';

/**
 * How this provider is expressed to Hermes (ADR 0010 §Propagation).
 *
 * - `builtin` — Hermes ships a provider of its own for this endpoint, named by
 *   `hermesProvider`. Nothing but `model.provider` + `model.default` is written.
 * - `openai-compatible` — Hermes has no provider of its own, but it *does* understand an
 *   arbitrary OpenAI-compatible endpoint: a keyed block under `providers:` in its
 *   `config.yaml` (`hermes_cli/config_providers.py` §`_KNOWN_PROVIDER_KEYS`, resolved by
 *   `runtime_provider_custom.py` §`_match_new_style_provider`) carrying `base_url`,
 *   `api_mode` and `key_env`. That is what LM Studio, LiteLLM, Groq, Mistral and
 *   somebody's own endpoint become.
 * - `none` — the hub cannot say this provider to Hermes at all (a speech provider is not
 *   a chat route). The honest refusal of ADR 0010 stays, and the run says so.
 */
export type HermesRouteKind = 'builtin' | 'openai-compatible' | 'none';

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
  /**
   * How the hub says this provider to Hermes. Defaults are derived, never guessed:
   * an entry with a `hermesProvider` is `builtin`, an entry whose `protocol` speaks
   * OpenAI's wire is `openai-compatible`, everything else is `none`.
   */
  hermesRoute: HermesRouteKind;
  /**
   * The `api_mode` Hermes should use for an `openai-compatible` route, or null to let it
   * detect one from the URL. Hermes canonicalises `chat_completions` and `responses`
   * (`hermes_cli/config_providers.py` §`_API_MODE_ALIASES`); `native` is not a transport
   * it knows, so an entry that declares it leaves the choice to Hermes.
   */
  hermesApiMode: 'chat_completions' | 'responses' | null;
  /**
   * The base URL Hermes should be given, when it is not the one our own adapter uses.
   * Only Ollama differs: our adapter drives Ollama's native API at the server root, and
   * Hermes drives its OpenAI-compatible surface, which lives under `/v1`.
   */
  hermesBaseUrlSuffix?: string;
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
  /** A speech provider's documented request limits (DECISIONS §87). */
  speech?: SpeechLimits;
  /** How Hermes's own voice tools say this speech provider, when they can. */
  hermesSpeech?: HermesSpeechRoute;
  /**
   * What the address field should show when `baseUrl` is null and the person must type it —
   * an example of the shape, never a value the hub would use.
   */
  baseUrlExample?: string;
  /** Documentation link shown next to the key field, so nobody has to search for it. */
  keysUrl: string | null;
  /**
   * Used by signing in to an account rather than with a key (contract decision §55): Hermes
   * performs the device-code sign-in for its provider `hermesProvider` and keeps the
   * credential. Only a provider Hermes can sign in to from its own server says so.
   */
  signIn?: boolean;
}

/**
 * The row's `auth.kind`. `none` is the contract's "no key is required" — the client still
 * offers the field, and only the endpoint's own 401 may say a key is missing.
 */
export function authKindOf(
  entry: Pick<ProviderCatalogueEntry, 'keyRequirement' | 'signIn'>,
): AuthKind {
  if (entry.signIn) return 'oauth';
  return entry.keyRequirement === 'required' ? 'api_key' : 'none';
}

/**
 * The model a new OpenAI speech-to-text row starts on. `whisper-1` was the default until
 * 2026-09-26; OpenAI shuts it down on 2027-02-26 and names `gpt-transcribe` as its successor.
 */
export const OPENAI_STT_DEFAULT_MODEL = 'gpt-transcribe';

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
    hermesRoute: 'builtin',
    hermesApiMode: null,
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
    hermesRoute: 'builtin',
    hermesApiMode: null,
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
    hermesRoute: 'builtin',
    hermesApiMode: null,
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
    hermesRoute: 'builtin',
    hermesApiMode: null,
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
    hermesRoute: 'openai-compatible',
    hermesApiMode: 'chat_completions',
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
    hermesRoute: 'openai-compatible',
    hermesApiMode: 'chat_completions',
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
    hermesRoute: 'builtin',
    hermesApiMode: null,
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
    hermesRoute: 'builtin',
    hermesApiMode: null,
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
    hermesRoute: 'openai-compatible',
    hermesApiMode: 'chat_completions',
    hermesBaseUrlSuffix: '/v1',
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
    hermesRoute: 'openai-compatible',
    hermesApiMode: 'chat_completions',
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
    hermesRoute: 'openai-compatible',
    hermesApiMode: 'chat_completions',
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
    hermesRoute: 'openai-compatible',
    hermesApiMode: 'chat_completions',
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
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'openai',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: { stt: true, listModels: true },
    // A new row starts on `gpt-transcribe`: OpenAI retires `whisper-1` on 2027-02-26 (DECISIONS
    // §111). A preset's settings are copied into a row once, when it is created, so a row that
    // already holds `whisper-1` — or any model somebody chose — keeps it.
    settings: { model: OPENAI_STT_DEFAULT_MODEL, language: null, voice: null },
    hermesSpeech: {
      provider: 'openai',
      section: 'openai',
      modelKey: 'model',
      voiceKey: null,
      languageKey: 'language',
    },
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
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'openai',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.openai.com/v1',
    // Voices: the documented list (no endpoint), `speech/documented.ts`.
    capabilities: { tts: true, listModels: true, listVoices: true },
    settings: { model: 'gpt-4o-mini-tts', language: null, voice: 'alloy' },
    speech: { maxInputChars: 4096 },
    hermesSpeech: {
      provider: 'openai',
      section: 'openai',
      modelKey: 'model',
      voiceKey: 'voice',
      languageKey: null,
    },
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  // Groq (groq.com, the inference company — not xAI's Grok): the chat key speaks and
  // transcribes too. Whisper over OpenAI's shape; Orpheus TTS (English, and Arabic in the
  // Saudi dialect) in WAV only, 200 characters a request, voices named in its docs (§87).
  {
    slug: 'groq-stt',
    label: 'Groq — speech to text',
    kind: 'stt',
    family: 'groq',
    envVar: 'GROQ_API_KEY',
    hermesEnvVars: ['GROQ_API_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'groq',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.groq.com/openai/v1',
    capabilities: { stt: true, listModels: true },
    settings: { model: 'whisper-large-v3-turbo', language: null, voice: null },
    hermesSpeech: {
      provider: 'groq',
      section: 'groq',
      modelKey: 'model',
      voiceKey: null,
      languageKey: 'language',
    },
    keysUrl: 'https://console.groq.com/keys',
  },
  {
    slug: 'groq-tts',
    label: 'Groq — text to speech',
    kind: 'tts',
    family: 'groq',
    envVar: 'GROQ_API_KEY',
    hermesEnvVars: ['GROQ_API_KEY'],
    hermesProvider: null,
    // Hermes's OpenAI-shaped TTS asks for MP3 or Opus, which Groq refuses: not expressible.
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'groq',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.groq.com/openai/v1',
    capabilities: { tts: true, listModels: true, listVoices: true },
    // No default model or voice: the person picks the voice (the owner, 2026-09-26).
    settings: { model: null, language: null, voice: null },
    speech: { maxInputChars: 200 },
    keysUrl: 'https://console.groq.com/keys',
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'tts',
    family: 'elevenlabs',
    envVar: 'ELEVENLABS_API_KEY',
    hermesEnvVars: ['ELEVENLABS_API_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'elevenlabs',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.elevenlabs.io/v1',
    capabilities: { tts: true, listModels: true, listVoices: true },
    settings: { model: 'eleven_multilingual_v2', language: null, voice: null },
    speech: { maxInputChars: 5000 },
    hermesSpeech: {
      provider: 'elevenlabs',
      section: 'elevenlabs',
      modelKey: 'model_id',
      voiceKey: 'voice_id',
      languageKey: null,
    },
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    slug: 'elevenlabs-stt',
    label: 'ElevenLabs — speech to text',
    kind: 'stt',
    family: 'elevenlabs',
    envVar: 'ELEVENLABS_API_KEY',
    hermesEnvVars: ['ELEVENLABS_API_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'elevenlabs',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.elevenlabs.io/v1',
    // Scribe has no model endpoint: the documented list, labelled (§87).
    capabilities: { stt: true, listModels: true },
    settings: { model: 'scribe_v2', language: null, voice: null },
    hermesSpeech: {
      provider: 'elevenlabs',
      section: 'elevenlabs',
      modelKey: 'model_id',
      voiceKey: null,
      languageKey: 'language_code',
    },
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  // Deepgram: Nova transcription and Aura voices, one key. The model list and the voice list
  // are both its own `GET /v1/models` (§87). Hermes has no Deepgram voice backend.
  {
    slug: 'deepgram-stt',
    label: 'Deepgram — speech to text',
    kind: 'stt',
    family: 'deepgram',
    envVar: 'DEEPGRAM_API_KEY',
    hermesEnvVars: ['DEEPGRAM_API_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'deepgram',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.deepgram.com/v1',
    capabilities: { stt: true, listModels: true },
    settings: { model: 'nova-3', language: null, voice: null },
    keysUrl: 'https://console.deepgram.com',
  },
  {
    slug: 'deepgram-tts',
    label: 'Deepgram — text to speech',
    kind: 'tts',
    family: 'deepgram',
    envVar: 'DEEPGRAM_API_KEY',
    hermesEnvVars: ['DEEPGRAM_API_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'deepgram',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: 'https://api.deepgram.com/v1',
    capabilities: { tts: true, listModels: true, listVoices: true },
    settings: { model: 'aura-2', language: null, voice: null },
    speech: { maxInputChars: 2000 },
    keysUrl: 'https://console.deepgram.com',
  },
  // Azure AI Speech with a resource key: every neural voice of every locale (Saudi
  // `ar-SA-HamedNeural` / `ar-SA-ZariyahNeural` among them) and fast transcription. The key
  // belongs to a region, so the address is asked for, never guessed (§87).
  {
    slug: 'azure-tts',
    label: 'Azure Speech — text to speech',
    kind: 'tts',
    family: 'azure-speech',
    envVar: 'AZURE_SPEECH_KEY',
    hermesEnvVars: ['AZURE_SPEECH_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'azure',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: null,
    baseUrlExample: 'https://<region>.api.cognitive.microsoft.com',
    capabilities: { tts: true, listModels: false, listVoices: true },
    settings: { model: null, language: null, voice: null },
    keysUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
  },
  {
    slug: 'azure-stt',
    label: 'Azure Speech — speech to text',
    kind: 'stt',
    family: 'azure-speech',
    envVar: 'AZURE_SPEECH_KEY',
    hermesEnvVars: ['AZURE_SPEECH_KEY'],
    hermesProvider: null,
    hermesRoute: 'none',
    hermesApiMode: null,
    protocol: 'azure',
    apiMode: 'native',
    keyRequirement: 'required',
    baseUrl: null,
    baseUrlExample: 'https://<region>.api.cognitive.microsoft.com',
    capabilities: { stt: true, listModels: false },
    settings: { model: null, language: null, voice: null },
    keysUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
  },
  // Signed in to through Hermes (contract decision §55): Hermes's own device-code sign-in
  // for its provider `nous` (MIT source `hermes_cli/web_routers/oauth.py`). No key, and
  // no request from the hub itself: the `direct` agent refuses it by name.
  {
    slug: 'nous',
    label: 'Nous Portal',
    kind: 'llm',
    family: 'nous',
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: 'nous',
    hermesRoute: 'builtin',
    hermesApiMode: null,
    protocol: 'openai',
    apiMode: 'native',
    keyRequirement: 'optional',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://portal.nousresearch.com',
    signIn: true,
  },
  // Signed in to through Hermes (contract decision §55): Hermes's own device-code sign-in
  // for its provider `openai-codex` (MIT source `hermes_cli/web_routers/oauth.py`). No key, and
  // no request from the hub itself: the `direct` agent refuses it by name.
  {
    slug: 'openai-codex',
    label: 'ChatGPT / Codex (subscription)',
    kind: 'llm',
    family: 'openai-codex',
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: 'openai-codex',
    hermesRoute: 'builtin',
    hermesApiMode: null,
    protocol: 'openai',
    apiMode: 'native',
    keyRequirement: 'optional',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://developers.openai.com/codex',
    signIn: true,
  },
  // Signed in to through Hermes (contract decision §55): Hermes's own device-code sign-in
  // for its provider `xai-oauth` (MIT source `hermes_cli/web_routers/oauth.py`). No key, and
  // no request from the hub itself: the `direct` agent refuses it by name.
  {
    slug: 'xai-oauth',
    label: 'xAI Grok (SuperGrok / Premium+)',
    kind: 'llm',
    family: 'xai-oauth',
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: 'xai-oauth',
    hermesRoute: 'builtin',
    hermesApiMode: null,
    protocol: 'openai',
    apiMode: 'native',
    keyRequirement: 'optional',
    baseUrl: 'https://api.x.ai/v1',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth',
    signIn: true,
  },
  // Signed in to through Hermes (contract decision §55): Hermes's own device-code sign-in
  // for its provider `minimax-oauth` (MIT source `hermes_cli/web_routers/oauth.py`). No key, and
  // no request from the hub itself: the `direct` agent refuses it by name.
  {
    slug: 'minimax-oauth',
    label: 'MiniMax (sign-in)',
    kind: 'llm',
    family: 'minimax-oauth',
    envVar: null,
    hermesEnvVars: [],
    hermesProvider: 'minimax-oauth',
    hermesRoute: 'builtin',
    hermesApiMode: null,
    protocol: 'openai',
    apiMode: 'native',
    keyRequirement: 'optional',
    baseUrl: 'https://api.minimax.io/anthropic',
    capabilities: { chat: true, listModels: true },
    keysUrl: 'https://www.minimax.io',
    signIn: true,
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
export function secretNameOf(family: string, shared = false): string {
  // A shared key and the default profile's own key of the same family live in one
  // profile's `secrets`, so their names differ (contract decision §37).
  return shared ? `shared-provider:${family}` : `provider:${family}`;
}

// ------------------------------------------------------------------ Hermes names

/**
 * The prefix every `providers:` block the hub owns in Hermes's `config.yaml` carries.
 *
 * It is not decoration. Hermes refuses a `providers:` entry whose name is one of its own
 * canonical providers (`runtime_provider_custom.py` §`_shadowed_by_builtin`), and
 * `lmstudio` *is* one of those — a block named `lmstudio` would be silently ignored and
 * the run would fall through to OpenRouter. The prefix also tells a person reading the
 * file which blocks the hub rewrites and which are their own.
 */
export const HERMES_PROVIDER_PREFIX = derived.hermesProviderPrefix;
/**
 * The prefix the same blocks had before the rename (`majlis-`). Still the hub's: every
 * write replaces those blocks with the new names and rewrites what referred to them
 * (`propagation.ts` §migrateLegacyProviders).
 */
export const LEGACY_HERMES_PROVIDER_PREFIX = LEGACY.hermesProviderPrefix;

/**
 * The name Hermes knows one of our provider rows by: its own slug when Hermes ships the
 * provider, else the prefixed name of the `providers:` block the hub writes for it.
 *
 * `null` is the honest refusal of ADR 0010: this endpoint cannot be said to Hermes, so
 * nothing is written and the run is told why.
 */
export function hermesProviderNameOf(
  slug: string,
  entry: ProviderCatalogueEntry | undefined,
): string | null {
  const route = hermesRouteOf(entry);
  if (route === 'builtin') return entry?.hermesProvider ?? null;
  if (route === 'openai-compatible') return `${HERMES_PROVIDER_PREFIX}${slug}`;
  return null;
}

/**
 * The route for a provider row. A row created from the repeatable `openai-compatible`
 * preset has its own slug (`custom-…`) and therefore **no catalogue entry at all** — and
 * it is precisely an OpenAI-compatible endpoint, which is what the person was asked for
 * when they typed its address. That is the `undefined` case, and getting it wrong is the
 * defect of 2026-09-22: those rows reached Hermes as nothing.
 */
export function hermesRouteOf(entry: ProviderCatalogueEntry | undefined): HermesRouteKind {
  return entry?.hermesRoute ?? 'openai-compatible';
}

/**
 * The variable Hermes reads this route's key from.
 *
 * A provider with a name the world agrees on keeps it (`GROQ_API_KEY`), so a key the
 * owner already has in the file is the key Hermes uses. A local server or somebody's own
 * endpoint has no such name, so the hub mints one per provider row — `key_env` in the
 * `providers:` block points at it, and the `.env` merge owns it.
 */
export function hermesKeyEnvOf(slug: string, entry: ProviderCatalogueEntry | undefined): string {
  if (entry?.envVar) return entry.envVar;
  const sanitized = slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${derived.providerKeyEnvPrefix}${sanitized || 'CUSTOM'}_API_KEY`;
}

/**
 * The name the hub minted for the same key before the rename (`MAJLIS_PROVIDER_…`), or
 * null for a name the world agrees on. The hub still owns it in Hermes's `.env`, which is
 * what removes the old line once the new one is written.
 */
export function legacyHermesKeyEnvOf(name: string): string | null {
  if (!name.startsWith(derived.providerKeyEnvPrefix)) return null;
  return `${LEGACY.providerKeyEnvPrefix}${name.slice(derived.providerKeyEnvPrefix.length)}`;
}

/**
 * Our `api_mode` in Hermes's words. `native` is our name for "the provider's own wire",
 * which is not a transport Hermes has a name for — so it is left out and Hermes detects
 * one from the URL, rather than being handed a value it would discard.
 */
export function hermesApiModeOf(apiMode: ApiMode): 'chat_completions' | 'responses' | null {
  return apiMode === 'native' ? null : apiMode;
}

/** The address Hermes should call, which is our row's address except where noted. */
export function hermesBaseUrlOf(
  baseUrl: string,
  entry: ProviderCatalogueEntry | undefined,
): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const suffix = entry?.hermesBaseUrlSuffix;
  if (!suffix) return trimmed;
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
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
    // An entry with no world-wide variable name has no *shared* one to propagate: a local
    // server's key is nobody else's `LMSTUDIO_API_KEY`. It may still reach Hermes, under a
    // name the hub mints for that one route (`hermesKeyEnvOf`), which is what makes a
    // custom endpoint usable at all.
    if (!entry.envVar && entry.hermesEnvVars.length > 0) {
      throw new Error(
        `provider catalogue: "${entry.slug}" names no variable but claims Hermes variables`,
      );
    }
    if (entry.hermesRoute === 'builtin' && !entry.hermesProvider) {
      throw new Error(`provider catalogue: "${entry.slug}" is builtin but names no Hermes slug`);
    }
    if (entry.hermesRoute !== 'builtin' && entry.hermesProvider) {
      throw new Error(
        `provider catalogue: "${entry.slug}" names a Hermes slug but is not routed to it`,
      );
    }
    // A block the hub writes under `providers:` needs an address to call. A preset with
    // none asks the person for one (`base_url_required`), and the row carries it.
    if (entry.hermesRoute === 'none' && entry.kind === 'llm') {
      throw new Error(
        `provider catalogue: chat provider "${entry.slug}" must be expressible to Hermes`,
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
    // A sign-in is Hermes's (decision §55): its own provider, no key the hub could hold.
    if (entry.signIn && (entry.hermesRoute !== 'builtin' || entry.keyRequirement !== 'optional')) {
      throw new Error(
        `provider catalogue: "${entry.slug}" signs in through Hermes, so it is Hermes's own ` +
          'provider and takes no key',
      );
    }
    // A repeatable entry is added more than once, so it cannot own a shared family row.
    if (entry.repeatable && entry.family !== 'custom') {
      throw new Error(`provider catalogue: repeatable "${entry.slug}" must be its own family`);
    }
  }
}
