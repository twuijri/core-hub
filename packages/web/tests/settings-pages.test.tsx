// The last four settings pages whose module already answers: Knowledge, Plugins, Updates
// and About. What is worth testing in each is the sentence it tells the truth with.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { AboutTab } from '../src/settings/AboutTab.js';
import { KnowledgeTab } from '../src/settings/KnowledgeTab.js';
import { PluginsTab } from '../src/settings/PluginsTab.js';
import { UpdatesTab } from '../src/settings/UpdatesTab.js';

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

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

interface State {
  knowledge?: unknown[];
  plugins?: unknown[];
  releases?: unknown[];
  updateSettings?: unknown;
  meta?: unknown;
}

function hub(state: State = {}) {
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push({ url: String(url), method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/knowledge/items')) {
      const q = parsed.searchParams.get('q');
      const items = (state.knowledge ?? []) as Array<{ title: string }>;
      return json({
        items: q ? items.filter((i) => i.title?.includes(q)) : items,
        next_cursor: null,
      });
    }
    if (path.endsWith('/plugins')) return json({ items: state.plugins ?? [] });
    if (path.endsWith('/updates/releases')) return json({ items: state.releases ?? [] });
    if (path.endsWith('/updates/settings'))
      return json(
        state.updateSettings ?? {
          default_channel: 'stable',
          source: { kind: 'manual', repo: null, token: null },
          auto_publish: false,
        },
      );
    if (path.endsWith('/meta'))
      return json(
        state.meta ?? {
          name: 'Core Hub',
          server_version: '0.1.0-alpha.6',
          contract_version: '1.0.0',
          api_versions: ['v1'],
          realtime_namespaces: ['/rt/sessions', '/rt/jobs'],
          locales: ['ar', 'en'],
          setup_required: false,
        },
      );
    return json({ error: { code: 'not_found', message: path } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(node: React.ReactElement, fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>{node}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: '01J8QK3ZR2W7M5N4P6T8V9X0KN',
  kind: 'journal',
  title: 'Sunday',
  content: 'We finished the contract.',
  date: '2026-09-21',
  mood: 'good',
  tags: ['work'],
  attachment_ids: [],
  created_at: '2026-09-21T20:00:00Z',
  ...over,
});

afterEach(cleanup);

describe('Knowledge', () => {
  it('tells an empty workspace apart from a search that found nothing', async () => {
    // Two different answers. Saying the wrong one sends the person looking for a bug.
    const { fetchImpl } = hub({ knowledge: [entry()] });
    mount(<KnowledgeTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('knowledge-list')).toBeTruthy());
    await userEvent.type(screen.getByTestId('knowledge-search'), 'zzz');
    await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy());
    expect(screen.queryByText('Nothing yet')).toBeNull();
  });

  it('says nothing yet when the workspace is genuinely empty', async () => {
    const { fetchImpl } = hub({ knowledge: [] });
    mount(<KnowledgeTab />, fetchImpl);
    await waitFor(() => expect(screen.getByText('Nothing yet')).toBeTruthy());
  });

  it('shows the three kinds in one list, each saying which it is', async () => {
    const { fetchImpl } = hub({
      knowledge: [
        entry(),
        entry({ id: 'b', kind: 'note', title: 'A note' }),
        entry({ id: 'c', kind: 'file', title: 'plan.pdf', content: null }),
      ],
    });
    mount(<KnowledgeTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('knowledge-list')).toBeTruthy());
    const rows = screen.getByTestId('knowledge-list').querySelectorAll('li');
    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => row.getAttribute('data-kind'))).toEqual([
      'journal',
      'note',
      'file',
    ]);
  });
});

describe('Plugins', () => {
  it('says the hub has no installer rather than showing a shop', async () => {
    const { fetchImpl } = hub({ plugins: [] });
    mount(<PluginsTab />, fetchImpl);
    await waitFor(() => expect(screen.getByText('No plugins')).toBeTruthy());
    expect(screen.getByText(/no installer yet/)).toBeTruthy();
    expect(screen.queryByTestId('plugin-table')).toBeNull();
  });
});

describe('Updates', () => {
  it('says up front that this is not about the web client', async () => {
    // "Updates" that does not update the page you are on is exactly what gets misread.
    const { fetchImpl } = hub();
    mount(<UpdatesTab />, fetchImpl);
    await waitFor(() => expect(screen.getByText(/served by the hub/)).toBeTruthy());
  });

  it('hides the source fields until the hub is told to fetch from one', async () => {
    const { fetchImpl } = hub();
    mount(<UpdatesTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('updates-from-source')).toBeTruthy());
    expect(screen.queryByTestId('updates-source-fields')).toBeNull();
  });

  it('shows the repository and says a stored token is stored, never its value', async () => {
    const { fetchImpl } = hub({
      updateSettings: {
        default_channel: 'test',
        source: { kind: 'github_release', repo: 'twuijri/core-hub', token: '[stored]' },
        auto_publish: true,
      },
    });
    mount(<UpdatesTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('updates-source-fields')).toBeTruthy());
    expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe('twuijri/core-hub');
    expect(screen.getByText(/Stored\./)).toBeTruthy();
    // The field itself is empty: the hub's `[stored]` is a fact, not a value to echo.
    expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
  });

  it('says an empty shelf is empty and why, not that something failed', async () => {
    const { fetchImpl } = hub({ releases: [] });
    mount(<UpdatesTab />, fetchImpl);
    await waitFor(() => expect(screen.getByText('No releases')).toBeTruthy());
    expect(screen.queryByTestId('release-table')).toBeNull();
  });
});

describe('About', () => {
  it('shows the server build and the contract version as two different things', async () => {
    const { fetchImpl } = hub();
    mount(<AboutTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('about-facts')).toBeTruthy());
    expect(screen.getByTestId('about-server').textContent).toBe('0.1.0-alpha.6');
    expect(screen.getByTestId('about-contract').textContent).toBe('1.0.0');
  });

  it('lists the live channels the hub actually declared', async () => {
    const { fetchImpl } = hub();
    mount(<AboutTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('about-namespaces')).toBeTruthy());
    expect(screen.getByTestId('about-namespaces').textContent).toContain('/rt/sessions');
  });
});
