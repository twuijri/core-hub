import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOpenApiDocument, serverBasePath } from '@corehub/contracts';
import { anonymousClient, authenticatedClient, normaliseServer } from '../src/client.js';
import { ConfigStore, type StoredSession } from '../src/config.js';
import { AuthError, UsageError } from '../src/errors.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store(): ConfigStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-cli-'));
  dirs.push(dir);
  return new ConfigStore(path.join(dir, 'config.json'));
}

type Reply = { status: number; body: unknown };
function fakeFetch(handler: (url: string, init: RequestInit) => Reply) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = handler(url, init);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const bearer = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

describe('normaliseServer', () => {
  it('accepts an http(s) origin and rejects everything else', () => {
    expect(normaliseServer('https://hub.example/')).toBe('https://hub.example');
    expect(normaliseServer('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    for (const bad of [undefined, '', 'hub.example', 'ftp://x', 'https://hub.example/path'])
      expect(() => normaliseServer(bad)).toThrow(UsageError);
  });
});

describe('the generated client', () => {
  it('prefixes every path with the base the contract declares', async () => {
    const doc = loadOpenApiDocument();
    expect(doc).not.toBeNull();
    const fetch = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await anonymousClient({ server: 'http://hub', language: 'en', fetch: fetch.impl }).request(
      'get',
      '/health',
    );
    expect(fetch.calls[0]?.url).toBe(`http://hub${serverBasePath(doc!)}/health`);
    expect((fetch.calls[0]?.init.headers as Record<string, string>)['Accept-Language']).toBe('en');
  });
});

describe('authenticatedClient', () => {
  const session: StoredSession = {
    server: 'http://hub',
    profile: 'work',
    token: 'old-jwt',
    token_kind: 'session',
    refresh_token: 'hub_rt_1',
    expires_at: null,
    user: { id: '01J8QK3ZR2W7M5N4P6T8V9X0HM', username: 'admin', display_name: 'A', role: 'owner' },
  };

  it('refuses to start without a stored session (exit 3)', () => {
    expect(() => authenticatedClient(store(), { language: 'en' })).toThrow(AuthError);
  });

  it('sends the bearer and the workspace header', async () => {
    const s = store();
    s.saveSession(session);
    const fetch = fakeFetch(() => ({ status: 200, body: { items: [] } }));
    const { client } = authenticatedClient(s, {
      language: 'ar',
      fetch: fetch.impl,
      profile: 'other',
    });
    await client.request('get', '/agents');
    const headers = fetch.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer old-jwt');
    expect(headers['X-Hub-Profile']).toBe('other');
    expect(headers['Accept-Language']).toBe('ar');
  });

  it('refreshes once on token_expired, stores the rotated tokens and retries', async () => {
    const s = store();
    s.saveSession(session);
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith('/auth/refresh'))
        return {
          status: 200,
          body: {
            access_token: 'new-jwt',
            refresh_token: 'hub_rt_2',
            expires_in: 900,
            user: { id: session.user.id },
          },
        };
      if (bearer(init) === 'Bearer old-jwt')
        return { status: 401, body: { error: 'expired', code: 'token_expired' } };
      return { status: 200, body: { id: session.user.id, username: 'admin' } };
    });
    const auth = authenticatedClient(s, { language: 'en', fetch: fetch.impl });
    const res = await auth.client.request('get', '/auth/me');
    expect(res.status).toBe(200);
    expect(fetch.calls.map((c) => c.url.split('/').pop())).toEqual(['me', 'refresh', 'me']);
    expect(bearer(fetch.calls[2]!.init)).toBe('Bearer new-jwt');
    expect(JSON.parse(String(fetch.calls[1]!.init.body))).toEqual({ refresh_token: 'hub_rt_1' });
    expect(s.session()).toMatchObject({ token: 'new-jwt', refresh_token: 'hub_rt_2' });
    expect(auth.session().token).toBe('new-jwt');
  });

  it('gives up after one failed refresh and surfaces the 401', async () => {
    const s = store();
    s.saveSession(session);
    const fetch = fakeFetch((url) =>
      url.endsWith('/auth/refresh')
        ? { status: 401, body: { error: 'nope', code: 'unauthorized' } }
        : { status: 401, body: { error: 'expired', code: 'token_expired' } },
    );
    const { client } = authenticatedClient(s, { language: 'en', fetch: fetch.impl });
    await expect(client.request('get', '/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(fetch.calls).toHaveLength(2);
  });
});
