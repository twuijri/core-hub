/**
 * The way in from outside (`devices.getRelay` / `devices.setRelay`, DECISIONS §80, §92).
 *
 * A hub the desktop app runs on a person's computer (local mode) listens on 127.0.0.1 only. For
 * their phone to reach it from outside the house, the person opens a way in on an account of
 * their own — a Cloudflare Tunnel whose token they paste, or their Tailscale network — and the
 * desktop app, which started this hub, does the work: it keeps the token in the OS keychain,
 * runs `cloudflared`, or listens on the computer's tailnet address. The hub itself runs nothing
 * and keeps no token: it asks its host (`RelayHost`, lent by `buildServer`) and answers.
 *
 * A hub with no host (the image, tests) has no way in to open: `available: false`, and a change
 * is refused with `409 relay_unavailable`. The token passes through here once, on its way to the
 * host; it is never stored, returned or logged.
 */
import { HubError, conflict } from '../../lib/errors.js';

export const RELAY_ROUTES = ['cloudflare', 'tailscale'] as const;
export type RelayRoute = (typeof RELAY_ROUTES)[number];

export const RELAY_ERRORS = [
  'token_invalid',
  'download_failed',
  'checksum_mismatch',
  'unsupported_platform',
  'start_failed',
  'tunnel_exited',
  'not_on_tailnet',
  'listen_failed',
] as const;
export type RelayErrorCode = (typeof RELAY_ERRORS)[number];

/** The contract's `Relay`. */
export interface RelayView {
  available: boolean;
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

/** What the host reports: the view without `available` (a host is always available). */
export type RelayHostState = Omit<RelayView, 'available'>;

/** The contract's `RelayUpdate`, checked. */
export interface RelayChange {
  enabled?: boolean;
  route?: RelayRoute;
  token?: string;
  forget_token?: boolean;
  hostname?: string | null;
}

/** A change the host refused, with the reason the contract's `400` carries. */
export class RelayHostRefusal extends Error {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
    this.name = 'RelayHostRefusal';
  }
}

/**
 * The desktop app, seen from the hub it started (`apps/desktop/src/hub/entry.ts` speaks this
 * over the child's IPC channel). `current()` is the last state heard, for the pairing screen,
 * which must not wait on a round trip.
 */
export interface RelayHost {
  get(): Promise<RelayHostState>;
  set(change: RelayChange): Promise<RelayHostState>;
  current(): RelayHostState | null;
}

export const NO_RELAY: RelayView = {
  available: false,
  enabled: false,
  connected: false,
  route: null,
  relay_url: null,
  hub_port: null,
  token_set: false,
  tunnel_id: null,
  hostname: null,
  hostnames: [],
  tailnet: null,
  error: null,
  error_detail: null,
  connected_at: null,
};

/** How long the hub waits for its host before saying so (`503`). */
export const HOST_TIMEOUT_MS = 10_000;

/**
 * A Cloudflare tunnel token is base64 of `{"a": account, "t": tunnel id, "s": secret}`. Only its
 * shape is checked here, so a pasted command (`cloudflared service install eyJ…`) or a stray
 * space is caught before the computer is asked; whether Cloudflare accepts it is the tunnel's
 * business.
 */
export function isTunnelToken(raw: string): boolean {
  const token = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(token)) return false;
  try {
    const json = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    return (
      typeof json.a === 'string' &&
      json.a.length > 0 &&
      typeof json.t === 'string' &&
      json.t.length > 0 &&
      typeof json.s === 'string' &&
      json.s.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * The hostname a person typed, reduced to a hostname: `https://Hub.Example.com/` becomes
 * `hub.example.com`. Null for an empty field; `undefined` when it is not a hostname.
 */
export function normalizeHostname(raw: string | null): string | null | undefined {
  if (raw === null) return null;
  let text = raw.trim().toLowerCase();
  if (text === '') return null;
  text = text.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const labels = text.split('.');
  if (text.length > 253 || labels.length < 2) return undefined;
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  return labels.every((part) => label.test(part)) ? text : undefined;
}

/** Keeps only what the contract allows from whatever the host said. */
export function viewOf(state: RelayHostState): RelayView {
  const text = (v: unknown, max = 512) =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
  const route = RELAY_ROUTES.includes(state.route as RelayRoute) ? state.route : null;
  const error = RELAY_ERRORS.includes(state.error as RelayErrorCode) ? state.error : null;
  const port = state.hub_port;
  return {
    available: true,
    enabled: state.enabled === true,
    connected: state.connected === true,
    route,
    relay_url: text(state.relay_url),
    hub_port: typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null,
    token_set: state.token_set === true,
    tunnel_id: text(state.tunnel_id, 64),
    hostname: text(state.hostname, 253),
    hostnames: Array.isArray(state.hostnames)
      ? state.hostnames
          .filter((h) => h && typeof h.hostname === 'string' && typeof h.service === 'string')
          .slice(0, 20)
          .map((h) => ({
            hostname: h.hostname.slice(0, 253),
            service: h.service.slice(0, 512),
            matches: h.matches === true,
          }))
      : [],
    tailnet:
      state.tailnet && typeof state.tailnet.address === 'string'
        ? { address: state.tailnet.address, dns_name: text(state.tailnet.dns_name, 253) }
        : null,
    error,
    error_detail: error ? text(state.error_detail, 1000) : null,
    connected_at: text(state.connected_at, 40),
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new HubError('service_unavailable', { details: { reason: 'relay_host_not_answering' } }),
        ),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function readRelay(
  host: RelayHost | null | undefined,
  timeoutMs = HOST_TIMEOUT_MS,
): Promise<RelayView> {
  if (!host) return NO_RELAY;
  return viewOf(await withTimeout(host.get(), timeoutMs));
}

/** Checks a change as the contract and the rules above say, then hands it to the host. */
export async function changeRelay(
  host: RelayHost | null | undefined,
  body: RelayChange,
  timeoutMs = HOST_TIMEOUT_MS,
): Promise<RelayView> {
  if (!host) throw conflict({ reason: 'relay_unavailable' });
  const change: RelayChange = {};
  if (body.enabled !== undefined) change.enabled = body.enabled;
  if (body.route !== undefined) change.route = body.route;
  if (body.forget_token === true) change.forget_token = true;
  if (body.token !== undefined) {
    if (!isTunnelToken(body.token))
      throw new HubError('bad_request', { details: { reason: 'token_invalid' } });
    change.token = body.token.trim();
  }
  if (body.hostname !== undefined) {
    const hostname = normalizeHostname(body.hostname);
    if (hostname === undefined)
      throw new HubError('bad_request', { details: { reason: 'hostname_invalid' } });
    change.hostname = hostname;
  }
  try {
    return viewOf(await withTimeout(host.set(change), timeoutMs));
  } catch (error) {
    if (error instanceof RelayHostRefusal)
      throw new HubError('bad_request', { details: { reason: error.reason } });
    throw error;
  }
}

/**
 * The address a phone pairing now should be given, or null: the way in's while it is open. A
 * hub the desktop app runs listens on its computer only, so this is the only address a phone
 * could use there (DECISIONS §92).
 */
export function relayPairingUrl(host: RelayHost | null | undefined): string | null {
  const state = host?.current();
  if (!state || state.enabled !== true || state.connected !== true) return null;
  return typeof state.relay_url === 'string' && state.relay_url.length > 0 ? state.relay_url : null;
}
