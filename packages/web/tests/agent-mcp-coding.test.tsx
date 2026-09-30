/**
 * The MCP page of a coding agent (2026-09-29). It showed "That is not allowed in the current
 * state." for Claude Code — in the server list and in the Core Hub tools card — and its note
 * said Hermes. Now the page lists the agent's own servers, names the agent and its file, keeps
 * Test (which asks Hermes) to Hermes's page, and for an agent whose file the hub does not edit
 * yet says so plainly instead of an error. The whole app is mounted on a scripted hub.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const IDS = {
  hermes: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
  'claude-code': '01J8QK3ZR2W7M5N4P6T8V9X0CC',
  codex: '01J8QK3ZR2W7M5N4P6T8V9X0CX',
} as const;
type Slug = keyof typeof IDS;

const agent = (slug: Slug, name: string, kind: string) =>
  ({
    id: IDS[slug],
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    slug,
    name,
    vendor: null,
    kind,
    adapter: kind,
    status: 'available',
    enabled: true,
    limited: false,
    capabilities: ['streaming', 'mcp', 'skills', 'config_files'],
    sections: [],
    default_model: null,
    runtime: { error: null },
    install: {
      source: kind === 'hermes' ? 'bundled' : 'managed',
      version: '0.16.2',
      error: null,
      update_available: false,
      latest_version: null,
    },
  }) as unknown as Agent;

const AGENTS = [
  agent('hermes', 'Hermes', 'hermes'),
  agent('claude-code', 'Claude Code', 'acp'),
  agent('codex', 'Codex CLI', 'acp'),
];

function hub() {
  const fetchImpl = ((input: string) => {
    const path = new URL(String(input)).pathname;
    const json = (value: unknown, code = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: code,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: AGENTS });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/hub-tools'))
      return json({
        enabled: true,
        available: true,
        unavailable_reason: null,
        server_name: 'corehub',
        url: 'http://127.0.0.1:8080/api/v1/hub-mcp',
        groups: [],
        recent_calls: [],
        updated_at: null,
      });
    if (path.endsWith(`/agents/${IDS.codex}/mcp-servers`))
      return json(
        {
          error: 'That is not allowed in the current state.',
          code: 'state_invalid',
          details: { agent_id: IDS.codex, reason: 'mcp_not_managed' },
        },
        409,
      );
    if (path.endsWith('/mcp-servers'))
      return json({
        items: [
          {
            name: 'github',
            transport: 'stdio',
            enabled: true,
            connected: false,
            tools: [],
            error: null,
            config: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: '[stored]' } },
            updated_at: '2026-09-29T08:00:00Z',
          },
        ],
      });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

function mount(slug: Slug) {
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
      fetchImpl={hub()}
      router={(children) => (
        <MemoryRouter initialEntries={[`/agents/${IDS[slug]}/mcp`]}>{children}</MemoryRouter>
      )}
    />,
  );
}

const NOT_ALLOWED = 'That is not allowed in the current state.';

describe("a coding agent's MCP page", () => {
  it("lists Claude Code's own servers and says where they live, with no Hermes in it", async () => {
    mount('claude-code');
    await screen.findByTestId('mcp-row-github');
    const note = screen.getByTestId('mcp-note').textContent ?? '';
    expect(note).toContain('Claude Code');
    expect(note).toContain('~/.claude.json');
    expect(note).not.toContain('Hermes');
    // Test and sign-in ask Hermes: not on a coding agent's row.
    expect(screen.queryByTestId('mcp-test-github')).toBeNull();
    // The Core Hub tools card answers, says it is the profile's, and offers no Hermes test.
    await screen.findByTestId('hub-tools-shared');
    expect(screen.queryByTestId('hub-tools-test')).toBeNull();
    expect(document.body.textContent).not.toContain(NOT_ALLOWED);
  });

  it('says plainly when Core Hub does not edit the agent’s servers yet', async () => {
    mount('codex');
    const notice = await screen.findByTestId('mcp-not-managed');
    expect(notice.textContent).toContain('Codex CLI');
    expect(notice.textContent).toContain('Config files');
    expect(screen.queryByTestId('new-mcp')).toBeNull();
    await waitFor(() => expect(document.body.textContent).not.toContain(NOT_ALLOWED));
  });

  it("keeps Hermes's page as it was: its restart note and Test", async () => {
    mount('hermes');
    await screen.findByTestId('mcp-row-github');
    expect(screen.getByTestId('mcp-note').textContent).toContain('Hermes');
    expect(screen.getByTestId('mcp-test-github')).toBeTruthy();
  });
});
