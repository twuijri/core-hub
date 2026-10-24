/**
 * gRPC over HTTP/2 to Gemini Desktop's native service (DECISIONS §155), with `node:http2` and no
 * gRPC library: the calls are raw protobuf frames, and the service routes only the plain
 * `application/grpc` content type (not `application/grpc+proto`), which is what the owner's plugin
 * found and what its raw codec sends.
 *
 * Each call opens its own connection and closes it when the call ends: a turn is one call, and a
 * model list another. The process's `HTTPS_PROXY` is honoured (an HTTP CONNECT tunnel), except
 * for hosts its `NO_PROXY` names.
 */
import http2, { type ClientHttp2Session } from 'node:http2';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { gunzipSync } from 'node:zlib';

export const NATIVE_ORIGIN = 'https://robinfrontend-pa.googleapis.com';
export const PROCESS_QUERY = '/assistant.mobile.robin.RobinService/ProcessQuery';
export const GET_USER_STATUS = '/assistant.mobile.robin.RobinService/GetUserStatus';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
/** A thinking model may say nothing for a while; this long with no frame at all is a dead call. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** gRPC status codes the hub tells apart. */
export const GRPC = {
  OK: 0,
  CANCELLED: 1,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** A call that did not end in OK: the gRPC code (or null for a transport failure) and why. */
export class NativeCallError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
    /** The HTTP status the hub answers this as. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'NativeCallError';
  }
}

const CODE_NAMES: Record<number, string> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};

/** The hub's words and status for a gRPC code (never the service's own message, which may echo input). */
export function callError(code: number): NativeCallError {
  const name = CODE_NAMES[code] ?? `code ${code}`;
  switch (code) {
    case GRPC.UNAUTHENTICATED:
      return new NativeCallError(code, `Gemini sign-in expired or was revoked (${name})`, 401);
    case GRPC.PERMISSION_DENIED:
      return new NativeCallError(
        code,
        `Google refused this Gemini Desktop request for the account (${name})`,
        403,
      );
    case GRPC.RESOURCE_EXHAUSTED:
      return new NativeCallError(code, `the Gemini account's limit is reached (${name})`, 429);
    case GRPC.INVALID_ARGUMENT:
      return new NativeCallError(code, `Gemini refused the request's format (${name})`, 400);
    case GRPC.DEADLINE_EXCEEDED:
      return new NativeCallError(code, `Gemini took too long to answer (${name})`, 504);
    case GRPC.UNAVAILABLE:
      return new NativeCallError(code, `Gemini's service is unavailable (${name})`, 502);
    default:
      return new NativeCallError(code, `Gemini's service failed the request (${name})`, 502);
  }
}

/** How a call reaches the service; tests give a local HTTP/2 server. */
export type SessionOpener = (signal: AbortSignal) => Promise<ClientHttp2Session>;

function proxyFor(host: string, env: NodeJS.ProcessEnv): URL | null {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? '';
  if (!raw.trim()) return null;
  const skip = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const name = host.toLowerCase();
  if (
    skip.some(
      (entry) =>
        entry === '*' ||
        name === entry.replace(/^\./, '') ||
        name.endsWith(entry.startsWith('.') ? entry : `.${entry}`),
    )
  ) {
    return null;
  }
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** The service, directly or through the host's proxy (`HTTPS_PROXY`, `NO_PROXY`). */
export function defaultOpener(env: () => NodeJS.ProcessEnv = () => ({})): SessionOpener {
  return (signal) =>
    new Promise<ClientHttp2Session>((resolve, reject) => {
      const target = new URL(NATIVE_ORIGIN);
      const proxy = proxyFor(target.hostname, env());
      const timer = setTimeout(
        () => fail(new NativeCallError(null, 'could not connect to Gemini’s service in time', 504)),
        CONNECT_TIMEOUT_MS,
      );
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const done = (session: ClientHttp2Session) => {
        if (settled) {
          session.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(session);
      };
      signal.addEventListener(
        'abort',
        () => fail(new NativeCallError(GRPC.CANCELLED, 'cancelled', 499)),
        { once: true },
      );
      const watch = (session: ClientHttp2Session) => {
        session.once('connect', () => done(session));
        session.once('error', () =>
          fail(new NativeCallError(null, 'could not connect to Gemini’s service', 502)),
        );
      };
      if (!proxy) {
        watch(http2.connect(NATIVE_ORIGIN));
        return;
      }
      const authorization = proxy.username
        ? {
            'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`,
          }
        : {};
      const tunnel = httpRequest({
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method: 'CONNECT',
        path: `${target.hostname}:443`,
        headers: { host: `${target.hostname}:443`, ...authorization },
      });
      tunnel.once('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          fail(
            new NativeCallError(
              null,
              `the proxy refused the connection (${response.statusCode})`,
              502,
            ),
          );
          return;
        }
        const secure = tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['h2'] });
        watch(http2.connect(NATIVE_ORIGIN, { createConnection: () => secure }));
      });
      tunnel.once('error', () => fail(new NativeCallError(null, 'could not reach the proxy', 502)));
      tunnel.end();
    });
}

export interface NativeCall {
  method: string;
  token: string;
  frames: readonly Buffer[];
  /** Each server message, in order; may be async (its promise is awaited before the next). */
  onMessage(message: Buffer): void | Promise<void>;
  signal?: AbortSignal;
}

function frame(message: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(message.length, 1);
  return Buffer.concat([head, message]);
}

/**
 * One call: the client frames are written and the stream half-closed (every turn's frames are
 * known up front), then each server message is handed to `onMessage`. Resolves on `grpc-status`
 * 0; anything else rejects with a `NativeCallError`. Aborting `signal` resets the stream.
 */
export async function nativeCall(
  call: NativeCall,
  open: SessionOpener = defaultOpener(),
): Promise<void> {
  const controller = new AbortController();
  const outer = call.signal;
  if (outer?.aborted) throw new NativeCallError(GRPC.CANCELLED, 'cancelled', 499);
  const onAbort = () => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  let session: ClientHttp2Session | null = null;
  try {
    session = await open(controller.signal);
    await new Promise<void>((resolve, reject) => {
      const stream = session!.request({
        ':method': 'POST',
        ':path': call.method,
        'content-type': 'application/grpc',
        te: 'trailers',
        authorization: `Bearer ${call.token}`,
        'grpc-accept-encoding': 'gzip',
      });
      let settled = false;
      let encoding = 'identity';
      let status: number | null = null;
      let pending = Buffer.alloc(0);
      let chain = Promise.resolve();
      let idle: NodeJS.Timeout | null = null;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        controller.signal.removeEventListener('abort', abort);
        if (error) {
          if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
          reject(error);
        } else resolve();
      };
      const touch = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(
          () =>
            finish(new NativeCallError(GRPC.DEADLINE_EXCEEDED, 'Gemini stopped answering', 504)),
          IDLE_TIMEOUT_MS,
        );
      };
      const abort = () => finish(new NativeCallError(GRPC.CANCELLED, 'cancelled', 499));
      controller.signal.addEventListener('abort', abort, { once: true });
      touch();
      const readStatus = (headers: http2.IncomingHttpHeaders) => {
        const value = headers['grpc-status'];
        if (value !== undefined) status = Number(value);
      };
      stream.on('response', (headers) => {
        const httpStatus = Number(headers[':status']);
        if (httpStatus !== 200) {
          finish(
            httpStatus === 401
              ? callError(GRPC.UNAUTHENTICATED)
              : new NativeCallError(
                  null,
                  `Gemini’s service answered HTTP ${httpStatus}`,
                  httpStatus === 403 ? 403 : httpStatus === 429 ? 429 : 502,
                ),
          );
          return;
        }
        encoding = String(headers['grpc-encoding'] ?? 'identity');
        readStatus(headers); // a trailers-only answer
      });
      stream.on('trailers', readStatus);
      stream.on('data', (chunk: Buffer) => {
        touch();
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
          const length = pending.readUInt32BE(1);
          if (length > MAX_MESSAGE_BYTES) {
            finish(
              new NativeCallError(null, 'Gemini sent a message larger than the hub accepts', 502),
            );
            return;
          }
          if (pending.length < 5 + length) break;
          const compressed = (pending[0]! & 1) === 1;
          let message = pending.subarray(5, 5 + length);
          pending = pending.subarray(5 + length);
          if (compressed) {
            if (encoding !== 'gzip') {
              finish(
                new NativeCallError(
                  null,
                  `Gemini used a compression the hub does not read (${encoding})`,
                  502,
                ),
              );
              return;
            }
            try {
              message = gunzipSync(message, { maxOutputLength: MAX_MESSAGE_BYTES });
            } catch {
              finish(
                new NativeCallError(
                  null,
                  'Gemini sent a message the hub could not decompress',
                  502,
                ),
              );
              return;
            }
          }
          const copy = Buffer.from(message);
          chain = chain.then(() => (settled ? undefined : call.onMessage(copy)));
          chain.catch((error: unknown) =>
            finish(error instanceof Error ? error : new Error(String(error))),
          );
        }
      });
      stream.on('end', () => {
        void chain.then(
          () => {
            if (status === null)
              finish(new NativeCallError(null, 'Gemini’s answer ended without a status', 502));
            else if (status === GRPC.OK) finish(null);
            else finish(callError(status));
          },
          () => undefined,
        );
      });
      stream.on('error', () =>
        finish(
          new NativeCallError(GRPC.UNAVAILABLE, 'the connection to Gemini’s service broke', 502),
        ),
      );
      for (const message of call.frames) stream.write(frame(message));
      stream.end();
    });
  } finally {
    outer?.removeEventListener('abort', onAbort);
    session?.close();
  }
}
