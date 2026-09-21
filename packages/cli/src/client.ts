// The HTTP side: the generated client from @majlis/contracts, wrapped so an expired web
// session refreshes itself once and an app token renews before it lapses. Every request the
// CLI makes goes through `createHubClient` — no hand-typed path exists in this package.
import {
  HubApiError,
  createHubClient,
  type ClientMethod,
  type HubClient,
  type RawRequestInit,
} from '@majlis/contracts';
import type { ConfigStore, StoredSession } from './config.js';
import { AuthError, UsageError } from './errors.js';
import type { Language } from './i18n/index.js';

export interface ClientOptions {
  server: string;
  language: Language;
  fetch?: typeof fetch;
}

/** Accepts `https://host[:port][/]` and returns the origin without a trailing slash. */
export function normaliseServer(input: string | undefined): string {
  if (!input || input.trim() === '') throw new UsageError('errors.server_required');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UsageError('errors.server_invalid', { server: input });
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new UsageError('errors.server_invalid', { server: input });
  return url.origin;
}

export function anonymousClient(options: ClientOptions): HubClient {
  return createHubClient({
    baseUrl: options.server,
    language: options.language,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

const RENEW_APP_TOKEN_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_SESSION_BEFORE_MS = 30 * 1000;

export interface AuthenticatedClient {
  client: HubClient;
  /** The session as last stored (tokens may rotate during a command). */
  session(): StoredSession;
}

/**
 * A client bound to the stored session. A `401 token_expired` triggers one refresh and one
 * retry; a web session close to expiry refreshes proactively; an app token with less than
 * seven days left renews (contract: `auth.refresh` with a bearer and no body).
 */
export function authenticatedClient(
  store: ConfigStore,
  options: { language: Language; profile?: string | undefined; fetch?: typeof fetch },
): AuthenticatedClient {
  let session = store.session();
  if (!session) throw new AuthError();
  const current = (): StoredSession => session as StoredSession;
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const client = createHubClient({
    baseUrl: current().server,
    language: options.language,
    token: () => current().token,
    profile: () => options.profile ?? current().profile,
    ...fetchOption,
  });
  const anonymous = createHubClient({
    baseUrl: current().server,
    language: options.language,
    ...fetchOption,
  });

  let refreshing: Promise<boolean> | undefined;
  const refresh = (): Promise<boolean> => {
    refreshing ??= doRefresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  async function doRefresh(): Promise<boolean> {
    const s = current();
    try {
      if (s.token_kind === 'session') {
        if (!s.refresh_token) return false;
        const res = await anonymous.request('post', '/auth/refresh', {
          body: { refresh_token: s.refresh_token },
        });
        session = {
          ...s,
          token: res.data.access_token,
          refresh_token: res.data.refresh_token,
          expires_at: expiresAt(res.data.expires_in),
        };
      } else {
        const res = await client.request('post', '/auth/refresh');
        session = { ...s, expires_at: expiresAt(res.data.expires_in) };
      }
      store.saveSession(session);
      return true;
    } catch {
      return false;
    }
  }

  const raw = async (method: ClientMethod, path: string, init?: RawRequestInit) => {
    const s = current();
    if (s.expires_at) {
      const left = Date.parse(s.expires_at) - Date.now();
      const margin =
        s.token_kind === 'session' ? REFRESH_SESSION_BEFORE_MS : RENEW_APP_TOKEN_BEFORE_MS;
      if (Number.isFinite(left) && left < margin) await refresh();
    }
    try {
      return await client.raw(method, path, init);
    } catch (error) {
      if (
        error instanceof HubApiError &&
        error.status === 401 &&
        error.code === 'token_expired' &&
        (await refresh())
      )
        return client.raw(method, path, init);
      throw error;
    }
  };

  return {
    client: { raw, request: raw as unknown as HubClient['request'] },
    session: current,
  };
}

export function expiresAt(expiresInSeconds: number, now: number = Date.now()): string {
  return new Date(now + expiresInSeconds * 1000).toISOString();
}
