/**
 * The Tailscale route (DECISIONS §95): when this computer is on a tailnet, the app listens on its
 * tailnet address — that address only, never 0.0.0.0 or the LAN — and forwards each request to
 * the hub on the loopback, saying which tailnet peer sent it (DECISIONS §96). Only machines on the person's own tailnet can reach that address, and
 * the hub asks them to sign in like anyone else.
 *
 * The tailnet address comes from the network interfaces (100.64.0.0/10); the MagicDNS name, when
 * there is one, from `tailscale status --json` if the Tailscale program is where its installers
 * put it. Neither needs Tailscale's cooperation beyond being installed and connected.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { tailnetAddress, tailscaleDnsName } from '../shared/relay.js';

export interface TailnetFound {
  address: string;
  dns_name: string | null;
}

/** Where Tailscale's program is on each platform, besides PATH. */
export function tailscaleCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin')
    return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale'];
  if (platform === 'win32')
    return [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'];
}

export interface DetectOptions {
  interfaces?: () => ReturnType<typeof os.networkInterfaces>;
  /** `tailscale status --json`, or null when there is no program to ask. */
  status?: () => Promise<string | null>;
}

function runTailscaleStatus(): Promise<string | null> {
  const program = tailscaleCandidates(process.platform, process.env).find((p) => existsSync(p));
  if (!program) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      program,
      ['status', '--json'],
      { timeout: 4_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

export async function detectTailnet(options: DetectOptions = {}): Promise<TailnetFound | null> {
  const address = tailnetAddress((options.interfaces ?? os.networkInterfaces)());
  if (!address) return null;
  let dnsName: string | null;
  try {
    const status = await (options.status ?? runTailscaleStatus)();
    dnsName = status ? tailscaleDnsName(status) : null;
  } catch {
    dnsName = null;
  }
  return { address, dns_name: dnsName };
}

/** Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * What a tailnet peer may say about who it is or where it came from. The hub believes these
 * from loopback (DECISIONS §96), which is where this forwarder connects from, so a peer's own
 * copies are dropped and the forwarder writes `X-Forwarded-For` itself.
 */
const CLIENT_CLAIMS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

/** The tailnet peer's address as the hub should count it (`::ffff:100.x` → `100.x`). */
export function peerAddress(socket: { remoteAddress?: string | undefined }): string {
  const address = socket.remoteAddress ?? '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

/**
 * The request headers the hub receives: the peer's own, without hop-by-hop headers and
 * without any claim about the client, plus `X-Forwarded-For` naming the peer that connected.
 */
export function forwardedHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || CLIENT_CLAIMS.has(name)) continue;
    headers[name] = value;
  }
  headers['x-forwarded-for'] = peerAddress(req.socket);
  return headers;
}

/**
 * An HTTP forwarder from `host:port` (the tailnet address) to the hub on 127.0.0.1: plain
 * requests, server-sent events and WebSocket upgrades alike. It speaks HTTP rather than
 * passing bytes through so that the hub learns who connected — the tailnet peer's address in
 * `X-Forwarded-For` — and so that a peer cannot name itself someone else and walk past the
 * hub's per-address sign-in lockout.
 */
export class Forwarder {
  private server: HttpServer | null = null;
  private readonly sockets = new Set<Duplex>();

  constructor(private readonly target: () => number | null) {}

  get listening(): boolean {
    return this.server?.listening === true;
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const hubPort = this.target();
    if (!hubPort) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('Hub not running');
      return;
    }
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: hubPort,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req),
      },
      (incoming) => {
        const headers: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          headers[name] = value;
        }
        res.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, headers);
        // Server-sent events and long polls must reach the phone as they arrive.
        res.flushHeaders();
        incoming.pipe(res);
      },
    );
    outgoing.on('error', () => {
      if (res.headersSent) res.destroy();
      else
        res
          .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          .end('Hub did not answer');
    });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const hubPort = this.target();
    if (!hubPort) {
      socket.destroy();
      return;
    }
    const headers = forwardedHeaders(req);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';
    const outgoing = httpRequest({
      host: '127.0.0.1',
      port: hubPort,
      method: req.method,
      path: req.url,
      headers,
    });
    const statusLine = (incoming: IncomingMessage, fallback: string) => {
      const lines = [
        `HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? fallback}`,
      ];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        lines.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
      return `${lines.join('\r\n')}\r\n\r\n`;
    };
    outgoing.on('upgrade', (incoming, upstream, upstreamHead) => {
      this.sockets.add(upstream);
      upstream.once('close', () => this.sockets.delete(upstream));
      socket.write(statusLine(incoming, 'Switching Protocols'));
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstream.write(head);
      // Either side going away ends the other: no half-open sockets are left behind.
      upstream.on('error', () => socket.destroy());
      upstream.on('close', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.pipe(socket).pipe(upstream);
    });
    outgoing.on('response', (incoming) => {
      // The hub refused the upgrade: pass its answer on and close.
      socket.write(statusLine(incoming, ''));
      incoming.pipe(socket);
    });
    outgoing.on('error', () => socket.destroy());
    socket.on('error', () => outgoing.destroy());
    outgoing.end();
  }

  listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createHttpServer((req, res) => this.request(req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
      // Upgraded sockets leave the HTTP server's bookkeeping; closing must still end them.
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      // Streams (SSE, Socket.IO long polls) stay open as long as the hub keeps them.
      server.requestTimeout = 0;
      server.headersTimeout = 30_000;
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  }
}
