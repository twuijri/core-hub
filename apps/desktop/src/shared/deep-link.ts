/**
 * `corehub://` links and the pairing payload, parsed into something the app can act on.
 *
 * Three links exist, and nothing else is accepted:
 *
 *   corehub://open/<app path>                  open a page of the web client (a chat, a task)
 *   corehub://connect?hub=<origin>             start remote mode against that hub
 *   corehub://pair?hub=<origin>&id=<ulid>&code=<code>
 *                                              claim a pairing a signed-in client started
 *
 * The pairing QR the hub draws (`auth.createPairing` → `qr_payload`) is JSON of type
 * `corehub.pairing`; pasting that JSON is the same as opening the `pair` link. A link comes
 * from outside the app (a browser, a chat message), so every field is validated here and an
 * app path can never leave the app's own origin.
 */
import { normalizeHubUrl } from './hub-url.js';

export const SCHEME = 'corehub';
/** The QR payload's `type` (`derived.pairingType` in @corehub/contracts). */
export const PAIRING_TYPE = 'corehub.pairing';
/** The type older hubs wrote before the rename (ADR 0017). */
const LEGACY_PAIRING_TYPE = 'majlis.pairing';

export interface PairingRequest {
  hub: string;
  pairingId: string;
  code: string;
}

export type DeepLink =
  | { kind: 'open'; path: string }
  | { kind: 'connect'; hub: string }
  | { kind: 'pair'; pairing: PairingRequest };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE = /^[A-Za-z0-9-]{4,32}$/;
/** An app path: absolute, no scheme, no `..`, no backslash, nothing that could be a host. */
const APP_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/%]*(\?[A-Za-z0-9\-._~%=&+]*)?$/;

export function isSafeAppPath(value: string): boolean {
  return APP_PATH.test(value) && !value.split(/[/?]/).includes('..');
}

function pairingFrom(hub: unknown, id: unknown, code: unknown): PairingRequest | null {
  if (typeof hub !== 'string' || typeof id !== 'string' || typeof code !== 'string') return null;
  const origin = normalizeHubUrl(hub);
  if (!origin.ok) return null;
  const pairingId = id.trim().toUpperCase();
  const trimmedCode = code.trim().toUpperCase();
  if (!ULID.test(pairingId) || !CODE.test(trimmedCode)) return null;
  return { hub: origin.origin, pairingId, code: trimmedCode };
}

export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) return null;
  // `corehub://open/chat/1` parses with host `open`; `corehub:open/chat/1` with none.
  const [action = '', ...rest] = `${url.host}${url.pathname}`.replace(/^\/+/, '').split('/');
  switch (action) {
    case 'open': {
      const path = `/${rest.join('/')}${url.search}`;
      return isSafeAppPath(path) ? { kind: 'open', path } : null;
    }
    case 'connect': {
      const hub = normalizeHubUrl(url.searchParams.get('hub') ?? '');
      return hub.ok ? { kind: 'connect', hub: hub.origin } : null;
    }
    case 'pair': {
      const pairing = pairingFrom(
        url.searchParams.get('hub'),
        url.searchParams.get('id'),
        url.searchParams.get('code'),
      );
      return pairing ? { kind: 'pair', pairing } : null;
    }
    default:
      return null;
  }
}

/** A pasted pairing: the QR's JSON, or a `corehub://pair` link. */
export function parsePairingInput(raw: string): PairingRequest | null {
  const text = raw.trim();
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (value.type !== PAIRING_TYPE && value.type !== LEGACY_PAIRING_TYPE) return null;
      if (typeof value.expires_at === 'string' && Date.parse(value.expires_at) < Date.now())
        return null;
      return pairingFrom(value.hub_url, value.pairing_id, value.code);
    } catch {
      return null;
    }
  }
  const link = parseDeepLink(text);
  return link?.kind === 'pair' ? link.pairing : null;
}

/** The deep link in a command line (Windows and Linux hand the URL to the app as an argument). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${SCHEME}:`)) ?? null;
}

/** The `pair` link for a pairing, the form the web client offers to copy. */
export function pairingLink(pairing: PairingRequest): string {
  const query = new URLSearchParams({
    hub: pairing.hub,
    id: pairing.pairingId,
    code: pairing.code,
  });
  return `${SCHEME}://pair?${query.toString()}`;
}
