/**
 * The events a webhook can subscribe to, read from the contract (decision §52).
 *
 * `WebhookEventName` in `openapi.yaml` is the whole list: the names, the realtime namespace
 * each one is emitted on (`source`), a description in both languages, and the fields of the
 * event's payload that carry what people wrote — left out of a delivery unless the webhook
 * says `include_content`. Nothing here lists an event of its own; adding one is a contract
 * change the hub then follows.
 */
import { loadOpenApiDocument } from '@corehub/contracts';

export interface CatalogueEntry {
  name: string;
  /** The realtime namespace the event is emitted on, e.g. `/rt/sessions`. */
  namespace: string;
  description: { ar: string; en: string };
  /** Dotted paths into the payload that are removed when content is not included. */
  content: string[];
}

interface ContractEntry {
  source: string;
  description: { ar: string; en: string };
  content?: string[];
}

let cached: Map<string, CatalogueEntry> | null = null;

export function webhookCatalogue(): Map<string, CatalogueEntry> {
  if (cached) return cached;
  const document = loadOpenApiDocument() as unknown as {
    components?: {
      schemas?: Record<
        string,
        { enum?: string[]; 'x-webhook-events'?: Record<string, ContractEntry> }
      >;
    };
  } | null;
  const schema = document?.components?.schemas?.WebhookEventName;
  const entries = schema?.['x-webhook-events'] ?? {};
  const catalogue = new Map<string, CatalogueEntry>();
  for (const name of schema?.enum ?? []) {
    const entry = entries[name];
    if (!entry) continue;
    catalogue.set(name, {
      name,
      namespace: `/rt/${entry.source}`,
      description: entry.description,
      content: entry.content ?? [],
    });
  }
  cached = catalogue;
  return catalogue;
}

/**
 * A copy of the payload without the content paths. The copy is deep and JSON-only, so what
 * is stored is exactly what will be sent, and a caller that later changes its own object
 * changes nothing here.
 */
export function withoutContent(
  payload: unknown,
  paths: readonly string[],
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(payload ?? {})) as Record<string, unknown>;
  for (const dotted of paths) {
    const keys = dotted.split('.');
    const last = keys.pop();
    if (!last) continue;
    let node: unknown = copy;
    for (const key of keys) {
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    }
    if (node && typeof node === 'object') delete (node as Record<string, unknown>)[last];
  }
  return copy;
}
