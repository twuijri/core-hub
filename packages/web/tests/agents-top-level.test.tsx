/**
 * «الوكلاء» is a main-sidebar entry above Tasks, and an agent's pages carry the agent's own list
 * in the sidebar (owner, 2026-09-24: «قراري اننا ندخل الايجنتات داخل الاعدادات كان خطا بالتصميم
 * — تطلع فوق Tasks في الصفحة الرئيسية»).
 *
 * The whole app is mounted on a scripted hub, so what is asserted is what a person meets: the
 * entry where it is, the card's chips as links, the agent's side list with only the pages its
 * adapter declares, the profile chip still at the top, a member kept out, and old URLs moved.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
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
const { agentSections } = await import('../src/agents/sections.js');

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
const CLAUDE = '01J8QK3ZR2W7M5N4P6T8V9X0CC';

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    vendor: null,
    kind: 'coding',
    adapter: 'acp',
    status: 'available',
    enabled: true,
    limited: false,
    capabilities: [],
    sections: [],
    default_model: null,
    runtime: { error: null },
    install: {
      source: 'managed',
      version: '1.0.0',
      error: null,
      update_available: false,
      latest_version: null,
    },
    ...(over as Record<string, unknown>),
  } as unknown as Agent;
}

const AGENTS = [
  agent(HERMES, 'Hermes', {
    kind: 'hermes',
    capabilities: ['streaming', 'tools', 'mcp', 'skills', 'memory', 'channels', 'jobs'],
  } as Partial<Agent>),
  agent(CLAUDE, 'Claude Code', {
    capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'skills', 'resume'],
  } as Partial<Agent>),
];

function hub() {
  return ((url: string) => {
    const path = new URL(String(url)).pathname;
    const json = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: AGENTS });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.includes('/memory')) return json({ items: [] });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function mount(path: string, role: 'owner' | 'admin' | 'member') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: '01J8QK3ZR2W7M5N4P6T8V9X0AA', username: 'u', display_name: 'U', role },
  });
  render(
    <App
      store={store}
      baseUrl="http://hub.test"
      fetchImpl={hub()}
      router={(children) => (
        <MemoryRouter initialEntries={[path]}>
          {children}
          <Where />
        </MemoryRouter>
      )}
    />,
  );
}

const where = () => screen.getByTestId('where').textContent;
const desktopSidebar = () => screen.getAllByRole('navigation', { name: 'Main menu' })[0]!;

describe('Agents: a main-sidebar entry above Tasks (owner, 2026-09-24)', () => {
  it('sits directly above Tasks in the rail, named «Agents», and opens the cards', async () => {
    mount('/chat', 'admin');
    const rail = await within(desktopSidebar()).findByTestId('rail');
    const ids = within(rail)
      .getAllByRole('link')
      .map((link) => link.getAttribute('data-nav-id'));
    expect(ids).toEqual(['new_chat', 'search', 'agent_manager', 'tasks', 'schedules']);
    const entry = within(rail).getByRole('link', { name: 'Agents' });
    expect(entry.getAttribute('href')).toBe('/agents');
    // And it is gone from Settings → Management.
    cleanup();
    mount('/settings', 'admin');
    const management = await screen.findAllByTestId('settings-management');
    expect(within(management[0]!).queryByText('Agents')).toBeNull();
  });

  it('a member sees no Agents entry, and the page itself sends them home', async () => {
    mount('/chat', 'member');
    const rail = await within(desktopSidebar()).findByTestId('rail');
    expect(within(rail).queryByRole('link', { name: 'Agents' })).toBeNull();
    cleanup();
    mount('/agents', 'member');
    await waitFor(() => expect(where()).toBe('/chat'));
    cleanup();
    mount(`/agents/${HERMES}/memory`, 'member');
    await waitFor(() => expect(where()).toBe('/chat'));
  });

  it('the rule is the one every admin-only page follows: a member is sent home from Users too', async () => {
    mount('/settings/users', 'member');
    await waitFor(() => expect(where()).toBe('/chat'));
  });

  it("the card's chips are links to the agent's pages; the capability tags are not", async () => {
    mount('/agents', 'owner');
    const cards = await screen.findAllByTestId('agent-card');
    const hermes = cards.find((card) => card.getAttribute('data-agent-slug') === 'hermes')!;
    const chips = within(within(hermes).getByTestId('agent-menu')).getAllByRole('link');
    expect(chips.map((chip) => chip.getAttribute('data-nav-id'))).toEqual([
      'agent_skills',
      'agent_mcp',
      'agent_memory',
      'agent_jobs',
      'agent_channels',
    ]);
    // A name that says whose page it is.
    const memory = within(hermes).getByRole('link', { name: 'Memory · Hermes' });
    expect(memory.getAttribute('href')).toBe(`/agents/${HERMES}/memory`);
    // The informational tags go nowhere.
    expect(within(within(hermes).getByTestId('agent-capabilities')).queryAllByRole('link')).toEqual(
      [],
    );
    // The Settings button opens the agent's Settings page directly.
    const claude = cards.find((card) => card.getAttribute('data-agent-slug') === 'claude-code')!;
    expect(within(claude).getByTestId('agent-settings-link').getAttribute('href')).toBe(
      `/agents/${CLAUDE}/settings`,
    );
  });
});

describe("inside an agent's pages the sidebar is the agent's list", () => {
  it('back to agents, the agent, then its declared pages in manifest order; the current one marked', async () => {
    mount(`/agents/${HERMES}/memory`, 'admin');
    const sidebar = desktopSidebar();
    const back = await within(sidebar).findByTestId('back-to-agents');
    expect(back.textContent).toBe('Back to agents');
    expect(back.getAttribute('href')).toBe('/agents');
    // The rail and the segment row step aside, as they do in Settings.
    expect(within(sidebar).queryByTestId('rail')).toBeNull();
    expect(within(sidebar).queryByTestId('segments')).toBeNull();
    const nav = await within(sidebar).findByTestId('agent-nav');
    expect(within(nav).getByTestId('agent-nav-head').textContent).toContain('Hermes');
    const rows = within(within(nav).getByTestId('agent-sections')).getAllByRole('link');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Skills',
      'MCP',
      'Memory',
      'Jobs',
      'Channels',
      'Settings',
    ]);
    expect(rows.find((row) => row.getAttribute('aria-current') === 'page')?.textContent).toBe(
      'Memory',
    );
    // The profile chip stays at the top: these pages edit one profile's tools.
    expect(screen.getByTestId('workspace-switcher')).toBeTruthy();
  });

  it('Claude Code shows Skills and MCP (plus Settings) and nothing else', async () => {
    mount(`/agents/${CLAUDE}/mcp`, 'admin');
    const nav = await within(desktopSidebar()).findByTestId('agent-nav');
    const rows = within(within(nav).getByTestId('agent-sections')).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('data-nav-id'))).toEqual([
      'agent_skills',
      'agent_mcp',
      'agent_settings',
    ]);
  });
});

describe('old URLs', () => {
  it('/settings/agents and every page under it move to /agents, the rest of the path kept', async () => {
    mount(`/settings/agents/${HERMES}/memory`, 'admin');
    await waitFor(() => expect(where()).toBe(`/agents/${HERMES}/memory`));
    cleanup();
    mount('/settings/agents', 'admin');
    await waitFor(() => expect(where()).toBe('/agents'));
  });
});

describe('agentSections (pure)', () => {
  it('follows the capabilities, adds Settings for an agent that is here, and hides all from members', () => {
    const ids = (a: Agent, role = 'admin') => agentSections(a, role).map((d) => d.id);
    expect(ids(AGENTS[1]!)).toEqual(['agent_skills', 'agent_mcp', 'agent_settings']);
    expect(
      ids(agent(CLAUDE, 'X', { capabilities: ['plugins', 'memory'] } as Partial<Agent>)),
    ).toEqual(['agent_memory', 'agent_plugins', 'agent_settings']);
    // Not installed: nothing to configure yet.
    expect(
      ids(
        agent(CLAUDE, 'X', { status: 'not_installed', capabilities: ['skills'] } as Partial<Agent>),
      ),
    ).toEqual(['agent_skills']);
    expect(ids(AGENTS[0]!, 'member')).toEqual([]);
  });
});
