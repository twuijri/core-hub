/**
 * The app's own origin: the bundled web client, and a door to the hub behind it.
 *
 * The web client is built to be same-origin with its hub — it calls the API and opens
 * Socket.IO on `/rt` without a host (packages/web). Rather than teach it about a second
 * origin (CORS on every hub, tokens crossing origins), the desktop app serves the bundle it
 * ships from a loopback port and forwards `/api` and `/rt` — plain requests, server-sent
 * events and WebSocket upgrades alike — to whichever hub the current mode uses: the remote
 * hub in remote mode, the embedded hub in local mode. The window sees one origin; the hub
 * sees an ordinary client.
 *
 * Nothing is added on the way: no token, no cookie. The web client's bearer lives in its
 * own storage and travels in its own headers. The server listens on 127.0.0.1 only, and a
 * request whose Host is not this very address is refused, so a web page that rebinds a
 * DNS name to 127.0.0.1 cannot use it.
 */
import { createReadStream, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import path from 'node:path';

const API_PREFIX = '/api';
const RT_PREFIX = '/rt';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isHubPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? url;
  return (
    pathname === API_PREFIX ||
    pathname.startsWith(`${API_PREFIX}/`) ||
    pathname === RT_PREFIX ||
    pathname.startsWith(`${RT_PREFIX}/`)
  );
}

/** A static file inside `root` for this URL path, or null (never a path outside `root`). */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export interface ProxyOptions {
  /** The built web client (`index.html` and `assets/`). */
  webDir: string;
  /** The port to try first; 0 or taken → any free port. */
  preferredPort: number | null;
}

export interface ProxyServer {
  readonly port: number;
  readonly origin: string;
  /** The hub `/api` and `/rt` go to, as an origin; null answers 503 until one is set. */
  setTarget(origin: string | null): void;
  target(): string | null;
  close(): Promise<void>;
}

function forwardHeaders(req: IncomingMessage, target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  // The hub sees its own origin, as it would from its own web client.
  if (headers.origin) headers.origin = target.origin;
  if (typeof headers.referer === 'string') delete headers.referer;
  return headers;
}

function unavailable(res: ServerResponse, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message, code: 'service_unavailable' }));
}

export async function startProxy(options: ProxyOptions): Promise<ProxyServer> {
  const root = path.resolve(options.webDir);
  const index = path.join(root, 'index.html');
  let target: URL | null = null;
  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const client = (url: URL) => (url.protocol === 'https:' ? https : http);

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const file = resolveStatic(root, req.url ?? '/') ?? index;
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  function proxy(req: IncomingMessage, res: ServerResponse): void {
    const upstream = target;
    if (!upstream) {
      unavailable(res, 'No hub is connected');
      return;
    }
    const outgoing = client(upstream).request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req, upstream),
      },
      (incoming) => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          headers[name] = value;
        }
        res.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, headers);
        // Server-sent events and long polls must reach the page as they arrive.
        res.flushHeaders();
        incoming.pipe(res);
      },
    );
    outgoing.on('error', () => unavailable(res, 'The hub did not answer'));
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const upstream = target;
    const url = req.url ?? '/';
    if (!upstream || !allowedHosts().has(req.headers.host ?? '') || !isHubPath(url)) {
      socket.destroy();
      return;
    }
    const headers = forwardHeaders(req, upstream);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';
    const outgoing = client(upstream).request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: url,
      headers,
    });
    outgoing.on('upgrade', (incoming, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 ${incoming.statusMessage ?? 'Switching Protocols'}`];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        lines.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      // Either side going away ends the other: no half-open sockets are left behind.
      upstreamSocket.on('error', () => socket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    outgoing.on('response', (incoming) => {
      // The hub refused the upgrade: pass its answer on and close.
      const lines = [`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ''}`];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        lines.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      incoming.pipe(socket);
    });
    outgoing.on('error', () => socket.destroy());
    socket.on('error', () => outgoing.destroy());
    outgoing.end();
  }

  const server = http.createServer((req, res) => {
    if (!allowedHosts().has(req.headers.host ?? '')) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' }).end('Misdirected');
      return;
    }
    if (isHubPath(req.url ?? '/')) proxy(req, res);
    else serveStatic(req, res);
  });
  server.on('upgrade', upgrade);
  // Upgraded sockets leave the HTTP server's bookkeeping; closing must still end them.
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  // Streams (SSE, Socket.IO long polls) stay open as long as the hub keeps them.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });

  try {
    port = await listen(options.preferredPort ?? 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !options.preferredPort)
      throw error;
    port = await listen(0);
  }

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    setTarget(origin) {
      target = origin ? new URL(origin) : null;
    },
    target: () => target?.origin ?? null,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }),
  };
}
