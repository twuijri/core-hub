/**
 * The last two agent pages, and Hermes's own skills on the Skills page.
 *
 * - Jobs: the agent's schedules in the selected profile — for Hermes, the jobs in its own
 *   scheduler — read from the same list as the Schedules page, narrowed to one agent and one
 *   profile, with run / pause / delete and a way to the Schedules page.
 * - Plugins: what Hermes lists in the profile, in Hermes's words; switch, install (a job),
 *   remove only what was installed.
 * - Skills: skills in Hermes's category folders are listed under their category, and Hermes's
 *   own (`builtin`) offer no switch and no delete.
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
const JOB = '01J8QK3ZR2W7M5N4P6T8V9X0SC';
const LOCAL = '01J8QK3ZR2W7M5N4P6T8V9X0SD';

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
  capabilities: ['streaming', 'skills', 'memory', 'jobs', 'plugins'],
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

function schedule(id: string, name: string, hermes: boolean) {
  return {
    id,
    profile: 'default',
    name,
    enabled: true,
    state: 'scheduled',
    next_run_at: '2026-09-25T06:00:00Z',
    last_run_at: null,
    last_status: null,
    last_error: null,
    trigger: {
      kind: 'cron',
      expression: '0 9 * * *',
      every_minutes: null,
      run_at: null,
      timezone: 'Asia/Riyadh',
    },
    target: { kind: 'agent_prompt', agent_id: HERMES, prompt: 'لخّص أخبار الصباح' },
    external: hermes ? { source: 'hermes', id: 'abc123' } : null,
  };
}

function plugin(key: string, source: string, status: string, removable = false) {
  return {
    key,
    name: key,
    kind: source === 'bundled' ? 'bundled' : 'standalone',
    source,
    status,
    version: '1.0.0',
    description: `${key} plugin`,
    author: null,
    configured: true,
    enabled: status === 'enabled',
    manageable: true,
    removable,
    provides_tools: [],
    provides_hooks: [],
    requires_env: [],
    entries: [],
  };
}

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  profile: string | null;
}

function hub(options: { pluginsRefused?: boolean } = {}) {
  const sent: Sent[] = [];
  let installed = false;
  const fetchImpl = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({
      url: `${path}${url.search}`,
      method,
      body,
      profile: new Headers(init.headers).get('X-Hub-Profile'),
    });
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
    if (path.endsWith('/meta')) return json({ name: 'Majlis', server_version: '0.0.0' });
    if (path.endsWith('/schedules') && method === 'GET') {
      return json({
        items: [schedule(JOB, 'موجز الصباح', true), schedule(LOCAL, 'Local', false)],
        next_cursor: null,
      });
    }
    if (path.includes('/schedules/'))
      return json(
        method === 'DELETE' ? null : schedule(JOB, 'موجز الصباح', true),
        method === 'DELETE' ? 204 : 200,
      );
    if (path.endsWith('/plugins') && method === 'GET') {
      if (options.pluginsRefused) {
        return json(
          {
            error: 'state_invalid',
            code: 'state_invalid',
            details: { reason: 'hermes_not_supervised' },
          },
          409,
        );
      }
      return json({
        items: [
          plugin('kanban', 'bundled', 'not_enabled'),
          plugin('disk-cleanup', 'bundled', 'disabled'),
          ...(installed ? [plugin('chrome-profiles', 'user', 'not_enabled', true)] : []),
        ],
        warnings: [],
      });
    }
    if (path.endsWith('/plugins') && method === 'POST') {
      installed = true;
      return json({ job_id: '01J8QK3ZR2W7M5N4P6T8V9X0JH' }, 202);
    }
    if (path.includes('/plugins/') && method === 'PATCH') {
      return json(plugin('kanban', 'bundled', body?.enabled ? 'enabled' : 'disabled'));
    }
    if (path.includes('/plugins/') && method === 'DELETE') return json(null, 204);
    if (path.includes('/jobs/')) {
      return json({
        id: '01J8QK3ZR2W7M5N4P6T8V9X0JH',
        profile: 'default',
        owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
        created_at: '2026-09-24T00:00:00Z',
        updated_at: '2026-09-24T00:00:05Z',
        kind: 'plugin_install',
        status: 'succeeded',
        progress: { percent: null, message: null },
        resource: { kind: 'agent', id: HERMES },
        result: { name: 'chrome-profiles', identifier: 'chrome-profiles' },
        error: null,
        started_at: '2026-09-24T00:00:00Z',
        finished_at: '2026-09-24T00:00:05Z',
      });
    }
    if (path.endsWith('/skills') && method === 'GET') {
      return json({
        home: '/data/hermes/skills',
        categories: [
          {
            key: 'user',
            name: 'user',
            description: null,
            skills: [
              {
                key: 'my-notes',
                name: 'my-notes',
                description: 'Mine',
                enabled: true,
                pinned: false,
                source: 'user',
                use_count: 0,
                updated_at: null,
                content: null,
              },
            ],
          },
          {
            key: 'apple',
            name: 'apple',
            description: 'Apple / macOS skills.',
            skills: [
              {
                key: 'findmy',
                name: 'findmy',
                description: 'Find a device',
                enabled: true,
                pinned: false,
                source: 'builtin',
                use_count: 0,
                updated_at: null,
                content: null,
              },
            ],
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

describe("an agent's Jobs page", () => {
  it("lists the agent's jobs in this profile only, from the Schedules list, and links there", async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/jobs`, fetchImpl);
    const rows = await screen.findAllByTestId('agent-job');
    expect(rows.map((row) => row.getAttribute('data-job'))).toEqual(['موجز الصباح', 'Local']);
    const asked = sent.find(
      (call) => call.method === 'GET' && call.url.startsWith('/api/v1/schedules'),
    );
    expect(asked?.url).toContain('profile=default');
    expect(asked?.url).toContain(`agent_id=${HERMES}`);
    expect(screen.getByTestId('agent-jobs-schedules').getAttribute('href')).toBe('/schedules');
    // The side list now offers Jobs and Plugins for Hermes.
    const nav = screen.getAllByTestId('agent-sections')[0]!;
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('data-nav-id')),
    ).toEqual(['agent_skills', 'agent_memory', 'agent_jobs', 'agent_plugins', 'agent_settings']);
  });

  it("runs a Hermes job now in its own profile, pauses it, and cannot run one Hermes doesn't hold", async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/jobs`, fetchImpl);
    const run = await screen.findByTestId(`agent-job-run-${JOB}`);
    fireEvent.click(run);
    await screen.findByTestId('agent-jobs-fired');
    const fired = sent.find(
      (call) => call.method === 'POST' && call.url.endsWith(`/schedules/${JOB}/run`),
    );
    expect(fired?.profile).toBe('default');
    expect((screen.getByTestId(`agent-job-run-${LOCAL}`) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId(`agent-job-enabled-${JOB}`));
    await waitFor(() =>
      expect(
        sent.find((call) => call.method === 'PATCH' && call.url.endsWith(`/schedules/${JOB}`))
          ?.body,
      ).toEqual({ enabled: false }),
    );
  });
});

describe("an agent's Plugins page", () => {
  it("shows Hermes's plugins with Hermes's status, and switches one on", async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/plugins`, fetchImpl);
    const rows = await screen.findAllByTestId('agent-plugin');
    expect(
      rows.map((row) => [row.getAttribute('data-plugin'), row.getAttribute('data-status')]),
    ).toEqual([
      ['kanban', 'not_enabled'],
      ['disk-cleanup', 'disabled'],
    ]);
    expect(within(rows[0]!).getByText('Not enabled')).toBeTruthy();
    expect(within(rows[0]!).getByText('Ships with Hermes')).toBeTruthy();
    // Nothing Hermes ships can be removed.
    expect(screen.queryByTestId('agent-plugin-remove-kanban')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-plugin-toggle-kanban'));
    await waitFor(() =>
      expect(
        sent.find((call) => call.method === 'PATCH' && call.url.endsWith('/plugins/kanban'))?.body,
      ).toEqual({ enabled: true }),
    );
  });

  it('installs as a job and then offers to remove what was installed', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/plugins`, fetchImpl);
    await screen.findAllByTestId('agent-plugin');
    fireEvent.change(screen.getByTestId('agent-plugin-identifier'), {
      target: { value: 'chrome-profiles' },
    });
    fireEvent.click(screen.getByTestId('agent-plugin-install'));
    const result = await screen.findByTestId('agent-plugin-install-result');
    expect(result.getAttribute('data-ok')).toBe('true');
    expect(result.textContent).toContain('chrome-profiles');
    expect(
      sent.find((call) => call.method === 'POST' && call.url.endsWith(`/agents/${HERMES}/plugins`))
        ?.body,
    ).toEqual({ identifier: 'chrome-profiles' });
    await screen.findByTestId('agent-plugin-remove-chrome-profiles');
  });

  it('refuses an identifier that reads as an option before asking the hub', async () => {
    const { fetchImpl, sent } = hub();
    mount(`/agents/${HERMES}/plugins`, fetchImpl);
    await screen.findAllByTestId('agent-plugin');
    fireEvent.change(screen.getByTestId('agent-plugin-identifier'), {
      target: { value: '--allow-removed' },
    });
    expect((screen.getByTestId('agent-plugin-install') as HTMLButtonElement).disabled).toBe(true);
    expect(sent.some((call) => call.method === 'POST')).toBe(false);
  });

  it('says plainly when the hub does not run Hermes itself', async () => {
    const { fetchImpl } = hub({ pluginsRefused: true });
    mount(`/agents/${HERMES}/plugins`, fetchImpl);
    const error = await screen.findByTestId('agent-plugins-error');
    expect(error.textContent).toBe(
      'This hub does not run Hermes itself, so it cannot ask Hermes to do this.',
    );
  });
});

describe("Hermes's own skills on the Skills page", () => {
  it('lists them under their category with its description, without a switch or a delete', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/skills`, fetchImpl);
    const categories = await screen.findAllByTestId('skill-category');
    expect(categories.map((section) => section.getAttribute('data-category'))).toEqual([
      'user',
      'apple',
    ]);
    expect(within(categories[1]!).getByText('Apple / macOS skills.')).toBeTruthy();
    const findmy = within(categories[1]!).getByTestId('skill-row');
    expect(findmy.getAttribute('data-source')).toBe('builtin');
    expect(within(findmy).getByText('Built into Hermes')).toBeTruthy();
    expect(screen.queryByTestId('skill-delete-findmy')).toBeNull();
    expect((within(findmy).getByTestId('skill-toggle-findmy') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // The person's own skill keeps both.
    expect(screen.getByTestId('skill-delete-my-notes')).toBeTruthy();
  });
});
