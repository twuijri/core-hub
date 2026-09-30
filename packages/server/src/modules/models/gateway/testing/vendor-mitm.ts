/**
 * Stand-ins for the vendors' sign-in and usage servers, for the real-CLIProxyAPI test of the
 * subscription sign-ins (`subscriptions.real.test.ts`, DECISIONS §143).
 *
 * CLIProxyAPI 8.0.4 has no setting for a vendor's sign-in addresses; they are constants in it. What
 * it does honour is the environment's `HTTPS_PROXY` (its HTTP clients use Go's default transport
 * when its own `proxy-url` is empty) and, on Linux, `SSL_CERT_FILE`. So the test runs it with a
 * proxy of its own that answers `CONNECT` for the vendors' hosts itself, with a certificate from a
 * throwaway authority made for the test (`openssl`), which CLIProxyAPI is told to trust. A host the
 * stand-in does not know is refused. Two clients of CLIProxyAPI's ignore that proxy — `api-call`
 * (it takes an account's own `proxy_url` instead) and its TLS client for Anthropic — and the test
 * keeps both away from the real vendors.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SeenRequest {
  host: string;
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

export type VendorHandler = (request: SeenRequest) => { status: number; body: unknown } | null;

export interface VendorMitm {
  /** `http://127.0.0.1:<port>`, for `HTTPS_PROXY`. */
  proxyUrl: string;
  /** The authority to trust, for `SSL_CERT_FILE`. */
  caFile: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

const HOSTS = [
  'auth.x.ai',
  'accounts.x.ai',
  'api.x.ai',
  'cli-chat-proxy.grok.com',
  'auth.openai.com',
  'chatgpt.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com',
  'api.anthropic.com',
  'api.github.com',
  'github.com',
];

/** A throwaway authority and one certificate for every stand-in host. */
function certificates(dir: string): { ca: string; key: string; cert: string } {
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Core Hub test authority',
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=vendors.test',
  ]);
  writeFileSync(
    path.join(dir, 'leaf.ext'),
    `subjectAltName=${HOSTS.map((host) => `DNS:${host}`).join(',')}\nextendedKeyUsage=serverAuth\n`,
  );
  run([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '2',
    '-extfile',
    'leaf.ext',
  ]);
  return {
    ca: path.join(dir, 'ca.pem'),
    key: readFileSync(path.join(dir, 'leaf.key'), 'utf8'),
    cert: readFileSync(path.join(dir, 'leaf.pem'), 'utf8'),
  };
}

export async function vendorMitm(handler: VendorHandler): Promise<VendorMitm> {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-vendor-mitm-'));
  const { ca, key, cert } = certificates(dir);
  const seen: SeenRequest[] = [];
  const vendors = https.createServer({ key, cert }, (request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const seenRequest: SeenRequest = {
        host: String(request.headers.host ?? '').replace(/:443$/, ''),
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        authorization: request.headers.authorization ?? null,
        body,
      };
      seen.push(seenRequest);
      const answer = handler(seenRequest) ?? { status: 404, body: { error: 'not_found' } };
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      response.writeHead(answer.status, {
        'content-type': typeof answer.body === 'string' ? 'text/plain' : 'application/json',
      });
      response.end(text);
    });
  });
  const proxy = http.createServer((_, response) => {
    response.writeHead(405);
    response.end();
  });
  const sockets = new Set<Socket>();
  proxy.on('connect', (request: http.IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const host = String(request.url ?? '').split(':')[0] ?? '';
    if (!HOSTS.includes(host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    vendors.emit('connection', socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as AddressInfo).port;
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    caFile: ca,
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      vendors.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An unsigned JWT: CLIProxyAPI reads the claims of the vendors' id tokens without a key. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.c2ln`;
}
