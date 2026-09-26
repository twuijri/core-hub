/**
 * «ويب هوك» on the agent's Channels page (decision §96): Hermes's incoming webhooks.
 *
 * - the section lists each route with its full address on this hub and its secret (hidden until
 *   shown), each with a copy button; a route from `config.yaml` cannot be deleted here;
 * - it says plainly that outside services need the hub's address to be public — louder when the
 *   page was opened on a private or local address;
 * - «ويب هوك جديد» creates a route with a name, a prompt and its events; a name Hermes would not
 *   take is refused before sending;
 * - «اختبار» sends the local test and says it was accepted; «حذف» asks first, then deletes.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';
import { eventsOf, isPrivateOrigin, webhookUrl } from '../src/agents/webhooks.js';
import { catalogOf } from './helpers/channel-catalog.js';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  once() {
    return this;
  }
  connect() {
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, connectNamespace: () => new FakeSocket() };
});

const { App } = await import('../src/app.js');
const { SessionStore } = await import('../src/auth/store.js');

afterEach(cleanup);

function memoryStorage(): Storage {
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

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const SECRET = 'Zq3xV9b4mN0pR7sT2wY5aC8dF1gH6jK9LmN3pQ5rS7';

const AGENT = {
  id: HERMES,
  profile: 'default',
  owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'hermes',
  name: 'Hermes',
  vendor: null,
  kind: 'hermes',
  adapter: 'hermes',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['streaming', 'skills', 'memory', 'channels'],
  sections: [],
  default_model: null,
  runtime: { state: 'running', url: null, error: null, gateways: [] },
  install: {
    source: 'bundled',
    version: '1.0.0',
    error: null,
    update_available: false,
    latest_version: null,
  },
} as unknown as Agent;

type Route = Record<string, unknown>;

const ISSUES: Route = {
  name: 'github-issues',
  description: 'Issues of the repository',
  prompt: 'A new issue: {issue.title}',
  events: ['issues'],
  deliver: 'log',
  secret: SECRET,
  path: '/api/v1/hermes-webhooks/default/github-issues',
  static: false,
  created_at: '2026-09-27T01:20:00Z',
};

const FROM_CONFIG: Route = {
  name: 'from-config',
  description: null,
  prompt: '',
  events: [],
  deliver: 'log',
  secret: null,
  path: '/api/v1/hermes-webhooks/default/from-config',
  static: true,
  created_at: null,
};

function hub(routes: Route[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | Request, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(String(request ? request.url : input));
    const path = decodeURIComponent(url.pathname);
    const method = (request?.method ?? init.method ?? 'GET').toUpperCase();
    const raw = request ? await request.clone().text() : (init.body as string | undefined);
    calls.push({ method, path, body: raw ? JSON.parse(raw) : null });
    const json = (value: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path.endsWith('/agents')) return json({ items: [AGENT] });
    if (path.endsWith(`/agents/${HERMES}`)) return json(AGENT);
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/channel-platforms')) return json({ items: catalogOf() });
    if (path.endsWith('/channels') && method === 'GET') {
      return json({
        items: [],
        gateway: { profile: 'default', state: 'running', applies: 'now', error: null },
      });
    }
    if (path.endsWith('/pairing') && method === 'GET') return json({ pending: [], approved: [] });
    if (path.endsWith('/webhooks') && method === 'GET') {
      return json({
        listener: { enabled: routes.length > 0, port: 18650, status: 'online', error: null },
        items: routes,
      });
    }
    if (path.endsWith('/webhooks') && method === 'POST') {
      const body = JSON.parse(raw ?? '{}') as Route;
      const made = {
        ...ISSUES,
        ...body,
        secret: SECRET,
        path: `/api/v1/hermes-webhooks/default/${String(body.name)}`,
      };
      routes.push(made);
      return json(made, 201);
    }
    if (path.endsWith('/test') && method === 'POST') {
      return json({
        status: 202,
        body: { status: 'accepted', route: 'github-issues', event: 'test', delivery_id: 'd' },
      });
    }
    if (method === 'DELETE' && path.includes('/webhooks/')) {
      const name = path.split('/').at(-1);
      routes.splice(
        routes.findIndex((route) => route.name === name),
        1,
      );
      return json(null, 204);
    }
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function mount(fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: '01J8QK3ZR2W7M5N4P6T8V9X0AA', username: 'u', display_name: 'U', role: 'owner' },
  });
  render(
    <App
      store={store}
      baseUrl="http://hub.test"
      fetchImpl={fetchImpl}
      router={(children) => (
        <MemoryRouter initialEntries={[`/agents/${HERMES}/channels`]}>{children}</MemoryRouter>
      )}
    />,
  );
}

describe('the rules the section draws from', () => {
  it('says which addresses an outside service cannot reach', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://192.168.1.20',
      'http://10.0.0.5:3000',
      'http://172.20.1.1',
      'http://hub.local',
      'http://nas',
      'http://[::1]:3000',
    ]) {
      expect(isPrivateOrigin(origin), origin).toBe(true);
    }
    for (const origin of ['https://hub.example.com', 'https://203.0.113.9', 'https://172.32.0.1']) {
      expect(isPrivateOrigin(origin), origin).toBe(false);
    }
  });

  it('builds the full address and reads events', () => {
    expect(webhookUrl('https://hub.example.com/', ISSUES as never)).toBe(
      'https://hub.example.com/api/v1/hermes-webhooks/default/github-issues',
    );
    expect(eventsOf('issues, push  issues،pull_request')).toEqual([
      'issues',
      'push',
      'pull_request',
    ]);
  });
});

describe('«ويب هوك» on the Channels page', () => {
  it('lists each route with its address and its hidden secret, both copyable', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const { fetchImpl } = hub([ISSUES, FROM_CONFIG]);
    mount(fetchImpl);
    const row = await screen.findByTestId('webhook-github-issues');
    const origin = window.location.origin;
    expect(within(row).getByTestId('webhook-url-github-issues').textContent).toBe(
      `${origin}/api/v1/hermes-webhooks/default/github-issues`,
    );
    expect(within(row).getByTestId('webhook-prompt-github-issues').textContent).toBe(
      'A new issue: {issue.title}',
    );
    const secret = within(row).getByTestId('webhook-secret-github-issues');
    expect(secret.textContent).not.toContain(SECRET);
    fireEvent.click(within(row).getByTestId('webhook-show-secret-github-issues'));
    expect(secret.textContent).toBe(SECRET);
    fireEvent.click(within(row).getByTestId('webhook-copy-url-github-issues'));
    fireEvent.click(within(row).getByTestId('webhook-copy-secret-github-issues'));
    expect(writeText).toHaveBeenCalledWith(
      `${origin}/api/v1/hermes-webhooks/default/github-issues`,
    );
    expect(writeText).toHaveBeenCalledWith(SECRET);
    // A route from config.yaml: listed, marked, not deletable here.
    const statik = screen.getByTestId('webhook-from-config');
    expect(within(statik).queryByTestId('webhook-delete-from-config')).toBeNull();
    expect(screen.getByTestId('webhook-listener').getAttribute('data-state')).toBe('online');
    // jsdom's page is on localhost: the section says a public address is needed, loudly.
    const note = screen.getByTestId('webhook-public-note');
    expect(note.getAttribute('data-private')).toBe('true');
    expect(note.textContent).toMatch(/public address/);
  });

  it('creates a route with its prompt and events, refusing a name Hermes would not take', async () => {
    const routes: Route[] = [];
    const { fetchImpl, calls } = hub(routes);
    mount(fetchImpl);
    expect(await screen.findByTestId('webhooks-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('webhook-new'));
    const dialog = await screen.findByTestId('webhook-create-dialog');
    fireEvent.change(within(dialog).getByTestId('webhook-name'), { target: { value: 'Bad Name' } });
    fireEvent.change(within(dialog).getByTestId('webhook-prompt'), {
      target: { value: 'Deploy of {repo.name}: {status}' },
    });
    expect(within(dialog).getByTestId('webhook-create')).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('webhook-name'), { target: { value: 'deploys' } });
    fireEvent.change(within(dialog).getByTestId('webhook-events'), {
      target: { value: 'deployment_status, push' },
    });
    fireEvent.click(within(dialog).getByTestId('webhook-create'));
    await waitFor(() => expect(screen.queryByTestId('webhook-create-dialog')).toBeNull());
    const post = calls.find((call) => call.method === 'POST' && call.path.endsWith('/webhooks'));
    expect(post?.body).toEqual({
      name: 'deploys',
      prompt: 'Deploy of {repo.name}: {status}',
      description: null,
      events: ['deployment_status', 'push'],
      deliver: 'log',
    });
    expect(await screen.findByTestId('webhook-deploys')).toBeTruthy();
  });

  it('tests a route and says it was accepted; deletes one after asking', async () => {
    const routes: Route[] = [{ ...ISSUES }];
    const { fetchImpl, calls } = hub(routes);
    mount(fetchImpl);
    fireEvent.click(await screen.findByTestId('webhook-test-github-issues'));
    const result = await screen.findByTestId('webhook-test-result-github-issues');
    expect(result.getAttribute('data-status')).toBe('202');
    expect(result.textContent).toMatch(/Accepted|قُبل/);

    fireEvent.click(screen.getByTestId('webhook-delete-github-issues'));
    // Nothing is deleted before the person says so.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /Delete|حذف/ }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'DELETE' && call.path.endsWith('/webhooks/github-issues'),
        ),
      ).toBe(true),
    );
    expect(await screen.findByTestId('webhooks-empty')).toBeTruthy();
  });
});
