/**
 * The way in from outside for the hub this app runs (local mode; DECISIONS §95, proposed —
 * owner to confirm): what is pure about it, so it is tested without Electron or a network.
 *
 * Two routes, both on an account of the person's own:
 * - **Cloudflare Tunnel.** The person makes a tunnel in their Cloudflare dashboard (Zero Trust ›
 *   Networks › Tunnels), points a public hostname at `http://localhost:<hub port>` and pastes the
 *   tunnel's token here. The app keeps the token sealed by the OS keychain and runs Cloudflare's
 *   own `cloudflared` with it — downloaded once from Cloudflare's GitHub releases at the version
 *   and SHA-256 pinned below, never anything else.
 * - **Tailscale.** When this computer is on a tailnet, the app also listens on its tailnet
 *   address (100.64.0.0/10), and only there, forwarding to the hub.
 *
 * Either way the hub keeps its own sign-in; the way in only carries the hub's port.
 */
import { isIP } from 'node:net';

export type RelayRoute = 'cloudflare' | 'tailscale';

export type RelayErrorCode =
  | 'token_invalid'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'unsupported_platform'
  | 'start_failed'
  | 'tunnel_exited'
  | 'not_on_tailnet'
  | 'listen_failed';

/** The contract's `Relay` without `available` (the hub adds it). */
export interface RelayState {
  enabled: boolean;
  connected: boolean;
  route: RelayRoute | null;
  relay_url: string | null;
  hub_port: number | null;
  token_set: boolean;
  tunnel_id: string | null;
  hostname: string | null;
  hostnames: Array<{ hostname: string; service: string; matches: boolean }>;
  tailnet: { address: string; dns_name: string | null } | null;
  error: RelayErrorCode | null;
  error_detail: string | null;
  connected_at: string | null;
}

/** The contract's `RelayUpdate`, as the hub checked it. */
export interface RelayChange {
  enabled?: boolean;
  route?: RelayRoute;
  token?: string;
  forget_token?: boolean;
  hostname?: string | null;
}

/** What `desktop.json` keeps (`relay`). */
export interface RelayConfig {
  enabled: boolean;
  route: RelayRoute | null;
  /** Sealed by the OS keychain (`sealText`); never shown, logged or sent anywhere. */
  token: string | null;
  hostname: string | null;
}

export const DEFAULT_RELAY: RelayConfig = {
  enabled: false,
  route: null,
  token: null,
  hostname: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parseRelayConfig(raw: unknown): RelayConfig {
  if (!isRecord(raw)) return { ...DEFAULT_RELAY };
  const route = raw.route === 'cloudflare' || raw.route === 'tailscale' ? raw.route : null;
  return {
    enabled: raw.enabled === true && route !== null,
    route,
    token: typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : null,
    hostname:
      typeof raw.hostname === 'string' && /^[a-z0-9.-]{3,253}$/.test(raw.hostname)
        ? raw.hostname
        : null,
  };
}

/**
 * A Cloudflare tunnel token: base64 of `{"a": account tag, "t": tunnel id, "s": secret}`. The
 * tunnel id is shown on the page (it is not a secret); the rest never leaves the keychain.
 */
export function parseTunnelToken(raw: string): { accountTag: string; tunnelId: string } | null {
  const token = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(token)) return null;
  try {
    const json = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof json.a !== 'string' ||
      !json.a ||
      typeof json.t !== 'string' ||
      !json.t ||
      typeof json.s !== 'string' ||
      !json.s
    )
      return null;
    return { accountTag: json.a, tunnelId: json.t.slice(0, 64) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ cloudflared

/** The one `cloudflared` this app runs: Cloudflare's release, checked by its published SHA-256. */
export const CLOUDFLARED_VERSION = '2026.9.3';
export const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download';

export interface CloudflaredAsset {
  /** The file name in the GitHub release. */
  name: string;
  /** From the release's own "SHA256 Checksums" list. */
  sha256: string;
  /** `tgz`: the program is `cloudflared` inside a gzipped tar (macOS). */
  kind: 'binary' | 'tgz';
  /** What the program is called on disk. */
  program: string;
}

const ASSETS: Record<string, CloudflaredAsset> = {
  'linux-x64': {
    name: 'cloudflared-linux-amd64',
    sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2',
    kind: 'binary',
    program: 'cloudflared',
  },
  'linux-arm64': {
    name: 'cloudflared-linux-arm64',
    sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d',
    kind: 'binary',
    program: 'cloudflared',
  },
  'darwin-arm64': {
    name: 'cloudflared-darwin-arm64.tgz',
    sha256: '5472c1a01c84bc31b3021056a73b4e5774ddddefc572124ea8fdf6c340639f32',
    kind: 'tgz',
    program: 'cloudflared',
  },
  'darwin-x64': {
    name: 'cloudflared-darwin-amd64.tgz',
    sha256: 'ab588b3b4db9cdb4476c30a3db2a72635b1d8327d44741fee6799a0f37b0ec07',
    kind: 'tgz',
    program: 'cloudflared',
  },
  'win32-x64': {
    name: 'cloudflared-windows-amd64.exe',
    sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2',
    kind: 'binary',
    program: 'cloudflared.exe',
  },
};

export function cloudflaredAsset(platform: string, arch: string): CloudflaredAsset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function cloudflaredUrl(asset: CloudflaredAsset, base = CLOUDFLARED_RELEASES): string {
  return `${base}/${CLOUDFLARED_VERSION}/${asset.name}`;
}

/**
 * The arguments `cloudflared` runs with. The token is not among them — it goes in
 * `TUNNEL_TOKEN`, where another user's `ps` cannot read it — and neither is the ingress:
 * a tunnel run by token takes its routes from the dashboard.
 */
export function cloudflaredArgs(metricsPort: number): string[] {
  return ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort}`, 'run'];
}

/** What one line of `cloudflared`'s JSON log (`TUNNEL_LOG_OUTPUT=json`) tells the page. */
export type CloudflaredEvent =
  | { kind: 'ingress'; routes: Array<{ hostname: string; service: string }> }
  | { kind: 'error'; message: string }
  | { kind: 'other' };

export function parseCloudflaredLine(line: string): CloudflaredEvent {
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return { kind: 'other' };
    record = parsed;
  } catch {
    return { kind: 'other' };
  }
  const message = typeof record.message === 'string' ? record.message : '';
  if (message === 'Updated to new configuration' && typeof record.config === 'string') {
    try {
      const config = JSON.parse(record.config) as { ingress?: unknown };
      const routes = Array.isArray(config.ingress)
        ? config.ingress
            .filter(
              (r): r is { hostname: string; service: string } =>
                isRecord(r) && typeof r.hostname === 'string' && typeof r.service === 'string',
            )
            .map((r) => ({ hostname: r.hostname, service: r.service }))
        : [];
      return { kind: 'ingress', routes };
    } catch {
      return { kind: 'other' };
    }
  }
  const level = typeof record.level === 'string' ? record.level : '';
  if (level === 'error' || level === 'fatal') {
    const detail = typeof record.error === 'string' ? `${message}: ${record.error}` : message;
    return { kind: 'error', message: detail.slice(0, 500) };
  }
  return { kind: 'other' };
}

/** Whether a route Cloudflare sends to this tunnel ends at the hub's port on this computer. */
export function serviceMatches(service: string, hubPort: number | null): boolean {
  if (hubPort === null) return false;
  try {
    const url = new URL(service);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return local && (url.protocol === 'http:' || url.protocol === 'https:') && port === hubPort;
  } catch {
    return false;
  }
}

/** Never a secret in what the page shows: the token is cut out of anything a program said. */
export function redact(text: string, secret: string | null): string {
  return secret ? text.split(secret).join('…') : text;
}

// ------------------------------------------------------------------ tailscale

/** Tailscale gives each machine an address in 100.64.0.0/10 (the shared address space). */
export function isTailnetAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number) as [number, number];
  return a === 100 && b >= 64 && b <= 127;
}

/** This computer's tailnet address, from `os.networkInterfaces()`, or null. */
export function tailnetAddress(
  interfaces: Record<
    string,
    Array<{ address: string; family: string | number; internal: boolean }> | undefined
  >,
): string | null {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      const v4 = entry.family === 'IPv4' || entry.family === 4;
      if (v4 && !entry.internal && isTailnetAddress(entry.address)) return entry.address;
    }
  }
  return null;
}

/** The MagicDNS name from `tailscale status --json`, without its trailing dot. */
export function tailscaleDnsName(json: string): string | null {
  try {
    const status = JSON.parse(json) as { Self?: { DNSName?: unknown } };
    const name = status.Self?.DNSName;
    return typeof name === 'string' && name.length > 1 ? name.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

/** The address a phone pairs with, for each route. */
export function relayUrlFor(
  route: RelayRoute | null,
  input: {
    hostname: string | null;
    detected: string[];
    tailnet: string | null;
    port: number | null;
  },
): string | null {
  if (route === 'cloudflare') {
    const host = input.hostname ?? input.detected[0] ?? null;
    return host ? `https://${host}` : null;
  }
  if (route === 'tailscale' && input.tailnet && input.port)
    return `http://${input.tailnet}:${input.port}`;
  return null;
}
