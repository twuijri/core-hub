/**
 * The Presets card on an agent's Settings page (contract decision §100): save the current
 * settings under a name, list them with what each holds, activate one (after a confirmation,
 * with what could not be applied said), and delete one.
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
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

const PRESET = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0PR',
  profile: 'default',
  owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0AA',
  agent_id: HERMES,
  name: 'Quick',
  description: null,
  content: {
    model: null,
    skills: { 'notes-helper': true, research: false },
    mcp_servers: null,
    settings: { agent: { max_turns: 20 } },
  },
  last_activated_at: null,
  created_at: '2026-09-27T01:00:00Z',
  updated_at: '2026-09-27T01:00:00Z',
};

function hub() {
  const sent: Sent[] = [];
  let presets: Array<typeof PRESET> = [PRESET];
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ path, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
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
    if (path.endsWith('/settings') && method === 'GET') {
      return json({
        sections: [
          {
            key: 'agent',
            title: { ar: 'وقت التشغيل', en: 'Agent runtime' },
            restart_required: false,
            fields: [
              {
                key: 'max_turns',
                label: { ar: 'الدورات', en: 'Max turns' },
                kind: 'integer',
                value: 60,
                options: [],
                min: 0,
                max: 1000,
                hint: null,
              },
            ],
          },
        ],
      });
    }
    if (path.endsWith('/activate') && method === 'POST') {
      return json({
        preset: { ...PRESET, last_activated_at: '2026-09-27T01:10:00Z' },
        applied: ['settings'],
        skipped: [{ part: 'skills', key: 'research', code: 'not_found' }],
        restart_job_ids: [],
      });
    }
    if (path.endsWith('/presets') && method === 'POST') {
      const made = { ...PRESET, id: '01J8QK3ZR2W7M5N4P6T8V9X0PS', name: String(body?.name) };
      presets = [made, ...presets];
      return json(made, 201);
    }
    if (path.endsWith('/presets')) return json({ items: presets });
    if (path.includes('/presets/') && method === 'DELETE') {
      presets = presets.filter((p) => !path.endsWith(p.id));
      return json(null, 204);
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

describe('the Presets card', () => {
  it('lists what each preset holds, saves the current settings under a name, and deletes one', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    const card = await screen.findByTestId('presets');
    const row = await within(card).findByTestId('preset-row');
    expect(row.textContent).toContain('Quick');
    expect(row.textContent).toMatch(/2/);

    fireEvent.change(within(card).getByTestId('preset-name'), { target: { value: 'Night' } });
    fireEvent.click(within(card).getByTestId('preset-save'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'POST' && s.path.endsWith('/presets'))?.body).toEqual({
        name: 'Night',
      }),
    );
    await waitFor(() => expect(within(card).getAllByTestId('preset-row')).toHaveLength(2));

    fireEvent.click(within(card).getAllByTestId('preset-delete')[1]!);
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /Delete|حذف/ }));
    await waitFor(() =>
      expect(
        sent.some((s) => s.method === 'DELETE' && s.path.endsWith(`/presets/${PRESET.id}`)),
      ).toBe(true),
    );
  });

  it('activates after a confirmation and says what it could not apply', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    const card = await screen.findByTestId('presets');
    fireEvent.click(await within(card).findByTestId('preset-activate'));
    expect(sent.some((s) => s.path.endsWith('/activate'))).toBe(false);
    const confirm = await screen.findByRole('alertdialog');
    const buttons = within(confirm).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]!);
    const outcome = await within(card).findByTestId('preset-outcome');
    expect(outcome.textContent).toContain('research');
    expect(
      sent.some((s) => s.method === 'POST' && s.path.endsWith(`/presets/${PRESET.id}/activate`)),
    ).toBe(true);
  });
});
