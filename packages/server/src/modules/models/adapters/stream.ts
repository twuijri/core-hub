/**
 * Server-sent-events plumbing for the provider adapters' `chat` verb.
 *
 * `http.ts` reads a whole body and hands back a value; a streamed turn cannot, so this
 * file is the streaming half of the same contract, and it keeps the same two rules:
 *
 * - a failure is a **value**, never an exception, so an adapter answers with a `failed`
 *   event carrying the provider's own words instead of throwing into the run loop;
 * - no API key, and no header carrying one, ever reaches a message, a log line or an
 *   error. Only the response body's own text does.
 *
 * Cancellation is the caller's `AbortSignal`: aborting it closes the socket, and the
 * reader ends as `cancelled` rather than as a transport failure, because the hub is the
 * one that stopped it.
 */

import type { ChatEvent, ChatFailureReason } from './types.js';

/** Nothing legitimate streams this much text in one turn; a runaway body is cut here. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
/** How long to wait for the *first* byte. Once the stream is open it may run long. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface StreamRequest {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
}

export type StreamOpen =
  | { ok: true; status: number; lines: AsyncIterable<string> }
  | {
      ok: false;
      /** null when the request never reached a server (DNS, refused, timeout, abort). */
      status: number | null;
      /** The provider's own error text, capped. Never our request. */
      detail: string | null;
      /** Transport-level failure text; null when the server answered. */
      error: string | null;
      /** True when the caller's own signal stopped it. */
      cancelled: boolean;
    };

/**
 * POSTs JSON and, on a 2xx, hands back the response body split into lines.
 *
 * A non-2xx is read to the end (they are short) and returned as `detail`, so the caller
 * maps a status and keeps the sentence the provider wrote.
 */
export async function openStream(request: StreamRequest): Promise<StreamOpen> {
  // Two reasons to stop: the caller's cancel, and a provider that never answers at all.
  // They are distinguished after the fact by the caller's own signal.
  const connect = AbortSignal.timeout(request.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const signals = [connect, ...(request.signal ? [request.signal] : [])];
  let response: Response;
  try {
    response = await request.fetchImpl(request.url, {
      method: 'POST',
      signal: AbortSignal.any(signals),
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...(request.headers ?? {}),
      },
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      detail: null,
      error: error instanceof Error ? error.message : String(error),
      cancelled: request.signal?.aborted === true,
    };
  }
  if (!response.ok) {
    // A body that cannot be read is no reason to lose the status; `detail` is then null
    // and the caller reports the code alone.
    const text = await response
      .text()
      .then((body) => body.slice(0, 2_000))
      .catch(() => '');
    return {
      ok: false,
      status: response.status,
      detail: text.trim() || null,
      error: null,
      cancelled: false,
    };
  }
  if (!response.body) {
    return {
      ok: false,
      status: response.status,
      detail: 'the provider answered with no body',
      error: null,
      cancelled: false,
    };
  }
  return { ok: true, status: response.status, lines: readLines(response.body, request.signal) };
}

/** The response body as lines, decoded as UTF-8, without their terminators. */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let seen = 0;
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        seen += value.byteLength;
        if (seen > MAX_STREAM_BYTES) return;
        buffer += decoder.decode(value, { stream: true });
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } catch {
    // A socket that dies mid-stream ends the turn; the caller reports what it got.
  } finally {
    // `cancel()` on an already-finished reader rejects on some runtimes; it is noise.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The `data:` payloads of an SSE stream, in order, with `[DONE]` dropped.
 *
 * Only `data:` is read. `event:`, `id:` and comments are skipped, because no provider in
 * the bundled catalogue puts anything in them that the turn needs — and guessing at an
 * `event:` name we have not seen is how an adapter starts inventing frames.
 */
export async function* sseData(lines: AsyncIterable<string>): AsyncIterable<string> {
  for await (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    yield payload;
  }
}

/**
 * Sentences providers write when the model id is not one of theirs. Matched only on a
 * `400`, because a `404` already says it without help. The text itself is never
 * rewritten — this only decides which code the hub labels it with.
 */
const UNKNOWN_MODEL_MARKERS = [
  'model_not_found',
  'unknown model',
  'model not found',
  'does not exist',
  'no such model',
  'invalid model',
  'not a valid model',
] as const;

/** A refused or unreachable stream, as the `failed` event an adapter yields. */
export function chatFailure(open: Extract<StreamOpen, { ok: false }>): ChatEvent {
  const detail = open.detail ?? open.error;
  return {
    type: 'failed',
    reason: chatFailureReason(open),
    detail: detail ? detail.slice(0, 500) : null,
    status: open.status,
  };
}

function chatFailureReason(open: Extract<StreamOpen, { ok: false }>): ChatFailureReason {
  if (open.cancelled) return 'cancelled';
  if (open.status === null) return 'unreachable';
  if (open.status === 401 || open.status === 403) return 'unauthorized';
  if (open.status === 429) return 'rate_limited';
  if (open.status === 404) return 'model_not_found';
  if (open.status === 400) {
    const text = (open.detail ?? '').toLowerCase();
    if (UNKNOWN_MODEL_MARKERS.some((marker) => text.includes(marker))) return 'model_not_found';
  }
  return 'http_error';
}

/** `JSON.parse` that returns `null` instead of throwing: a malformed frame is skipped. */
export function parseFrame(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
