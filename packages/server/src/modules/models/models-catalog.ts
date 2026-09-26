/**
 * The shared models catalogue (decision §110): `catalog/models.json` in the Core Hub repository,
 * read by every hub from GitHub, so a list kept by hand — the ChatGPT subscription's image
 * models, which its backend never lists — reaches hubs that have not pulled a new image. A hub
 * that runs the same image for six months still offers the models of today, and a model that is
 * gone is gone for it too.
 *
 * The file is only ever data: names that must look like image-model names and a version that
 * must look like X.Y.Z; anything else in it is ignored, and a file that does not parse is as if
 * it were not there. It is read at most every twelve hours, when a list is asked for; the hub
 * waits for it at most a few seconds and otherwise goes on with what it knew (the built-in lists
 * on a fresh start). `COREHUB_MODELS_CATALOG_URL=off` stops the reads.
 */
import { isCodexImageName } from './images.js';

/** What a hub takes from the catalogue for one provider. */
export interface CatalogProvider {
  /**
   * The provider's models, as the Core Hub team keeps them: offered only when the provider
   * itself cannot be asked for its list (instead of the list built into the image, which ages
   * with it). A list the provider answers for the account always wins.
   */
  models: string[];
  /** Image models a chat provider draws with but never lists (the ChatGPT subscription's). */
  imageModels: string[];
  /** The lowest client version to ask the provider's list as (the Codex CLI's), or null. */
  clientVersion: string | null;
}

/** What a hub takes from the catalogue, by Hermes provider id or preset slug. */
export interface ModelsCatalog {
  providers: Record<string, CatalogProvider>;
}

/** How long a read catalogue is trusted before it is read again. */
export const MODELS_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

/** A model id as providers write them: `claude-opus-4-7`, `models/gemini-3-pro`, `org/name:tag`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const names = (value: unknown, accept: (name: string) => boolean): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.trim())
            .filter(accept),
        ),
      ].slice(0, 200)
    : [];

/** The catalogue's file, as `catalog/models.json` holds it; null when it is not one. */
export function parseModelsCatalog(json: unknown): ModelsCatalog | null {
  if (!json || typeof json !== 'object') return null;
  const body = json as { schema?: unknown; providers?: unknown };
  if (body.schema !== 1 || !body.providers || typeof body.providers !== 'object') return null;
  const providers: Record<string, CatalogProvider> = {};
  for (const [key, value] of Object.entries(body.providers as Record<string, unknown>).slice(
    0,
    64,
  )) {
    if (!PROVIDER_KEY.test(key) || !value || typeof value !== 'object') continue;
    const entry = value as { models?: unknown; image_models?: unknown; client_version?: unknown };
    const version =
      typeof entry.client_version === 'string' &&
      /^\d+\.\d+\.\d+$/.test(entry.client_version.trim())
        ? entry.client_version.trim()
        : null;
    providers[key] = {
      models: names(entry.models, (name) => MODEL_ID.test(name)),
      imageModels: names(entry.image_models, isCodexImageName),
      clientVersion: version,
    };
  }
  return { providers };
}

/**
 * The catalogue as this hub last read it, read again when it is older than twelve hours. Never
 * throws; null until a read succeeded (or when `url` is null).
 */
export function modelsCatalogSource(options: {
  url: string | null;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  waitMs?: number;
}): () => Promise<ModelsCatalog | null> {
  const { url } = options;
  const fetcher = options.fetch ?? ((target, init) => fetch(target, init));
  const now = options.now ?? (() => Date.now());
  const waitMs = options.waitMs ?? 5_000;
  let known: ModelsCatalog | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;

  const read = async (target: string): Promise<void> => {
    try {
      const response = await fetcher(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'core-hub' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return;
      const text = await response.text();
      if (text.length > 64 * 1024) return;
      const parsed = parseModelsCatalog(JSON.parse(text));
      if (parsed) known = parsed;
    } catch {
      // Offline, blocked or not JSON: what was known is kept.
    }
  };

  return async () => {
    if (!url) return null;
    if (now() - readAt >= MODELS_CATALOG_TTL_MS) {
      readAt = now();
      reading = read(url).finally(() => {
        reading = null;
      });
    }
    if (reading) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        reading,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return known;
  };
}
