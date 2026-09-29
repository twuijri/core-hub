/**
 * An MCP server's tools without pressing Test, and which of them the agent may use (DECISIONS
 * §134). The whole app is mounted on a scripted hub that keeps each server's last test as the
 * real one does: the folded row counts the tools, opening it lists them, a server never tested
 * is tested once by itself when it opens, Read-only ticks the looking tools, and Save writes
 * the filter. The rules themselves are tested on their own (`mcp-tool-filter.test.ts`).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';

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
  capabilities: ['streaming', 'skills', 'memory', 'mcp'],
  sections: [],
  default_model: null,
  runtime: { error: null },
  install: {
    source: 'bundled',
    version: '1.0.0',
    error: null,
    update_available: false,
    latest_version: null,
  },
} as unknown as Agent;

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

type Access = 'read' | 'write' | 'unknown';
const tool = (name: string, access: Access, description: string | null = null) => ({
  name,
  description,
  access,
  access_source: 'name' as const,
});

const GITHUB_TOOLS = [
  tool('get_issue', 'read', 'Read one issue.'),
  tool('list_repos', 'read'),
  tool('create_issue', 'write', 'Open an issue.'),
  tool('delete_repo', 'write'),
  tool('hierarchy', 'unknown'),
];

function hub(options: { legacy?: boolean } = {}) {
  const sent: Sent[] = [];
  const last: Record<string, unknown> = {
    github: {
      ok: true,
      tools: GITHUB_TOOLS,
      tool_count: GITHUB_TOOLS.length,
      error: null,
      tested_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      duration_ms: 900,
      stale: false,
    },
    fresh: null,
  };
  const filters: Record<string, { include: string[] | null; exclude: string[] | null }> = {
    github: { include: null, exclude: null },
    fresh: { include: null, exclude: null },
  };
  const row = (name: string) => ({
    name,
    transport: 'stdio',
    enabled: true,
    connected: false,
    tools: [],
    error: null,
    config: { command: name },
    updated_at: '2026-09-29T08:00:00Z',
    ...(options.legacy ? {} : { last_test: last[name] ?? null, tool_filter: filters[name] }),
  });
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ url: `${path}${url.search}`, method, body });
    const json = (value: unknown, code = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: code,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: [AGENT] });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/hub-tools'))
      return json({
        enabled: false,
        available: false,
        unavailable_reason: 'runtime_absent',
        server_name: 'corehub',
        url: null,
        groups: [],
        recent_calls: [],
        updated_at: null,
      });
    const named = /\/mcp-servers\/([^/]+)(\/.*)?$/.exec(path);
    const target = named?.[1] ?? '';
    const rest = named?.[2] ?? '';
    if (rest === '/test') {
      const tools = [tool('echo', 'unknown', 'Repeat.'), tool('add_numbers', 'write')];
      last[target] = {
        ok: true,
        tools,
        tool_count: tools.length,
        error: null,
        tested_at: new Date().toISOString(),
        duration_ms: 400,
        stale: false,
      };
      return json({ ok: true, tools, error: null, duration_ms: 400 });
    }
    if (named && !rest && method === 'PATCH') {
      if (body?.tool_filter) filters[target] = body.tool_filter as (typeof filters)[string];
      return json(row(target));
    }
    if (path.endsWith('/mcp-servers')) return json({ items: [row('github'), row('fresh')] });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, filters };
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
        <MemoryRouter initialEntries={[`/agents/${HERMES}/mcp`]}>{children}</MemoryRouter>
      )}
    />,
  );
}

const tests = (sent: Sent[], name: string) =>
  sent.filter((s) => s.method === 'POST' && s.url.endsWith(`/mcp-servers/${name}/test`));

describe("an MCP server's tools (DECISIONS §134)", () => {
  it('counts the tools on the folded row and lists them on opening, without a test', async () => {
    const { fetchImpl, sent } = hub();
    mount(fetchImpl);
    const count = await screen.findByTestId('mcp-tool-count-github');
    expect(count.textContent).toBe('5 tools');
    expect(screen.getByTestId('mcp-details-github').hidden).toBe(true);

    fireEvent.click(screen.getByTestId('mcp-expand-github'));
    const list = await screen.findByTestId('mcp-tools-github');
    expect(list.textContent).toContain('get_issue');
    expect(list.textContent).toContain('Read one issue.');
    expect(screen.getByTestId('mcp-tested-at-github').textContent).toContain('Tested');
    expect(screen.getByTestId('mcp-tools-allowed-github').textContent).toBe('5 of 5 allowed');
    expect(screen.getByTestId('mcp-tools-note-github').textContent).toContain('No filter');
    expect(tests(sent, 'github')).toHaveLength(0);
  });

  it('tests a never-tested server once, by itself, when its row opens', async () => {
    const { fetchImpl, sent } = hub();
    mount(fetchImpl);
    expect((await screen.findByTestId('mcp-row-fresh')).textContent).not.toContain('tools');
    fireEvent.click(screen.getByTestId('mcp-expand-fresh'));
    await waitFor(() =>
      expect(screen.getByTestId('mcp-tool-count-fresh').textContent).toBe('2 tools'),
    );
    expect((await screen.findByTestId('mcp-tools-fresh')).textContent).toContain('add_numbers');
    // Folding and opening again does not test again.
    fireEvent.click(screen.getByTestId('mcp-expand-fresh'));
    fireEvent.click(screen.getByTestId('mcp-expand-fresh'));
    await screen.findByTestId('mcp-tools-fresh');
    expect(tests(sent, 'fresh')).toHaveLength(1);
    expect(tests(sent, 'github')).toHaveLength(0);
  });

  it('Read-only ticks the looking tools; Save writes an allow-list and the row says "2 of 5"', async () => {
    const { fetchImpl, sent, filters } = hub();
    mount(fetchImpl);
    fireEvent.click(await screen.findByTestId('mcp-expand-github'));
    await screen.findByTestId('mcp-tools-github');
    fireEvent.click(screen.getByTestId('mcp-tools-read-github'));
    const checked = (name: string) =>
      screen.getByTestId(`mcp-tool-check-github-${name}`).getAttribute('data-state');
    expect(checked('get_issue')).toBe('checked');
    expect(checked('list_repos')).toBe('checked');
    expect(checked('create_issue')).toBe('unchecked');
    expect(checked('delete_repo')).toBe('unchecked');
    expect(checked('hierarchy')).toBe('unchecked');
    expect(screen.getByTestId('mcp-tools-note-github').textContent).toContain(
      'stays off until you tick it',
    );
    // One more by hand, then Save.
    fireEvent.click(screen.getByTestId('mcp-tool-check-github-hierarchy'));
    fireEvent.click(screen.getByTestId('mcp-tools-save-github'));
    await screen.findByTestId('mcp-tools-saved-github');
    const patch = sent.find((s) => s.method === 'PATCH' && s.url.endsWith('/mcp-servers/github'));
    expect(patch?.body).toEqual({
      tool_filter: { include: ['get_issue', 'list_repos', 'hierarchy'], exclude: null },
    });
    expect(filters.github).toEqual({
      include: ['get_issue', 'list_repos', 'hierarchy'],
      exclude: null,
    });
    await waitFor(() =>
      expect(screen.getByTestId('mcp-tool-count-github').textContent).toBe('3 of 5 tools'),
    );

    // All again removes the filter altogether.
    fireEvent.click(screen.getByTestId('mcp-tools-all-github'));
    fireEvent.click(screen.getByTestId('mcp-tools-save-github'));
    await waitFor(() =>
      expect(screen.getByTestId('mcp-tool-count-github').textContent).toBe('5 tools'),
    );
    expect(filters.github).toEqual({ include: null, exclude: null });

    // None is an allow-list of nothing.
    fireEvent.click(screen.getByTestId('mcp-tools-none-github'));
    fireEvent.click(screen.getByTestId('mcp-tools-save-github'));
    await waitFor(() => expect(filters.github).toEqual({ include: [], exclude: null }));
  });

  it('keeps the page as it was on a hub that keeps no tests: no count, no automatic test', async () => {
    const { fetchImpl, sent } = hub({ legacy: true });
    mount(fetchImpl);
    await screen.findByTestId('mcp-row-github');
    fireEvent.click(screen.getByTestId('mcp-expand-github'));
    expect(screen.queryByTestId('mcp-tool-count-github')).toBeNull();
    expect(screen.queryByTestId('mcp-tools-github')).toBeNull();
    expect(tests(sent, 'github')).toHaveLength(0);
  });
});
