/**
 * Core Hub's own skill library on the Skills page (decision §60): its card says how many of its
 * skills the profile has and switches it off (after asking) or on; its skills carry the «Core Hub
 * library» badge; an edited one says so and offers Restore, which asks first; a profile the hub
 * never installed it in offers Install.
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
  capabilities: ['streaming', 'skills'],
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
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

function librarySkill(key: string, library: 'current' | 'edited') {
  return {
    key,
    name: key,
    description: `${key} skill`,
    enabled: true,
    pinned: false,
    source: 'library',
    use_count: 0,
    updated_at: null,
    content: null,
    library,
  };
}

function hub(start: { enabled: boolean; installed: number }) {
  const sent: Sent[] = [];
  let state = { ...start, available: 12 };
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ path, method, body });
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
    const summary = () => ({ ...state, edited: state.installed > 0 ? 1 : 0 });
    if (path.endsWith('/skill-library') && method === 'PATCH') {
      state = { ...state, enabled: body?.enabled === true, installed: body?.enabled ? 12 : 0 };
      return json(summary());
    }
    if (path.endsWith('/restore') && method === 'POST') {
      return json(librarySkill('summarize', 'current'));
    }
    if (path.endsWith('/skills') && method === 'GET') {
      return json({
        home: '/data/hermes/skills',
        library: summary(),
        categories:
          state.installed > 0
            ? [
                {
                  key: 'core-hub',
                  name: 'core-hub',
                  description: 'Core Hub skills.',
                  skills: [
                    librarySkill('image-generate', 'current'),
                    librarySkill('summarize', 'edited'),
                  ],
                },
              ]
            : [],
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

describe('the Core Hub library on the Skills page', () => {
  it('names its category, badges its skills, and marks the edited one with Restore', async () => {
    const { fetchImpl, sent } = hub({ enabled: true, installed: 12 });
    mount(`/agents/${HERMES}/skills`, fetchImpl);
    const category = await screen.findByTestId('skill-category');
    expect(category.getAttribute('data-category')).toBe('core-hub');
    expect(within(category).getByRole('heading', { name: 'Core Hub library' })).toBeTruthy();
    const card = screen.getByTestId('skill-library');
    expect(card.textContent).toContain('12 of 12 skills in this profile');
    expect(card.textContent).toContain('1 edited');
    expect(screen.getByTestId('skill-library-image-generate').textContent).toBe('Core Hub library');
    // Only the edited one offers Restore; both can still be deleted (they are the person's to adapt).
    expect(screen.queryByTestId('skill-restore-image-generate')).toBeNull();
    const rows = screen.getAllByTestId('skill-row');
    expect(rows.map((row) => row.getAttribute('data-library'))).toEqual(['current', 'edited']);
    expect(screen.getByTestId('skill-delete-image-generate')).toBeTruthy();

    fireEvent.click(screen.getByTestId('skill-restore-summarize'));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('Restore summarize?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(
        sent.some((r) => r.method === 'POST' && r.path.endsWith('/skills/summarize/restore')),
      ).toBe(true),
    );
  });

  it('asks before switching the library off, then sends it', async () => {
    const { fetchImpl, sent } = hub({ enabled: true, installed: 12 });
    mount(`/agents/${HERMES}/skills`, fetchImpl);
    const toggle = await screen.findByTestId('skill-library-toggle');
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('except the ones you edited');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ enabled: false }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('skill-library').textContent).toContain('Off in this profile'),
    );
  });

  it('offers Install where the library is on but not installed yet', async () => {
    const { fetchImpl, sent } = hub({ enabled: true, installed: 0 });
    mount(`/agents/${HERMES}/skills`, fetchImpl);
    fireEvent.click(await screen.findByTestId('skill-library-install'));
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByTestId('skill-library-image-generate')).toBeTruthy();
  });
});
