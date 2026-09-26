// Who is asking: the client address the hub counts sign-in failures, lockouts and audit lines
// against. A reverse proxy (Caddy, Traefik, cloudflared, `tailscale serve`) connects to the hub
// itself and says who its client was in `X-Forwarded-For`; any other caller can write that
// header too. So the header is believed only from the proxies the hub trusts
// (`COREHUB_TRUST_PROXY`, read in app/config.ts), and the client is the right-most address that
// is not one of them — the same rule as Fastify's `request.ip` (proxy-addr), which is given the
// same trust function, so HTTP and Socket.IO agree on who asked.
import { BlockList, isIP } from 'node:net';

/** Which peers may say who their client was (`X-Forwarded-For`, `-Host`, `-Proto`). */
export type TrustProxySetting =
  /** Nobody: the address is always the TCP peer's. */
  | { kind: 'none' }
  /** Peers inside these addresses / CIDR ranges. */
  | { kind: 'addresses'; entries: readonly string[] }
  /** The first `hops` addresses, whoever they are (only when nothing reaches the hub directly). */
  | { kind: 'hops'; hops: number };

/**
 * The default: loopback plus the private and unique-local ranges. A proxy in the same Docker
 * network (Caddy, Traefik), or one on the same machine (cloudflared, `tailscale serve`),
 * connects from one of these; a client on the internet does not, so what it writes in
 * `X-Forwarded-For` is ignored.
 */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

export const DEFAULT_TRUST_PROXY: TrustProxySetting = {
  kind: 'addresses',
  entries: DEFAULT_TRUSTED_PROXIES,
};

/** `(address, hop) => trusted?` — the shape Fastify's `trustProxy` option and proxy-addr take. */
export type TrustFn = (address: string | undefined, hop: number) => boolean;

/** Splits `a.b.c.d/nn` or `a::b/nn` (or a bare address) into its parts; null when invalid. */
export function parseAddressRange(
  entry: string,
): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [address = '', prefixText, extra] = entry.trim().split('/');
  if (extra !== undefined) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  const max = version === 4 ? 32 : 128;
  if (prefixText === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  return { address, prefix, family };
}

export function compileTrust(setting: TrustProxySetting): TrustFn {
  if (setting.kind === 'none') return () => false;
  if (setting.kind === 'hops') {
    const hops = setting.hops;
    return (_address, hop) => hop < hops;
  }
  const list = new BlockList();
  for (const entry of setting.entries) {
    const range = parseAddressRange(entry);
    if (!range) throw new Error(`not an IP address or CIDR range: ${entry}`);
    list.addSubnet(range.address, range.prefix, range.family);
  }
  return (address) => {
    if (!address) return false;
    const version = isIP(address);
    if (version === 0) return false;
    try {
      // An IPv4 client seen on a dual-stack socket (`::ffff:10.0.0.5`) matches the IPv4 ranges.
      return list.check(address, version === 4 ? 'ipv4' : 'ipv6');
    } catch {
      return false;
    }
  };
}

/**
 * The client behind `peer` (the TCP peer's address): walk `X-Forwarded-For` from the right,
 * past every trusted proxy, and stop at the first address that is not one. Addresses to the
 * left of it were written by someone the hub does not trust and are never looked at.
 */
export function clientAddressFrom(
  peer: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trust: TrustFn,
): string {
  const header = typeof forwardedFor === 'string' ? forwardedFor : (forwardedFor ?? []).join(',');
  const forwarded = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .reverse();
  const chain = [peer ?? '', ...forwarded];
  for (let hop = 0; hop < chain.length - 1; hop += 1) {
    if (!trust(chain[hop], hop)) return chain[hop] ?? '';
  }
  return chain[chain.length - 1] ?? '';
}

/** The client address of each Socket.IO connection, recorded once at the handshake. */
const socketAddresses = new WeakMap<object, string>();

export function setSocketAddress(socket: object, address: string): void {
  socketAddresses.set(socket, address);
}

/**
 * The client behind a Socket.IO connection, by the same rule as `request.ip`. A socket the
 * hub's first middleware never saw (a test's bare server) falls back to the TCP peer, which
 * nobody can write.
 */
export function socketAddressOf(socket: { handshake: { address: string } }): string {
  return socketAddresses.get(socket) ?? socket.handshake.address;
}
