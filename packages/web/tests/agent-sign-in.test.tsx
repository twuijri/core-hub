/**
 * An installed agent that keeps its own vendor account (Kimi Code, Grok Build) is signed in
 * from its Settings page by device code: the code and link its own sign-in printed, a wait
 * while the hub polls, then "signed in". Only an admin sees it, and only for such an agent.
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

const KIMI = '01J8QK3ZR2W7M5N4P6T8V9X0KM';
const CODEX = '01J8QK3ZR2W7M5N4P6T8V9X0CX';
const SIGN_IN = '01J8QK3ZR2W7M5N4P6T8V9X0SN';

function agent(id: string, name: string, install: Record<string, unknown>): Agent {
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
    status: 'available',
    enabled: true,
    limited: false,
    capabilities: [],
    sections: [],
    default_model: null,
    runtime: { state: 'not_applicable', url: null, error: null },
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
      ...install,
    },
  } as unknown as Agent;
}

const AGENTS = [agent(KIMI, 'Kimi Code', { sign_in: true }), agent(CODEX, 'Codex', {})];

const requests: string[] = [];

function hub() {
  let polls = 0;
  return ((url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const signIn = (status: string) => ({
      id: SIGN_IN,
      status,
      user_code: 'RL0S-YSZ9',
      verification_url: 'https://www.kimi.ai/code/authorize_device?user_code=RL0S-YSZ9',
      accepts_code: false,
      expires_at: '2026-09-26T13:25:00Z',
      error: null,
    });
    if (path.endsWith(`/agents/${KIMI}/sign-in`)) return json(signIn('pending'), 201);
    if (path.endsWith(`/agents/${KIMI}/sign-in/${SIGN_IN}`)) {
      polls += 1;
      return json(signIn(polls > 1 ? 'approved' : 'pending'));
    }
    if (path.endsWith('/agents')) return json({ items: AGENTS });
    if (path.endsWith('/settings')) return json({ sections: [] });
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
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
      router={(children) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>}
    />,
  );
}

describe("an agent's own account sign-in", () => {
  it('shows the code and link, polls, and says when it is signed in', async () => {
    requests.length = 0;
    mount(`/agents/${KIMI}/settings`, 'owner');
    fireEvent.click(await screen.findByTestId('agent-sign-in-start'));
    expect((await screen.findByTestId('agent-sign-in-code')).textContent).toBe('RL0S-YSZ9');
    expect(screen.getByTestId('agent-sign-in-link').getAttribute('href')).toBe(
      'https://www.kimi.ai/code/authorize_device?user_code=RL0S-YSZ9',
    );
    expect(
      (await screen.findByTestId('agent-sign-in-approved', {}, { timeout: 8000 })).textContent,
    ).toBe('Signed in. New conversations with Kimi Code use this account.');
    expect(requests).toContain(`POST /api/v1/agents/${KIMI}/sign-in`);
    expect(requests).toContain(`GET /api/v1/agents/${KIMI}/sign-in/${SIGN_IN}`);
  }, 15_000);

  it('is not offered for an agent without an account of its own, nor to a member', async () => {
    mount(`/agents/${CODEX}/settings`, 'owner');
    await screen.findByText(/Settings of Codex|Codex/);
    expect(screen.queryByTestId('agent-sign-in')).toBeNull();
    cleanup();
    // The Agents section is an admin's; a member never gets the card, wherever they land.
    requests.length = 0;
    mount(`/agents/${KIMI}/settings`, 'member');
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByTestId('agent-sign-in')).toBeNull();
    expect(requests).not.toContain(`POST /api/v1/agents/${KIMI}/sign-in`);
  });
});
