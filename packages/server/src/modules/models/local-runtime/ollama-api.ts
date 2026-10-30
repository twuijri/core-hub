/**
 * The few calls of Ollama's own HTTP API the hub makes (ADR 0032 §4), against any Ollama — the
 * one the hub installed or one already on the computer
 * (<https://github.com/ollama/ollama/blob/main/docs/api.md>).
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createInterface } from 'node:readline';
import { HubError } from '../../../lib/errors.js';

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

export interface OllamaLoaded {
  name: string;
  size: number;
  sizeVram: number;
  expiresAt: string | null;
}

export interface PullProgress {
  status: string;
  total: number | null;
  completed: number | null;
}

function unreachable(base: string, error: unknown): HubError {
  return new HubError('service_unavailable', {
    message: `Ollama at ${base} did not answer: ${error instanceof Error ? error.message : String(error)}`,
  });
}

async function call(
  fetchImpl: typeof fetch,
  base: string,
  pathname: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${pathname}`, {
      ...rest,
      ...(timeoutMs > 0 ? { signal: rest.signal ?? AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (error) {
    throw unreachable(base, error);
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // The status says enough.
    }
    throw new HubError(response.status === 404 ? 'not_found' : 'bad_request', {
      message: `Ollama: ${detail}`,
    });
  }
  return response;
}

/** The running server's version, or null when nothing answers at `base`. */
export async function ollamaVersion(
  fetchImpl: typeof fetch,
  base: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  try {
    const response = await call(fetchImpl, base, '/api/version', { timeoutMs });
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export async function listOllamaModels(
  fetchImpl: typeof fetch,
  base: string,
): Promise<OllamaModel[]> {
  const response = await call(fetchImpl, base, '/api/tags');
  const body = (await response.json()) as { models?: unknown };
  const rows = Array.isArray(body.models) ? body.models : [];
  return rows.flatMap((row): OllamaModel[] => {
    const model = row as Record<string, unknown>;
    const details = (model.details ?? {}) as Record<string, unknown>;
    const name =
      typeof model.name === 'string'
        ? model.name
        : typeof model.model === 'string'
          ? model.model
          : null;
    if (!name) return [];
    return [
      {
        name,
        size: typeof model.size === 'number' ? model.size : 0,
        modifiedAt: typeof model.modified_at === 'string' ? model.modified_at : null,
        family: typeof details.family === 'string' ? details.family : null,
        parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : null,
        quantization:
          typeof details.quantization_level === 'string' ? details.quantization_level : null,
      },
    ];
  });
}

export async function loadedOllamaModels(
  fetchImpl: typeof fetch,
  base: string,
): Promise<OllamaLoaded[]> {
  const response = await call(fetchImpl, base, '/api/ps');
  const body = (await response.json()) as { models?: unknown };
  const rows = Array.isArray(body.models) ? body.models : [];
  return rows.flatMap((row): OllamaLoaded[] => {
    const model = row as Record<string, unknown>;
    const name = typeof model.name === 'string' ? model.name : null;
    if (!name) return [];
    return [
      {
        name,
        size: typeof model.size === 'number' ? model.size : 0,
        sizeVram: typeof model.size_vram === 'number' ? model.size_vram : 0,
        expiresAt: typeof model.expires_at === 'string' ? model.expires_at : null,
      },
    ];
  });
}

export async function deleteOllamaModel(
  fetchImpl: typeof fetch,
  base: string,
  name: string,
): Promise<void> {
  await call(fetchImpl, base, '/api/delete', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name }),
  });
}

/**
 * Pulls `name`, calling `onProgress` for each line Ollama streams. Resolves when the pull
 * succeeds; rejects with Ollama's own message when it fails. `signal` cancels it.
 */
export async function pullOllamaModel(
  fetchImpl: typeof fetch,
  base: string,
  name: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await call(fetchImpl, base, '/api/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    timeoutMs: 0,
    ...(signal ? { signal } : {}),
  });
  if (!response.body) throw unreachable(base, new Error('empty answer'));
  const lines = createInterface({
    input: Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    crlfDelay: Infinity,
  });
  let finished = false;
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.error === 'string') {
      throw new HubError('bad_request', { message: `Ollama: ${event.error}` });
    }
    const status = typeof event.status === 'string' ? event.status : '';
    onProgress({
      status,
      total: typeof event.total === 'number' ? event.total : null,
      completed: typeof event.completed === 'number' ? event.completed : null,
    });
    if (status === 'success') finished = true;
  }
  if (!finished) throw unreachable(base, new Error('the pull ended before it finished'));
}
