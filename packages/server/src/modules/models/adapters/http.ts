/**
 * Shared HTTP plumbing for the provider adapters.
 *
 * Two rules everything here exists to keep:
 * - a failure is a value, never an exception, so `models.testProvider` can answer
 *   `200 { ok: false }` as the contract documents;
 * - no API key, and no header carrying one, is ever put in a message, a log line or a
 *   thrown error. `detail` carries the provider's own words and nothing of ours.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/** Enough for a model list; a provider that streams megabytes of JSON is misbehaving. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpAnswer {
  ok: boolean;
  status: number | null;
  /** Parsed JSON when the body was JSON, the trimmed text otherwise, null on failure. */
  body: unknown;
  text: string | null;
  /** Transport-level failure (DNS, refused, timeout); null when the server answered. */
  error: string | null;
  durationMs: number;
}

export interface JsonRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

export async function requestJson(request: JsonRequest): Promise<HttpAnswer> {
  const started = Date.now();
  try {
    const response = await request.fetchImpl(request.url, {
      method: request.method ?? 'GET',
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(request.headers ?? {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    const text = (await response.text()).slice(0, MAX_BODY_BYTES);
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      text,
      error: null,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      text: null,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

export interface BytesAnswer {
  ok: boolean;
  status: number | null;
  bytes: Uint8Array | null;
  contentType: string | null;
  /** The provider's error text when it refused; never our request. */
  detail: string | null;
  error: string | null;
}

export async function requestBytes(request: JsonRequest): Promise<BytesAnswer> {
  try {
    const response = await request.fetchImpl(request.url, {
      method: request.method ?? 'POST',
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      headers: {
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(request.headers ?? {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2_000);
      return {
        ok: false,
        status: response.status,
        bytes: null,
        contentType: null,
        detail: text.trim() || null,
        error: null,
      };
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      ok: true,
      status: response.status,
      bytes: buffer,
      contentType: response.headers.get('content-type'),
      detail: null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      bytes: null,
      contentType: null,
      detail: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A `multipart/form-data` POST whose answer is JSON — the shape of every OpenAI-style
 * upload (`audio/transcriptions`). `fetch` writes the boundary itself; nothing here sets
 * `content-type`, or the provider could not find the parts.
 */
export async function requestForm(request: {
  url: string;
  headers?: Record<string, string>;
  form: FormData;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<HttpAnswer> {
  const started = Date.now();
  try {
    const response = await request.fetchImpl(request.url, {
      method: 'POST',
      signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
      headers: { accept: 'application/json', ...(request.headers ?? {}) },
      body: request.form,
    });
    const text = (await response.text()).slice(0, MAX_BODY_BYTES);
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      text,
      error: null,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      text: null,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

/** Why a request failed, in the vocabulary `ProviderTestResult.reason` uses. */
export function reasonOf(answer: { ok: boolean; status: number | null; error: string | null }) {
  if (answer.ok) return 'ok';
  if (answer.error !== null) return 'unreachable';
  if (answer.status === 401 || answer.status === 403) return 'unauthorized';
  if (answer.status === 429) return 'rate_limited';
  return 'http_error';
}

/**
 * The provider's own error sentence, pulled out of the shapes providers actually use, and
 * capped. Never echoes a request header.
 */
export function detailOf(answer: HttpAnswer): string | null {
  if (answer.error) return answer.error.slice(0, 200);
  const body = answer.body as {
    error?: { message?: unknown } | string;
    message?: unknown;
    detail?: unknown;
  } | null;
  const candidate =
    (typeof body?.error === 'object' && body.error && typeof body.error.message === 'string'
      ? body.error.message
      : undefined) ??
    (typeof body?.error === 'string' ? body.error : undefined) ??
    (typeof body?.message === 'string' ? body.message : undefined) ??
    (typeof body?.detail === 'string' ? body.detail : undefined) ??
    answer.text ??
    undefined;
  const text = typeof candidate === 'string' ? candidate.trim() : '';
  return text ? text.slice(0, 200) : null;
}

/** `https://api.example.com/v1` + `models` -> `https://api.example.com/v1/models`. */
export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}
