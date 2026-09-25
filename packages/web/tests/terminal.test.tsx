// The owner's web terminal in the web client (DECISIONS §60; owner, 2026-09-25: «الا خله
// للمشرف الرئيسي بس»). The hub is the gate; what the client must get right is that nobody
// but the owner of a hub that has it on ever sees the entry — and that an admin or a member
// is not even asked about it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { navigation, roleAllows, destinationsById } from '../src/navigation/manifest.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SettingsNav } from '../src/settings/SettingsNav.js';
import { TerminalTool } from '../src/terminal/TerminalTool.js';

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

const STATUS = {
  enabled: true,
  pty: true,
  shell: '/bin/bash',
  idle_timeout_seconds: 900,
  max_sessions: 3,
  sessions: [],
};

/** A hub whose `GET /terminal` answers `terminal` (a status, or a status code). */
function hub(terminal: typeof STATUS | 403) {
  const asked: string[] = [];
  const fetchImpl = ((url: string) => {
    const path = new URL(String(url)).pathname;
    asked.push(path);
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/terminal')) {
      return terminal === 403
        ? json({ error: 'off', code: 'forbidden', details: { reason: 'terminal_disabled' } }, 403)
        : json(terminal);
    }
    return json({ error: 'not found', code: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

function mount(node: React.ReactElement, role: string, fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={['/settings/account']}>{node}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('the Terminal entry', () => {
  it('is a Settings tool for the owner role alone in the navigation contract', () => {
    const terminal = destinationsById.get('terminal')!;
    expect(navigation.settingsTools).toContain('terminal');
    expect(terminal.roles).toEqual(['owner']);
    expect(roleAllows(terminal, 'owner')).toBe(true);
    expect(roleAllows(terminal, 'admin')).toBe(false);
    expect(roleAllows(terminal, 'member')).toBe(false);
  });

  it('shows for the owner when the hub reports the terminal on', async () => {
    const { fetchImpl } = hub(STATUS);
    mount(<SettingsNav current="account" />, 'owner', fetchImpl);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Terminal' }).getAttribute('href')).toBe(
        '/settings/terminal',
      ),
    );
  });

  it('stays hidden from the owner when the hub answers 403 (COREHUB_WEB_TERMINAL is off)', async () => {
    const { fetchImpl, asked } = hub(403);
    mount(<SettingsNav current="account" />, 'owner', fetchImpl);
    await waitFor(() => expect(asked.some((path) => path.endsWith('/terminal'))).toBe(true));
    await screen.findByRole('link', { name: 'Plugins' });
    expect(screen.queryByRole('link', { name: 'Terminal' })).toBeNull();
  });

  for (const role of ['admin', 'member']) {
    it(`is never shown to ${role === 'admin' ? 'an admin' : 'a member'}, and the hub is not asked`, async () => {
      // Even a hub that would answer 200 — the role alone hides it.
      const { fetchImpl, asked } = hub(STATUS);
      mount(<SettingsNav current="account" />, role, fetchImpl);
      await screen.findByRole('link', { name: 'Account' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('link', { name: 'Terminal' })).toBeNull();
      expect(asked.filter((path) => path.endsWith('/terminal'))).toEqual([]);
    });
  }
});

describe('the Terminal page', () => {
  it('always carries the warning that it is a shell on the server with the hub account', async () => {
    const { fetchImpl } = hub(STATUS);
    mount(<TerminalTool />, 'owner', fetchImpl);
    expect(
      await screen.findByText(
        "This is a terminal on the server, with the hub account's permissions.",
      ),
    ).toBeTruthy();
    expect(screen.getByText('No terminal open')).toBeTruthy();
  });

  it('says the terminal is not enabled when the hub refuses', async () => {
    const { fetchImpl } = hub(403);
    mount(<TerminalTool />, 'owner', fetchImpl);
    expect(await screen.findByText('The terminal is not enabled on this hub.')).toBeTruthy();
  });
});
