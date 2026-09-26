/**
 * The profile's image model (contract decision §72, the Models → Images tab).
 *
 * There are no image providers of their own: an image model is a model of one of the chat
 * providers the profile already has — a `gpt-image-*` on OpenAI, a `gemini-*-image` behind
 * cli-proxy-api, a FLUX on an OpenAI-compatible host. This file answers three questions about
 * such a model, and nothing else:
 *
 * - is it one (`isImageModel`) — the provider says so where it can, else the id does;
 * - how is it spoken to (`imageProtocolOf`) — the three shapes the hub's `image_api.py` speaks;
 * - what does a profile's Hermes home need to use it (`IMAGE_ENV`, `HERMES_IMAGE_PLUGIN`).
 *
 * The values themselves (address, key, model) are resolved by the service; this file never
 * sees a key.
 */
import { PRODUCT, derived } from '@corehub/contracts';
import type { ModelCapability } from './schema.js';

/**
 * Ids that name a model which answers with pictures. Deliberately about families, not
 * versions: `gpt-image-2`, `gemini-3.1-flash-image`, `imagen-4.0-generate-001`,
 * `black-forest-labs/flux-1.1-pro`, `grok-2-image` all match, and so will next year's.
 */
const IMAGE_MODEL_ID =
  /(?:^|[/:._-])(?:image|images|dall-e|dalle|imagen|flux|stable-diffusion|sdxl|sd3|seedream|hidream|recraft|ideogram|kolors|nano-banana)(?:$|[/:._-])/i;

/** True when the model draws: its provider said so, or its id says so. */
export function isImageModel(
  modelKey: string,
  capabilities: readonly ModelCapability[] = [],
): boolean {
  return capabilities.includes('image_output') || IMAGE_MODEL_ID.test(modelKey);
}

/** The capabilities a model is served with: what was stored, plus `image_output` by its id. */
export function withImageCapability(
  modelKey: string,
  capabilities: readonly ModelCapability[],
): ModelCapability[] {
  const out = [...capabilities];
  if (!out.includes('image_output') && IMAGE_MODEL_ID.test(modelKey)) out.push('image_output');
  return out;
}

/**
 * The families spoken to through the OpenAI Images API (`/images/generations`,
 * `/images/edits`). Everything else on an OpenAI-compatible endpoint — a chat model that
 * draws, such as `gemini-*-image` behind a proxy or on OpenRouter — answers on
 * `/chat/completions` with image output.
 */
const IMAGES_API_MODEL =
  /(?:^|[/:._-])(?:gpt-image|chatgpt-image|dall-e|dalle|imagen|flux|stable-diffusion|sdxl|sd3|seedream|hidream|recraft|ideogram|kolors|qwen-image)/i;

/**
 * True when the model answers with images only (contract decision §87): the Images-API families
 * above — `gpt-image-*` (the ChatGPT subscription's too), DALL·E, Imagen, FLUX … — which take a
 * prompt and give back a picture, never a turn of conversation. Chosen as a chat model, such a
 * model fails the turn, so the clients keep it out of every chat-model picker. A chat model that
 * draws (`gemini-*-image`, `gpt-5-image`) chats as well, and is not one.
 */
export function isImageOnlyModel(
  modelKey: string,
  capabilities: readonly ModelCapability[] = [],
): boolean {
  return isImageModel(modelKey, capabilities) && IMAGES_API_MODEL.test(modelKey);
}

/** How `image_api.py` speaks to the model: its `COREHUB_IMAGE_PROVIDER`. */
export type ImageProtocol = 'gemini' | 'compatible' | 'chat' | 'codex';

/**
 * Images through the ChatGPT subscription (decisions §84, §110). The Codex backend lists no image
 * model; it draws when a chat model it serves is handed the `image_generation` tool with an
 * image model named in it. The hub offers each image model the tool takes as a model of the
 * signed-in provider, labelled by the clients as the subscription's — the only models the hub
 * adds to a provider's list, because there is no other way to choose them.
 */
export const CODEX_IMAGES = {
  /** Hermes's provider id of the ChatGPT / Codex subscription. */
  hermesProvider: 'openai-codex',
  /** The image model chosen when none is named (`COREHUB_IMAGE_MODEL`). */
  model: 'gpt-image-2',
  /**
   * Every image model the tool is known to take, newest first (§110): the GPT Image 2.5 family
   * OpenAI added in September 2026, then `gpt-image-2` and `gpt-image-1.5`. The backend has no
   * list to ask, so this one is kept by hand; an owner adds a new name without a release through
   * `COREHUB_CODEX_IMAGE_MODELS` (see {@link codexImageModels}).
   */
  models: [
    'gpt-image-2.5',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2',
    'gpt-image-1.5',
  ],
  /** The chat model that carries the tool call (fixed in `image_api.py`). */
  host: 'gpt-5.5',
} as const;

/** A name the image tool could take: `gpt-image-…` or `chatgpt-image-…`, nothing else. */
const CODEX_IMAGE_NAME = /^(?:gpt-image|chatgpt-image)-[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The subscription's image models: {@link CODEX_IMAGES.models}, plus any names the hub's
 * environment adds in `COREHUB_CODEX_IMAGE_MODELS` (comma-separated, put first) so a model OpenAI
 * ships tomorrow can be offered before the next release. Names that are not image-model names
 * are ignored.
 */
export function codexImageModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env[`${derived.envPrefix}CODEX_IMAGE_MODELS`] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => CODEX_IMAGE_NAME.test(name));
  return [...new Set([...extra, ...CODEX_IMAGES.models])];
}

/**
 * The shape a provider protocol and a model are spoken to in, or null when the hub cannot
 * draw with it at all (Anthropic answers no image; Ollama serves none; a speech protocol is
 * not a drawing one).
 */
export function imageProtocolOf(
  providerProtocol: string,
  modelKey: string,
  hermesProvider?: string | null,
): ImageProtocol | null {
  // The subscription draws through its own backend, and only with the image models it offers.
  if (hermesProvider === CODEX_IMAGES.hermesProvider) {
    return codexImageModels().includes(modelKey) ? 'codex' : null;
  }
  if (providerProtocol === 'google') return 'gemini';
  if (providerProtocol !== 'openai') return null;
  return IMAGES_API_MODEL.test(modelKey) ? 'compatible' : 'chat';
}

/**
 * The variables a profile's Hermes home carries its image model in. The hub owns them in
 * every `.env` it writes: set while a model is chosen, removed when none is. The skills
 * declare them (`required_environment_variables`), which is what lets Hermes hand them to the
 * terminal; the Hermes plugin reads them through Hermes's own secret scope.
 */
export const IMAGE_ENV = {
  provider: `${derived.envPrefix}IMAGE_PROVIDER`,
  baseUrl: `${derived.envPrefix}IMAGE_BASE_URL`,
  model: `${derived.envPrefix}IMAGE_MODEL`,
  apiKey: `${derived.envPrefix}IMAGE_API_KEY`,
} as const;

export const IMAGE_ENV_NAMES: readonly string[] = Object.values(IMAGE_ENV);

/**
 * The image backend the hub gives Hermes (`plugins/image_gen/<name>/` in a Hermes home):
 * Hermes ships no backend that takes an arbitrary OpenAI-compatible address, key and model,
 * so the hub brings one, and it runs the same `image_api.py` the skills run.
 */
export const HERMES_IMAGE_PLUGIN = {
  /** `image_gen.provider` names it by this. */
  name: `${PRODUCT.id}-images`,
  /** Its `plugins.enabled` key: the path under `plugins/`. */
  key: `image_gen/${PRODUCT.id}-images`,
} as const;

/** What one profile's image model is, resolved: the `.env` values its Hermes home gets. */
export interface ImageChoice {
  protocol: ImageProtocol;
  baseUrl: string;
  model: string;
  /**
   * Plaintext, or null for an endpoint that takes none — and always null for `codex`, whose
   * token Hermes keeps and `image_api.py` asks Hermes for. Only ever written to `.env`.
   */
  apiKey: string | null;
}

/** The variables for a choice; a key that is absent is left out, never written empty. */
export function imageEnvOf(choice: ImageChoice | null): Record<string, string> {
  if (!choice) return {};
  return {
    [IMAGE_ENV.provider]: choice.protocol,
    [IMAGE_ENV.baseUrl]: choice.baseUrl,
    [IMAGE_ENV.model]: choice.model,
    ...(choice.apiKey ? { [IMAGE_ENV.apiKey]: choice.apiKey } : {}),
  };
}
