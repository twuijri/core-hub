// Rule 8 of the parity test: switching the workspace chip changes X-Hub-Profile on the next
// request and never changes the route.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { I18nProvider } from '../src/i18n/context.js';
import { WorkspaceSwitcher } from '../src/shell/WorkspaceSwitcher.js';

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

const profiles = [
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' },
  { id: '01J8QK3ZR2W7M5N4P6T8V9X0P2', slug: 'work', name: 'العمل' },
];

function Probe() {
  const location = useLocation();
  const { client } = useAuth();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <button type="button" onClick={() => void client.request('get', '/sessions')}>
        fetch
      </button>
    </>
  );
}

describe('workspace chip', () => {
  it('changes the header and keeps the route', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push(`${url} ${headers.get('X-Hub-Profile') ?? '-'}`);
      const body = url.endsWith('/profiles')
        ? { items: profiles }
        : { items: [], next_cursor: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const store = new SessionStore(memoryStorage());
    store.save({
      profile: 'default',
      token: 't',
      refresh_token: null,
      expires_at: null,
      user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
    });
    render(
      <I18nProvider language="en">
        <QueryClientProvider client={new QueryClient()}>
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter initialEntries={['/chat/abc']}>
              <Routes>
                <Route
                  path="/chat/:sessionId"
                  element={
                    <>
                      <WorkspaceSwitcher />
                      <Probe />
                    </>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    const select = await screen.findByTestId('workspace-switcher');
    await waitFor(() => expect(screen.getByRole('option', { name: 'العمل' })).toBeInTheDocument());
    await userEvent.selectOptions(select, 'work');
    await userEvent.click(screen.getByText('fetch'));
    await waitFor(() =>
      expect(seen.some((line) => line.includes('/v1/sessions') && line.endsWith(' work'))).toBe(
        true,
      ),
    );
    expect(screen.getByTestId('path')).toHaveTextContent('/chat/abc');
    expect(store.read()?.profile).toBe('work');
    vi.restoreAllMocks();
  });
});
