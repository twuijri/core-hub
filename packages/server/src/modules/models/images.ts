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

/** How `image_api.py` speaks to the model: its `COREHUB_IMAGE_PROVIDER`. */
export type ImageProtocol = 'gemini' | 'compatible' | 'chat';

/**
 * The shape a provider protocol and a model are spoken to in, or null when the hub cannot
 * draw with it at all (Anthropic answers no image; Ollama serves none; a speech protocol is
 * not a drawing one).
 */
export function imageProtocolOf(providerProtocol: string, modelKey: string): ImageProtocol | null {
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
  /** Plaintext, or null for an endpoint that takes none. Only ever written to `.env`. */
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
