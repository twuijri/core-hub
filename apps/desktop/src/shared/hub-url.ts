/**
 * What a person types as "the hub's address", made into the one origin the app talks to.
 *
 * People paste all sorts of things: `hub.example`, `https://hub.example/`, a link to a chat
 * (`https://hub.example/chat/01J…`), `192.168.1.10:8080`. The app needs the origin only —
 * the web client adds the API prefix and `/rt` itself — so everything after the host is dropped.
 * A bare host gets `https://`, except a private or loopback address, which is nearly always
 * a hub on the LAN without TLS.
 */
export type HubUrlResult = { ok: true; origin: string } | { ok: false; reason: HubUrlProblem };
export type HubUrlProblem = 'empty' | 'invalid' | 'scheme' | 'credentials';

const PRIVATE_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[a-z0-9-]+\.local)$/i;

export function normalizeHubUrl(input: string): HubUrlResult {
  const text = input.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let candidate = text;
  if (!hasScheme) {
    const host = text.split(/[/?#]/)[0] ?? '';
    const hostOnly = host.replace(/:\d+$/, '');
    candidate = `${PRIVATE_HOST.test(hostOnly) ? 'http' : 'https'}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (!url.hostname) return { ok: false, reason: 'invalid' };
  return { ok: true, origin: url.origin };
}

/**
 * A short, stable name for a hub's storage partition. Each hub gets its own cookie jar and
 * localStorage, so switching between two hubs never hands one hub's token to the other.
 * FNV-1a is enough: this is a folder name, not a secret.
 */
export function partitionKey(origin: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < origin.length; i += 1) {
    hash ^= origin.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
