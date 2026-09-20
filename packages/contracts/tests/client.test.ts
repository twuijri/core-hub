import { describe, expect, it } from 'vitest';
import type { HubApiError } from '../src/client.js';
import { createHubClient, fillPath } from '../src/client.js';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createHubClient', () => {
  it('prefixes /api/v1, fills path params, and sends scope + auth headers', async () => {
    const { fetchImpl, calls } = fakeFetch(200, {
      status: 'ok',
      version: '0.0.0',
      database: 'sqlite',
    });
    const client = createHubClient({
      baseUrl: 'http://hub.test/',
      fetch: fetchImpl,
      token: 'secret-token',
      profile: 'work',
      language: 'ar',
    });
    const res = await client.raw('get', '/things/{id}', {
      params: { id: 'a b' },
      query: { limit: 5, skip: undefined },
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe('http://hub.test/api/v1/things/a%20b?limit=5');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['X-Hub-Profile']).toBe('work');
    expect(headers['Accept-Language']).toBe('ar');
  });

  it('turns the error envelope into HubApiError', async () => {
    const { fetchImpl } = fakeFetch(501, { error: 'غير منفّذ بعد', code: 'not_implemented' });
    const client = createHubClient({ baseUrl: 'http://hub.test', fetch: fetchImpl });
    await expect(client.raw('post', '/anything', { body: { a: 1 } })).rejects.toMatchObject({
      name: 'HubApiError',
      status: 501,
      code: 'not_implemented',
    } satisfies Partial<HubApiError>);
  });

  it('refuses to build a URL with a missing path parameter', () => {
    expect(() => fillPath('/sessions/{id}', {})).toThrow(/Missing path parameter "id"/);
  });
});
