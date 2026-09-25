/**
 * The «أدوات كور هب» / "Core Hub tools" card on an agent's MCP page (contract decision §47):
 * the groups with what each does, the switches (the whole thing, each group, each group's
 * changes), the last calls in the hub's words, and Test — which asks Hermes to connect to the
 * block the hub wrote, like any server row. The block itself is not a row to edit.
 *
 * The whole app is mounted on a scripted hub, so what is asserted is what a person meets and
 * what the page asks the hub.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const GROUPS = [
  ['tasks', ['tasks.list:read', 'tasks.create:write']],
  ['schedules', ['schedules.list:read', 'schedules.pause:write']],
  ['conversations', ['conversations.list:read']],
  ['notifications', ['notifications.notify:write']],
  ['workflows', ['workflows.list:read', 'workflows.run:write']],
  ['files', ['files.read:read', 'files.write:write']],
] as const;

function settings(enabled: boolean, writes: string[] = []) {
  return {
    enabled,
    available: true,
    unavailable_reason: null,
    server_name: 'corehub',
    url: 'http://127.0.0.1:8080/api/v1/hub-mcp',
    groups: GROUPS.map(([id, tools]) => ({
      id,
      enabled: true,
      allow_writes: writes.includes(id),
      tools: tools.map((entry) => {
        const [name, access] = entry.split(':');
        return { name, access };
      }),
    })),
    recent_calls: enabled
      ? [
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0C2',
            tool: 'tasks.list',
            ok: false,
            error_code: 'hub_tools_no_live_run',
            user_id: null,
            session_id: null,
            duration_ms: 3,
            created_at: '2026-09-25T08:01:00Z',
          },
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0C1',
            tool: 'tasks.create',
            ok: true,
            error_code: null,
            user_id: '01J8QK3ZR2W7M5N4P6T8V9X0AA',
            session_id: '01J8QK3ZR2W7M5N4P6T8V9X0S1',
            duration_ms: 40,
            created_at: '2026-09-25T08:00:00Z',
          },
        ]
      : [],
    updated_at: null,
  };
}

function hub() {
  const sent: Sent[] = [];
  let current = settings(false);
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ url: `${path}${url.search}`, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: [AGENT] });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/hub-tools') && method === 'GET') return json(current);
    if (path.endsWith('/hub-tools') && method === 'PATCH') {
      const groups = (body?.groups as Array<{ id: string; allow_writes?: boolean }>) ?? [];
      current = settings(
        (body?.enabled as boolean | undefined) ?? current.enabled,
        groups.filter((g) => g.allow_writes).map((g) => g.id),
      );
      return json(current);
    }
    if (path.endsWith('/mcp-servers/corehub/test')) {
      return json({
        ok: true,
        tools: [{ name: 'tasks.list', description: 'List tasks' }],
        error: null,
        duration_ms: 900,
      });
    }
    if (path.endsWith('/mcp-servers')) {
      return json({
        items: [
          {
            name: 'corehub',
            transport: 'http',
            enabled: true,
            connected: false,
            tools: [],
            error: null,
            config: { url: 'http://127.0.0.1:8080/api/v1/hub-mcp' },
            updated_at: '2026-09-25T08:00:00Z',
          },
          {
            name: 'github',
            transport: 'http',
            enabled: true,
            connected: false,
            tools: [],
            error: null,
            config: { url: 'https://mcp.example/github' },
            updated_at: '2026-09-25T08:00:00Z',
          },
        ],
      });
    }
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(path: string, fetchImpl: typeof fetch) {
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
      router={(children) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>}
    />,
  );
}

describe('the Core Hub tools card', () => {
  it('lists every group with what it does, off until switched on, and hides its block from the list', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/mcp`, fetchImpl);
    const card = await screen.findByTestId('hub-tools');
    expect(within(card).getByText('Core Hub tools')).toBeTruthy();
    await within(card).findByTestId('hub-group-tasks');
    for (const [id] of GROUPS) expect(within(card).getByTestId(`hub-group-${id}`)).toBeTruthy();
    expect(within(card).getByText(/List the board's tasks/)).toBeTruthy();
    expect(screen.getByTestId('hub-tools-acts-as').textContent).toContain('never as an admin');
    // Off: nothing to test, the groups wait.
    expect((screen.getByTestId('hub-tools-test') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hub-group-toggle-tasks').hasAttribute('disabled')).toBe(true);
    // The block the hub writes is the card's, not a row of the list.
    const list = await screen.findByTestId('mcp-list');
    expect(within(list).queryByText('corehub')).toBeNull();
    expect(within(list).getByText('github')).toBeTruthy();
  });

  it('switches it on, lets a group change things, shows the calls and tests with Hermes', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/mcp`, fetchImpl);
    fireEvent.click(await screen.findByTestId('hub-tools-toggle'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH' && s.url.endsWith('/hub-tools'))?.body).toEqual({
        enabled: true,
      }),
    );
    const calls = await screen.findAllByTestId('hub-tools-call');
    expect(calls.map((c) => c.getAttribute('data-ok'))).toEqual(['false', 'true']);
    expect(calls[0]!.textContent).toContain('nobody to act for');

    fireEvent.click(screen.getByTestId('hub-group-writes-tasks'));
    await waitFor(() =>
      expect(
        sent.filter((s) => s.method === 'PATCH' && s.url.endsWith('/hub-tools')).at(-1)?.body,
      ).toEqual({ groups: [{ id: 'tasks', allow_writes: true }] }),
    );
    // Conversations only read: there is no changes switch to offer.
    expect(screen.queryByTestId('hub-group-writes-conversations')).toBeNull();

    fireEvent.click(screen.getByTestId('hub-tools-test'));
    const result = await screen.findByTestId('mcp-test-result-corehub');
    expect(result.getAttribute('data-ok')).toBe('true');
    expect(
      sent.some((s) => s.method === 'POST' && s.url.endsWith('/mcp-servers/corehub/test')),
    ).toBe(true);
  });
});
