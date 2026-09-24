import { HubApiError } from '@corehub/contracts';
import { describe, expect, it } from 'vitest';
import { createClientBundle } from '../src/auth/client.js';
import { SessionStore, isSession } from '../src/auth/store.js';

function memory(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

const envelope = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('auth client', () => {
  it('refreshes once on 401 token_expired and retries with the new bearer', async () => {
    const store = new SessionStore(memory());
    store.save({
      profile: 'work',
      token: 'old',
      refresh_token: 'rt1',
      expires_at: null,
      user: { id: 'u', username: 'a', display_name: 'A', role: 'owner' },
    });
    const calls: Array<{ url: string; auth: string | null; profile: string | null }> = [];
    let refreshes = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        auth: headers.get('Authorization'),
        profile: headers.get('X-Hub-Profile'),
      });
      if (url.endsWith('/auth/refresh')) {
        refreshes += 1;
        return envelope(200, {
          access_token: 'new',
          refresh_token: 'rt2',
          expires_in: 900,
          user: {},
        });
      }
      if (headers.get('Authorization') === 'Bearer old')
        return envelope(401, { error: 'expired', code: 'token_expired' });
      return envelope(200, { items: [], next_cursor: null });
    };
    const bundle = createClientBundle({
      baseUrl: 'http://hub.test',
      store,
      language: () => 'ar',
      profile: () => 'work',
      fetch: fetchImpl,
    });
    const [a, b] = await Promise.all([
      bundle.client.request('get', '/sessions'),
      bundle.client.request('get', '/agents'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refreshes).toBe(1);
    expect(store.read()?.token).toBe('new');
    expect(store.read()?.refresh_token).toBe('rt2');
    expect(calls.at(-1)?.auth).toBe('Bearer new');
    expect(calls[0]?.profile).toBe('work');
  });

  it('signs out when the refresh itself is refused', async () => {
    const store = new SessionStore(memory());
    store.save({
      profile: 'default',
      token: 'old',
      refresh_token: 'rt1',
      expires_at: null,
      user: { id: 'u', username: 'a', display_name: 'A', role: 'owner' },
    });
    let signedOut = false;
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/refresh')
        ? envelope(401, { error: 'no', code: 'unauthorized' })
        : envelope(401, { error: 'expired', code: 'token_expired' });
    const bundle = createClientBundle({
      baseUrl: 'http://hub.test',
      store,
      language: () => 'en',
      profile: () => undefined,
      fetch: fetchImpl,
      onSignedOut: () => (signedOut = true),
    });
    await expect(bundle.client.request('get', '/sessions')).rejects.toBeInstanceOf(HubApiError);
    expect(signedOut).toBe(true);
    expect(store.read()).toBeNull();
  });

  it('refreshes proactively when the access token is about to expire', async () => {
    const store = new SessionStore(memory());
    store.save({
      profile: 'default',
      token: 'old',
      refresh_token: 'rt1',
      expires_at: new Date(Date.now() + 5_000).toISOString(),
      user: { id: 'u', username: 'a', display_name: 'A', role: 'owner' },
    });
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return String(input).endsWith('/auth/refresh')
        ? envelope(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 900, user: {} })
        : envelope(200, { items: [] });
    };
    const bundle = createClientBundle({
      baseUrl: 'http://hub.test',
      store,
      language: () => 'en',
      profile: () => undefined,
      fetch: fetchImpl,
    });
    await bundle.client.request('get', '/agents');
    expect(urls[0]).toMatch(/\/auth\/refresh$/);
    expect(urls[1]).toMatch(/\/agents$/);
  });

  it('validates stored sessions', () => {
    expect(
      isSession({
        profile: 'x',
        token: 't',
        refresh_token: null,
        expires_at: null,
        user: { id: 'u' },
      }),
    ).toBe(true);
    expect(isSession({ token: 't' })).toBe(false);
  });
});
