/**
 * Whether the hub may POST to a URL a person typed.
 *
 * A webhook is an address the hub will call on its own, from inside the network it runs
 * in. Without a rule, "add a webhook" is "ask the hub to knock on any door it can reach" —
 * the router's admin page, a database's health endpoint, a cloud metadata service. That is
 * server-side request forgery, and the fix is not to trust the string.
 *
 * So: `http`/`https` only, and no address that resolves to a private, loopback,
 * link-local or reserved range — unless the webhook says `allow_private_network`, which a
 * person turns on deliberately for a hub that really does call something on its own LAN.
 *
 * The check is on the **resolved** addresses, not on the hostname, because a public name
 * can point anywhere. A name that resolves to nothing is refused rather than attempted.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type AddressVerdict =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: 'scheme' | 'unresolvable' | 'private'; detail: string };

/** Ranges nobody should be able to make this hub call by typing a URL. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Link-local, including the 169.254.169.254 cloud metadata address.
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT and the benchmarking range.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true;
    // IPv4-mapped: judge the address it maps to.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export async function checkAddress(
  url: string,
  allowPrivate: boolean,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<AddressVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'scheme', detail: 'not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme', detail: parsed.protocol };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return { ok: false, reason: 'unresolvable', detail: host };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable', detail: host };
  if (!allowPrivate) {
    const priv = addresses.find((address) => isPrivateAddress(address));
    if (priv) return { ok: false, reason: 'private', detail: priv };
  }
  return { ok: true, addresses };
}

async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true });
  return found.map((entry) => entry.address);
}
