// The product's name in the top bar reads in the person's language: the hub answers
// "Core Hub", an Arabic screen says «كور هب», and a name the owner set is kept as written.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { TopBar } from '../src/shell/TopBar.js';

afterEach(cleanup);

function hub(name: string) {
  return ((url: string) => {
    const path = new URL(String(url)).pathname;
    const body = path.endsWith('/meta')
      ? {
          name,
          server_version: '0.0.0',
          contract_version: '1.0.0',
          api_versions: ['v1'],
          realtime_namespaces: [],
          locales: ['ar', 'en'],
          setup_required: false,
        }
      : path.endsWith('/profiles')
        ? { items: [], next_cursor: null }
        : { error: { code: 'not_found', message: path } };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: path.endsWith('/meta') || path.endsWith('/profiles') ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

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

function mount(language: 'ar' | 'en', fetchImpl: typeof fetch) {
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
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <PaneProvider>
                  <TopBar title="x" onMenu={() => undefined} />
                </PaneProvider>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('the product name in the top bar', () => {
  it('is «كور هب» on an Arabic screen when the hub answers its own name', async () => {
    mount('ar', hub('Core Hub'));
    expect(await screen.findByText('كور هب')).toBeTruthy();
    expect(screen.queryByText('Core Hub')).toBeNull();
  });

  it('is Core Hub on an English screen', async () => {
    mount('en', hub('Core Hub'));
    expect(await screen.findByText('Core Hub')).toBeTruthy();
  });

  it('is the name the owner set, as written, in either language', async () => {
    mount('ar', hub('Office hub'));
    expect(await screen.findByText('Office hub')).toBeTruthy();
  });
});
