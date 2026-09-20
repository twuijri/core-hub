// A tiny typed fetch wrapper over the generated `paths` types. Every client (web, desktop)
// goes through this or through the Kotlin/Swift generated clients — never a hand-typed path.
import type { paths } from '../generated/ts/schema.js';

export type ClientMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type PathsWithMethod<M extends ClientMethod> = {
  [P in keyof paths]: M extends keyof paths[P]
    ? paths[P][M] extends undefined
      ? never
      : P
    : never;
}[keyof paths];

type OperationOf<P extends keyof paths, M extends ClientMethod> = M extends keyof paths[P]
  ? paths[P][M]
  : never;

type JsonOf<T> = T extends { content: { 'application/json': infer D } } ? D : never;

type SuccessData<Op> = Op extends { responses: infer R }
  ? { [S in keyof R]: S extends 200 | 201 | 202 | 204 ? JsonOf<R[S]> : never }[keyof R]
  : unknown;

type PathParams<Op> = Op extends { parameters: { path: infer P } }
  ? P extends undefined
    ? Record<string, never>
    : P
  : Record<string, never>;

type QueryParams<Op> = Op extends { parameters: { query?: infer Q } }
  ? Q extends undefined
    ? Record<string, string | number | boolean | undefined>
    : Q
  : Record<string, string | number | boolean | undefined>;

type RequestBody<Op> = Op extends { requestBody: infer B }
  ? JsonOf<NonNullable<B>>
  : Op extends { requestBody?: infer B }
    ? JsonOf<NonNullable<B>> | undefined
    : undefined;

export interface RequestInitOptions<Op> {
  params?: PathParams<Op>;
  query?: QueryParams<Op>;
  body?: RequestBody<Op>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RawRequestInit {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** The server's error envelope (`{ error, code }`), surfaced as an exception. */
export class HubApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'HubApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface HubClientOptions {
  /** Server origin, e.g. `https://hub.example`. The `/api/v1` prefix is added by the client. */
  baseUrl: string;
  /** Defaults to `/api/v1` — the contract's `servers[0].url`. */
  apiBase?: string;
  fetch?: typeof fetch;
  /** Bearer token or a getter for it. */
  token?: string | (() => string | undefined);
  /** Workspace scope sent as `X-Hub-Profile` (ADR 0005). */
  profile?: string | (() => string | undefined);
  /** UI language sent as `Accept-Language`; the server localises `error` on it. */
  language?: 'ar' | 'en';
}

export interface HubClient {
  request<M extends ClientMethod, P extends PathsWithMethod<M>>(
    method: M,
    path: P,
    init?: RequestInitOptions<OperationOf<P, M>>,
  ): Promise<HubResponse<SuccessData<OperationOf<P, M>>>>;
  /** Untyped escape hatch used by the contract test to exercise every operation. */
  raw(method: ClientMethod, path: string, init?: RawRequestInit): Promise<HubResponse<unknown>>;
}

const resolve = (value: string | (() => string | undefined) | undefined): string | undefined =>
  typeof value === 'function' ? value() : value;

export function fillPath(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null)
      throw new Error(`Missing path parameter "${name}" for ${template}`);
    return encodeURIComponent(String(value));
  });
}

export function createHubClient(options: HubClientOptions): HubClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? '/api/v1').replace(/\/$/, '');
  const origin = options.baseUrl.replace(/\/$/, '');

  async function raw(
    method: ClientMethod,
    path: string,
    init: RawRequestInit = {},
  ): Promise<HubResponse<unknown>> {
    const url = new URL(`${origin}${apiBase}${fillPath(path, init.params)}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    const token = resolve(options.token);
    if (token) headers.Authorization = `Bearer ${token}`;
    const profile = resolve(options.profile);
    if (profile) headers['X-Hub-Profile'] = profile;
    if (options.language) headers['Accept-Language'] = options.language;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const response = await doFetch(url, {
      method: method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const text = await response.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const envelope = (data ?? {}) as { error?: unknown; code?: unknown };
      const code = typeof envelope.code === 'string' ? envelope.code : 'http_error';
      const message =
        typeof envelope.error === 'string' ? envelope.error : `HTTP ${response.status}`;
      throw new HubApiError(response.status, code, message, data);
    }
    return { status: response.status, data, headers: response.headers };
  }

  return {
    request: raw as unknown as HubClient['request'],
    raw,
  };
}
