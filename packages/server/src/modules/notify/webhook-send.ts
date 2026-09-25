/**
 * One HTTP attempt at a webhook (decision §53).
 *
 * **The address is checked again at every attempt.** It was checked when the webhook was
 * saved, but a name can be pointed somewhere else afterwards (DNS rebinding): a public
 * address on Monday, `127.0.0.1` on Tuesday. So each attempt resolves the name, refuses a
 * private answer unless the webhook allows one, and then **connects to the address it just
 * checked** — the socket's own lookup is pinned to it, so a second resolution between the
 * check and the connection cannot slip another address in.
 *
 * **Redirects are not followed.** A redirect is an address the hub never checked; it is a
 * failed attempt with the status in the error, and the person fixes the URL.
 *
 * **Every attempt has a deadline** (10 s by default): an endpoint that never answers must
 * not hold the queue.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { checkAddress } from './address.js';

export interface SendOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  /** A test's stand-in for the network. When set, it is called instead of a socket. */
  fetchImpl?: typeof fetch | undefined;
}

export interface SendOutcome {
  /** The endpoint's HTTP status; null when nothing answered. */
  status: number | null;
  /** Null when delivered (any 2xx). */
  error: string | null;
}

export async function sendWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: SendOptions,
): Promise<SendOutcome> {
  const verdict = await checkAddress(url, options.allowPrivate, options.resolveHost);
  if (!verdict.ok) {
    const why =
      verdict.reason === 'private'
        ? `the address now resolves to a private address (${verdict.detail})`
        : verdict.reason === 'unresolvable'
          ? `the address could not be resolved (${verdict.detail})`
          : `the address is not http or https (${verdict.detail})`;
    return { status: null, error: why };
  }
  let status: number;
  try {
    status = options.fetchImpl
      ? await viaFetch(options.fetchImpl, url, headers, body, options.timeoutMs)
      : await viaSocket(new URL(url), verdict.addresses[0]!, headers, body, options.timeoutMs);
  } catch (caught) {
    return {
      status: null,
      error: caught instanceof Error ? caught.message : 'the endpoint could not be reached',
    };
  }
  if (status >= 200 && status < 300) return { status, error: null };
  if (status >= 300 && status < 400) {
    return { status, error: `the endpoint redirected (${status}); redirects are not followed` };
  }
  return { status, error: `the endpoint answered ${status}` };
}

async function viaFetch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.status;
}

function viaSocket(
  url: URL,
  address: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number> {
  const family = isIP(address) || 4;
  // The connection goes to the address that was checked, never to a fresh answer.
  const lookup = ((_host: string, options: { all?: boolean }, callback: unknown) => {
    const done = callback as (...args: unknown[]) => void;
    if (options?.all) done(null, [{ address, family }]);
    else done(null, address, family);
  }) as unknown as LookupFunction;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<number>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        lookup,
      },
      (response) => {
        clearTimeout(timer);
        // The answer's body is not read: the status is the whole verdict.
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error(`no answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}
