/**
 * What `/corehub link …` accepts, parsed into one pairing to claim (ADR 0033 §2). Three forms,
 * the same ones the other clients take (DECISIONS §15):
 *
 *   {"type":"corehub.pairing","hub_url":"https://hub.example","pairing_id":"01J…","code":"ABCD-1234"}
 *   corehub://pair?hub=https://hub.example&id=01J…&code=ABCD-1234
 *   https://hub.example 01J… ABCD-1234          (the hub's address, the pairing id and the code)
 *
 * Pure: no network, no file. Every field is validated here, because the text comes from the
 * person's clipboard.
 */
import { LEGACY, PRODUCT, derived } from '@corehub/contracts';

export interface PairingInput {
  hub: string;
  pairingId: string;
  code: string;
}

export type PairingParse =
  | { ok: true; pairing: PairingInput }
  | { ok: false; error: 'empty' | 'json_invalid' | 'hub_invalid' | 'fields_missing' };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE = /^[A-Za-z0-9-]{4,32}$/;

/** A hub address: `http(s)://host[:port]`, answered as its origin; anything else is refused. */
export function normaliseHub(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

function pairingOf(hub: unknown, id: unknown, code: unknown): PairingParse {
  if (typeof id !== 'string' || typeof code !== 'string' || typeof hub !== 'string')
    return { ok: false, error: 'fields_missing' };
  const origin = normaliseHub(hub);
  if (!origin) return { ok: false, error: 'hub_invalid' };
  const pairingId = id.trim().toUpperCase();
  const cleanCode = code.trim().toUpperCase();
  if (!ULID.test(pairingId) || !CODE.test(cleanCode)) return { ok: false, error: 'fields_missing' };
  return { ok: true, pairing: { hub: origin, pairingId, code: cleanCode } };
}

/**
 * @param raw - what the person typed after `/corehub link`.
 * @param knownHub - the hub this harness was linked to before, used when only the id and the
 *   code are given.
 */
export function parsePairing(raw: string, knownHub: string | null = null): PairingParse {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'empty' };

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'json_invalid' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { ok: false, error: 'json_invalid' };
    const p = parsed as Record<string, unknown>;
    // A code shown by a hub from before the rename says `majlis.pairing` (ADR 0017).
    if (p.type !== derived.pairingType && p.type !== LEGACY.pairingType)
      return { ok: false, error: 'json_invalid' };
    return pairingOf(p.hub_url ?? knownHub, p.pairing_id, p.code);
  }

  const schemes = [`${PRODUCT.id}:`, `${LEGACY.id}:`];
  if (schemes.some((scheme) => text.toLowerCase().startsWith(scheme))) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, error: 'fields_missing' };
    }
    const action = `${url.host}${url.pathname}`.replace(/^\/+/, '').split('/')[0];
    if (action !== 'pair') return { ok: false, error: 'fields_missing' };
    return pairingOf(
      url.searchParams.get('hub') ?? knownHub,
      url.searchParams.get('id'),
      url.searchParams.get('code'),
    );
  }

  const tokens = text.split(/\s+/);
  const hub = tokens.find((t) => /^https?:\/\//i.test(t)) ?? null;
  const rest = tokens.filter((t) => t !== hub);
  const id = rest.find((t) => ULID.test(t.toUpperCase()));
  const code = rest.find((t) => t !== id);
  if (hub !== null && normaliseHub(hub) === null) return { ok: false, error: 'hub_invalid' };
  return pairingOf(hub ?? knownHub, id, code);
}
