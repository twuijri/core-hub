/** A fetch that answers like a hub, for the plugin's HTTP side. */
export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (seen: Seen) => { status: number; json?: unknown } | undefined;

export function fakeFetch(route: Route): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = init?.body;
    const s: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: url.searchParams,
      headers,
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
    };
    seen.push(s);
    const answer = route(s) ?? { status: 404, json: { error: 'not found', code: 'not_found' } };
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as typeof fetch, seen };
}
