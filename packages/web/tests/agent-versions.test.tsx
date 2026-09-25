/**
 * The update policy on the Agents page (proposed, 2026-09-25): the catalog's pin is the
 * version Core Hub was tested with; the hub may install a newer release, and says so —
 * «أحدث من النسخة المختبرة» — on the card and on the agent's Settings page. And the three
 * agents added to the catalog that day wear their own marks.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';
import { versionNotes } from '../src/agents/versionNotes.js';
import { agentMark } from '../src/ui/brand/marks.js';

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

const QWEN = '01J8QK3ZR2W7M5N4P6T8V9X0QW';
const PI = '01J8QK3ZR2W7M5N4P6T8V9X0PI';
const KIMI = '01J8QK3ZR2W7M5N4P6T8V9X0KM';

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
  // An update past the tested pin is on offer.
  agent(QWEN, 'Qwen Code', {
    install: {
      source: 'managed',
      version: '0.24.5',
      error: null,
      update_available: true,
      latest_version: '0.25.0',
      pinned_version: '0.24.5',
      newer_than_tested: false,
      auto_update: false,
      auto_update_supported: true,
    },
  } as Partial<Agent>),
  // Already updated past the pin.
  agent(PI, 'Pi', {
    install: {
      source: 'managed',
      version: '0.88.0',
      error: null,
      update_available: false,
      latest_version: '0.88.0',
      pinned_version: '0.87.1',
      newer_than_tested: true,
      auto_update: true,
      auto_update_supported: true,
    },
  } as Partial<Agent>),
  // At the pin, nothing to say.
  agent(KIMI, 'Kimi Code', {
    install: {
      source: 'managed',
      version: '2.1.1',
      error: null,
      update_available: false,
      latest_version: '2.1.1',
      pinned_version: '2.1.1',
      newer_than_tested: false,
      auto_update: false,
      auto_update_supported: true,
    },
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
    if (path.endsWith('/settings')) return json({ sections: [] });
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

describe('version notes (pure)', () => {
  const install = (over: Partial<Agent['install']>) =>
    ({
      version: '1.0.0',
      latest_version: '1.0.0',
      update_available: false,
      pinned_version: '1.0.0',
      newer_than_tested: false,
      ...over,
    }) as Agent['install'];

  it('says nothing at the tested pin', () => {
    expect(versionNotes(install({}))).toEqual({
      update: null,
      updateUntested: false,
      newerThanTested: false,
      tested: '1.0.0',
    });
  });

  it('marks an update past the pin, and an installed version past it', () => {
    expect(
      versionNotes(install({ update_available: true, latest_version: '1.1.0' })),
    ).toMatchObject({ update: '1.1.0', updateUntested: true });
    expect(versionNotes(install({ version: '1.1.0', newer_than_tested: true }))).toMatchObject({
      update: null,
      newerThanTested: true,
    });
  });

  it('an update back up to the pin is not "untested"', () => {
    expect(
      versionNotes(install({ version: '0.9.0', update_available: true, latest_version: '1.0.0' })),
    ).toMatchObject({ update: '1.0.0', updateUntested: false });
  });

  it('an agent the hub does not install has no tested version', () => {
    expect(versionNotes(install({ pinned_version: null })).tested).toBeNull();
  });
});

describe('the Agents page says when a version is newer than the tested one', () => {
  it('on the cards', async () => {
    mount('/agents', 'owner');
    const cards = await screen.findAllByTestId('agent-card');
    const card = (slug: string) => cards.find((c) => c.getAttribute('data-agent-slug') === slug)!;
    expect(within(card('qwen-code')).getByTestId('agent-update-available').textContent).toBe(
      'Update available: 0.25.0 — newer than the tested version',
    );
    expect(within(card('qwen-code')).queryByTestId('agent-newer-than-tested')).toBeNull();
    expect(within(card('pi')).getByTestId('agent-newer-than-tested').textContent).toBe(
      'Newer than the tested version',
    );
    expect(within(card('kimi-code')).queryByTestId('agent-update-available')).toBeNull();
    expect(within(card('kimi-code')).queryByTestId('agent-newer-than-tested')).toBeNull();
  });

  it("on the agent's Settings page, with the tested version named", async () => {
    mount(`/agents/${PI}/settings`, 'owner');
    expect((await screen.findByTestId('agent-version-tested')).textContent).toBe(
      'Tested version: 0.87.1',
    );
    expect(screen.getByTestId('agent-newer-than-tested').textContent).toContain('0.87.1');
    expect(screen.getByText(/installs it only while the agent is idle/)).toBeTruthy();
  });
});

describe("the new agents' marks", () => {
  it('Qwen Code, Kimi Code and Pi each wear their own', () => {
    for (const slug of ['qwen-code', 'kimi-code', 'pi'])
      expect(agentMark(slug), slug).not.toBeNull();
  });
});
