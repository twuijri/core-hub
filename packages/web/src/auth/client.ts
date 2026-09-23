// HTTP: the generated client from @majlis/contracts, wrapped so an expired access token
// refreshes itself once (single flight) and proactively near expiry. No hand-typed path
// exists in this package (`pnpm contracts:check-clients`).
import {
  HubApiError,
  createHubClient,
  type ClientMethod,
  type HubClient,
  type RawRequestInit,
} from '@majlis/contracts';
import type { Language } from '../i18n/index.js';
import { expiresAt, type SessionStore } from './store.js';

const REFRESH_BEFORE_MS = 30_000;

export interface HubClientBundle {
  /** Authenticated (refreshing) client; throws `HubApiError` 401 when signed out. */
  client: HubClient;
  /** Unauthenticated client for login, meta and pairing claims. */
  anonymous: HubClient;
}

export interface BundleOptions {
  baseUrl: string;
  store: SessionStore;
  language: () => Language;
  /** The workspace the app is looking at; may differ from the stored default. */
  profile: () => string | undefined;
  fetch?: typeof fetch;
  /** Called when a refresh fails for good: the app returns to the login screen. */
  onSignedOut?: () => void;
}

export function createClientBundle(options: BundleOptions): HubClientBundle {
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const anonymous = createHubClient({
    baseUrl: options.baseUrl,
    language: options.language(),
    ...fetchOption,
  });
  const inner = createHubClient({
    baseUrl: options.baseUrl,
    token: () => options.store.read()?.token,
    profile: () => options.profile() ?? options.store.read()?.profile,
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
    const session = options.store.read();
    if (!session?.refresh_token) return false;
    try {
      const res = await anonymous.request('post', '/auth/refresh', {
        body: { refresh_token: session.refresh_token },
        headers: { 'Accept-Language': options.language() },
      });
      options.store.save({
        ...session,
        token: res.data.access_token,
        refresh_token: res.data.refresh_token,
        expires_at: expiresAt(res.data.expires_in),
      });
      return true;
    } catch (error) {
      if (error instanceof HubApiError && (error.status === 401 || error.status === 403)) {
        options.store.clear();
        options.onSignedOut?.();
      }
      return false;
    }
  }

  const raw = async (method: ClientMethod, path: string, init?: RawRequestInit) => {
    const session = options.store.read();
    if (!session) throw new HubApiError(401, 'unauthorized', 'not signed in', null);
    if (session.expires_at) {
      const left = Date.parse(session.expires_at) - Date.now();
      if (Number.isFinite(left) && left < REFRESH_BEFORE_MS) await refresh();
    }
    const withLanguage: RawRequestInit = {
      ...init,
      headers: { 'Accept-Language': options.language(), ...init?.headers },
    };
    try {
      return await inner.raw(method, path, withLanguage);
    } catch (error) {
      if (
        error instanceof HubApiError &&
        error.status === 401 &&
        error.code === 'token_expired' &&
        (await refresh())
      )
        return inner.raw(method, path, withLanguage);
      throw error;
    }
  };

  return {
    client: { raw, request: raw as unknown as HubClient['request'] },
    anonymous,
  };
}

/** One human sentence for any error, from the server envelope when there is one. */
export function describeError(
  error: unknown,
  fallback: (key: string, p?: Record<string, string | number>) => string,
): string {
  if (error instanceof HubApiError) {
    if (error.status === 501) {
      const details = (error.body as { details?: { operationId?: string } } | undefined)?.details;
      return fallback('errors.not_implemented', { operation: details?.operationId ?? '?' });
    }
    // A hub failure carries the id of its log line; saying it lets the owner find the cause.
    const ref = (error.body as { details?: { request_id?: string } } | undefined)?.details
      ?.request_id;
    return error.status >= 500 && ref ? `${error.message} (${ref})` : error.message;
  }
  if (error instanceof TypeError && /fetch/i.test(error.message))
    return fallback('errors.connection');
  return fallback('errors.unexpected', {
    message: error instanceof Error ? error.message : String(error),
  });
}
