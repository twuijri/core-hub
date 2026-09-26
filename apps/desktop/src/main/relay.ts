/**
 * The way in from outside for the hub this app runs (local mode; DECISIONS §92, proposed — owner
 * to confirm). The hub asks through its IPC channel (`hub/entry.ts`); this answers and does the
 * work: keeps the settings in `desktop.json` with the tunnel token sealed by the OS keychain,
 * fetches and runs `cloudflared` (`cloudflared.ts`, `tunnel.ts`) or listens on the tailnet
 * address (`tailnet.ts`), and reports what the page shows. Nothing here runs while the app is
 * in remote mode, or before the person turns it on.
 */
import {
  parseTunnelToken,
  redact,
  relayUrlFor,
  serviceMatches,
  type RelayChange,
  type RelayConfig,
  type RelayErrorCode,
  type RelayState,
} from '../shared/relay.js';
import { CloudflaredError, ensureCloudflared, type EnsureOptions } from './cloudflared.js';
import { Forwarder, detectTailnet, type TailnetFound } from './tailnet.js';
import { Tunnel, type TunnelOptions } from './tunnel.js';

/** A change the app will not make, with the reason the hub answers `400` with. */
export class RelayRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RelayRefusal';
  }
}

interface TunnelLike {
  connected: boolean;
  connectedAt: string | null;
  routes: Array<{ hostname: string; service: string }>;
  error: { code: RelayErrorCode; detail: string | null } | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ForwarderLike {
  readonly listening: boolean;
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

export interface RelayManagerOptions {
  load(): RelayConfig;
  save(next: RelayConfig): void;
  seal(text: string): string;
  unseal(text: string): string;
  /** The port the hub listens on now, or null when it is not running. */
  hubPort(): number | null;
  /** `<userData>/tools`. */
  toolsDir: string;
  platform: string;
  arch: string;
  /** The state changed on its own (connected, a route, an error): tell the hub. */
  onChange?(state: RelayState): void;
  ensure?: (options: EnsureOptions) => Promise<string>;
  tunnel?: (options: TunnelOptions) => TunnelLike;
  detectTailnet?: () => Promise<TailnetFound | null>;
  forwarder?: (target: () => number | null) => ForwarderLike;
}

type Running =
  | { kind: 'cloudflare'; token: string; tunnel: TunnelLike }
  | { kind: 'tailscale'; address: string; port: number; forwarder: ForwarderLike };

export class RelayManager {
  private running: Running | null = null;
  private error: { code: RelayErrorCode; detail: string | null } | null = null;
  private tailnet: TailnetFound | null = null;
  private tailnetCheckedAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private active = false;

  constructor(private readonly options: RelayManagerOptions) {}

  /** The hub is running: open the way in if the person turned it on. */
  async resume(): Promise<void> {
    this.active = true;
    await this.apply();
  }

  /** The hub stopped, or the app quits: close everything. */
  async suspend(): Promise<void> {
    this.active = false;
    await this.apply();
  }

  async state(): Promise<RelayState> {
    await this.refreshTailnet();
    const config = this.options.load();
    // A tailnet address that came or went since: follow it.
    if (
      this.active &&
      config.enabled &&
      config.route === 'tailscale' &&
      (this.running?.kind !== 'tailscale' ||
        this.running.address !== this.tailnet?.address ||
        this.running.port !== this.options.hubPort())
    )
      await this.apply();
    return this.snapshot();
  }

  async set(change: RelayChange): Promise<RelayState> {
    const current = this.options.load();
    const next: RelayConfig = { ...current };
    if (change.forget_token) next.token = null;
    if (change.token !== undefined) {
      if (!parseTunnelToken(change.token)) throw new RelayRefusal('token_invalid');
      next.token = this.options.seal(change.token.trim());
    }
    if (change.hostname !== undefined) next.hostname = change.hostname;
    if (change.route !== undefined) next.route = change.route;
    if (change.enabled !== undefined) next.enabled = change.enabled;
    if (next.enabled && !next.route) throw new RelayRefusal('route_required');
    if (next.enabled && next.route === 'cloudflare' && !next.token)
      throw new RelayRefusal('token_required');
    this.options.save(next);
    this.error = null;
    await this.refreshTailnet(true);
    await this.apply();
    return this.snapshot();
  }

  /** Start, stop or restart whatever runs so it matches the settings; one at a time. */
  private apply(): Promise<void> {
    const run = this.queue.then(() => this.applyNow());
    this.queue = run.catch(() => {});
    return run;
  }

  private async applyNow(): Promise<void> {
    const config = this.options.load();
    const port = this.options.hubPort();
    let token: string | null = null;
    if (config.token) {
      try {
        token = this.options.unseal(config.token);
      } catch {
        token = null;
      }
    }
    const wanted = this.active && config.enabled ? config.route : null;
    const running = this.running;
    const same =
      running &&
      ((running.kind === 'cloudflare' && wanted === 'cloudflare' && running.token === token) ||
        (running.kind === 'tailscale' &&
          wanted === 'tailscale' &&
          running.address === this.tailnet?.address &&
          running.port === port));
    if (same) return;
    if (running) {
      this.running = null;
      if (running.kind === 'cloudflare') await running.tunnel.stop();
      else await running.forwarder.close();
    }
    if (wanted === 'cloudflare') {
      if (!token) {
        this.error = { code: 'token_invalid', detail: 'The saved token could not be read.' };
        return;
      }
      await this.startCloudflare(token);
    } else if (wanted === 'tailscale') {
      await this.startTailscale(port);
    }
    this.changed();
  }

  private async startCloudflare(token: string): Promise<void> {
    let program: string;
    try {
      program = await (this.options.ensure ?? ensureCloudflared)({
        toolsDir: this.options.toolsDir,
        platform: this.options.platform,
        arch: this.options.arch,
      });
    } catch (error) {
      this.error =
        error instanceof CloudflaredError
          ? { code: error.code, detail: error.message }
          : { code: 'download_failed', detail: String(error) };
      return;
    }
    const tunnel = (this.options.tunnel ?? ((o) => new Tunnel(o)))({
      program,
      token,
      onChange: () => this.changed(),
    });
    this.running = { kind: 'cloudflare', token, tunnel };
    await tunnel.start();
  }

  private async startTailscale(port: number | null): Promise<void> {
    const tailnet = this.tailnet;
    if (!tailnet) {
      this.error = { code: 'not_on_tailnet', detail: null };
      return;
    }
    if (!port) {
      this.error = { code: 'listen_failed', detail: 'The hub on this computer is not running.' };
      return;
    }
    const forwarder = (this.options.forwarder ?? ((target) => new Forwarder(target)))(() =>
      this.options.hubPort(),
    );
    try {
      await forwarder.listen(tailnet.address, port);
    } catch (error) {
      this.error = {
        code: 'listen_failed',
        detail: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    this.running = { kind: 'tailscale', address: tailnet.address, port, forwarder };
  }

  private async refreshTailnet(force = false): Promise<void> {
    if (!force && Date.now() - this.tailnetCheckedAt < 15_000) return;
    this.tailnetCheckedAt = Date.now();
    try {
      this.tailnet = await (this.options.detectTailnet ?? (() => detectTailnet()))();
    } catch {
      this.tailnet = null;
    }
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }

  snapshot(): RelayState {
    const config = this.options.load();
    const port = this.options.hubPort();
    const running = this.running;
    const tunnel = running?.kind === 'cloudflare' ? running.tunnel : null;
    let tunnelId: string | null = null;
    if (config.token) {
      try {
        tunnelId = parseTunnelToken(this.options.unseal(config.token))?.tunnelId ?? null;
      } catch {
        tunnelId = null;
      }
    }
    const routes = tunnel?.routes ?? [];
    const error = tunnel?.error ?? this.error;
    const secret = running?.kind === 'cloudflare' ? running.token : null;
    const on = config.enabled && this.active;
    return {
      enabled: config.enabled,
      connected:
        on &&
        (running?.kind === 'cloudflare'
          ? running.tunnel.connected
          : running?.kind === 'tailscale'
            ? running.forwarder.listening
            : false),
      route: config.route,
      relay_url: on
        ? relayUrlFor(config.route, {
            hostname: config.hostname,
            detected: routes.filter((r) => serviceMatches(r.service, port)).map((r) => r.hostname),
            tailnet: this.tailnet?.address ?? null,
            port,
          })
        : null,
      hub_port: port,
      token_set: config.token !== null,
      tunnel_id: tunnelId,
      hostname: config.hostname,
      hostnames: routes.map((r) => ({ ...r, matches: serviceMatches(r.service, port) })),
      tailnet: this.tailnet,
      error: on ? (error?.code ?? null) : null,
      error_detail: on && error?.detail ? redact(error.detail, secret) : null,
      connected_at: on && tunnel ? tunnel.connectedAt : null,
    };
  }
}
