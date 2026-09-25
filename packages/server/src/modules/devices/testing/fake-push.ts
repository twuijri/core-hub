/**
 * Fakes of the three push services, for the server tests and the e2e hub. Each one keeps
 * what it received so a test can read the message a device would have shown.
 *
 * - `fakeBrowser()`: a browser's push subscription (its own P-256 key and auth secret),
 *   and `open()` to decrypt what the hub sent it — the receiving half of RFC 8291.
 * - `startFakePushService()`: an HTTP server that accepts Web Push POSTs, checks the VAPID
 *   header's signature, decrypts the body for the subscriber it was addressed to, and
 *   answers 201 (or the status a test asks for).
 * - `fakeFcm()`: a `fetch` that plays Google's token endpoint and FCM's `messages:send`.
 * - `startFakeApns()`: an HTTP/2 server playing APNs, answering per device token.
 */
import http from 'node:http';
import http2 from 'node:http2';
import { createDecipheriv, createECDH, hkdfSync, randomBytes, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { vapidPublicKeyObject } from '../webpush.js';

export interface FakeBrowser {
  /** `PushSubscription.toJSON()`, as the browser would hand it to the page. */
  subscription(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } };
  /** Decrypts an `aes128gcm` body addressed to this browser. */
  open(body: Buffer): string;
}

export function fakeBrowser(): FakeBrowser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const uaPublic = ecdh.getPublicKey();
  return {
    subscription: (endpoint) => ({
      endpoint,
      keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') },
    }),
    open(body) {
      const salt = body.subarray(0, 16);
      const idLength = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idLength);
      const ciphertext = body.subarray(21 + idLength);
      const shared = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
      const key = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
      );
      const nonce = Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
      );
      const decipher = createDecipheriv('aes-128-gcm', key, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plain = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      // Strip the padding delimiter (0x02) and any zero padding after it.
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end -= 1;
      return plain.subarray(0, end).toString('utf8');
    },
  };
}

/** Verifies `Authorization: vapid t=<jwt>, k=<key>`; returns the claims, or null. */
export function verifyVapid(header: string | undefined): Record<string, unknown> | null {
  const match = /^vapid t=([^,]+),\s*k=(.+)$/.exec(header ?? '');
  if (!match) return null;
  const [token, key] = [match[1]!, match[2]!.trim()];
  const [head, claims, signature] = token.split('.');
  if (!head || !claims || !signature) return null;
  const ok = verify(
    'sha256',
    Buffer.from(`${head}.${claims}`),
    { key: vapidPublicKeyObject(key), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  return ok
    ? (JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>)
    : null;
}

export interface ReceivedPush {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  vapid: Record<string, unknown> | null;
  /** The decrypted payload, parsed. */
  payload: Record<string, unknown> | null;
}

export interface FakePushService {
  url: string;
  /** A subscriber at `${url}/push/<name>`. */
  subscribe(name: string): { subscription: ReturnType<FakeBrowser['subscription']> };
  received: ReceivedPush[];
  /** The status the next POSTs to `name` get (default 201). */
  answer(name: string, status: number): void;
  close(): Promise<void>;
}

export async function startFakePushService(): Promise<FakePushService> {
  const browsers = new Map<string, FakeBrowser>();
  const answers = new Map<string, number>();
  const received: ReceivedPush[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const name = decodeURIComponent((request.url ?? '').replace(/^\/push\//, ''));
      const browser = browsers.get(name);
      let payload: Record<string, unknown> | null = null;
      try {
        payload = browser
          ? (JSON.parse(browser.open(Buffer.concat(chunks))) as Record<string, unknown>)
          : null;
      } catch {
        payload = null;
      }
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        vapid: verifyVapid(request.headers.authorization),
        payload,
      });
      response.statusCode = answers.get(name) ?? (browser ? 201 : 404);
      response.setHeader('location', `/message/${received.length}`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    received,
    subscribe(name) {
      const browser = fakeBrowser();
      browsers.set(name, browser);
      return { subscription: browser.subscription(`${url}/push/${encodeURIComponent(name)}`) };
    },
    answer: (name, status) => answers.set(name, status),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface FakeFcm {
  fetchImpl: typeof fetch;
  /** Every `messages:send` body. */
  sent: Array<{ project: string; authorization: string; body: Record<string, unknown> }>;
  /** Token exchanges made, and the signed assertions they carried. */
  signIns: number;
  assertions: string[];
  /** FCM answers `UNREGISTERED` for these tokens. */
  unregistered: Set<string>;
}

export function fakeFcm(): FakeFcm {
  const state: FakeFcm = {
    sent: [],
    signIns: 0,
    assertions: [],
    unregistered: new Set(),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        if (!form.get('assertion')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        state.signIns += 1;
        state.assertions.push(form.get('assertion')!);
        return Response.json({ access_token: `fake-access-${state.signIns}`, expires_in: 3600 });
      }
      const match = /\/v1\/projects\/([^/]+)\/messages:send$/.exec(url);
      if (!match) return new Response('not found', { status: 404 });
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        message: { token: string };
      };
      const headers = new Headers(init?.headers);
      state.sent.push({
        project: match[1]!,
        authorization: headers.get('authorization') ?? '',
        body: body as unknown as Record<string, unknown>,
      });
      if (state.unregistered.has(body.message.token)) {
        return Response.json(
          {
            error: {
              code: 404,
              status: 'NOT_FOUND',
              message: 'Requested entity was not found.',
              details: [{ errorCode: 'UNREGISTERED' }],
            },
          },
          { status: 404 },
        );
      }
      return Response.json({ name: `projects/${match[1]}/messages/${state.sent.length}` });
    }) as typeof fetch,
  };
  return state;
}

export interface FakeApns {
  origin: string;
  received: Array<{ token: string; headers: http2.IncomingHttpHeaders; body: Record<string, unknown> }>;
  /** APNs answers 410 Unregistered for these tokens. */
  unregistered: Set<string>;
  close(): Promise<void>;
}

export async function startFakeApns(): Promise<FakeApns> {
  const received: FakeApns['received'] = [];
  const unregistered = new Set<string>();
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const token = String(headers[':path'] ?? '').replace('/3/device/', '');
      received.push({
        token,
        headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
          string,
          unknown
        >,
      });
      if (unregistered.has(token)) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: Date.now() }));
        return;
      }
      stream.respond({ ':status': 200, 'apns-id': `apns-${received.length}` });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    unregistered,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
