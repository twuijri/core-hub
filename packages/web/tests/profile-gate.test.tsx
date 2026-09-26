// A member the hub has given no profile signs in to one clear page — "ask an admin" — instead
// of a shell whose every request answers "profile not found" (owner, 2026-09-24).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { ProfileGate } from '../src/shell/ProfileGate.js';

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

function profile(slug: string) {
  return {
    id: `01J8QK3ZR2W7M5N4P6T8V9X${slug.slice(0, 3).toUpperCase().padEnd(3, '0')}`,
    slug,
    name: slug,
    avatar: null,
    default_model: null,
    agent_count: 0,
    session_count: 0,
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

/** `/profiles` answers whatever `lists` holds next (the last one repeats). */
function hub(lists: string[][]) {
  let call = 0;
  const fetchImpl = ((url: string) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/profiles')) {
      const slugs = lists[Math.min(call, lists.length - 1)] ?? [];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ items: slugs.map(profile) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  return fetchImpl;
}

function mount(role: string, fetchImpl: typeof fetch, language: 'en' | 'ar' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: '01J8QK3ZR2W7M5N4P6T8V9X0AA', username: 'fff', display_name: 'fff', role },
  });
  render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <ProfileGate>
              <p data-testid="app">the app</p>
            </ProfileGate>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return store;
}

afterEach(cleanup);

describe('ProfileGate', () => {
  it('tells a member with no profile to ask an admin, and offers sign-out', async () => {
    mount('member', hub([[]]));
    const page = await screen.findByTestId('no-profile');
    expect(page.textContent).toContain('No profile yet');
    expect(page.textContent).toContain('Ask an admin to give you one');
    expect(screen.queryByTestId('app')).toBeNull();
    expect(screen.getByTestId('no-profile-sign-out')).toBeTruthy();
  });

  it('says it in Arabic too', async () => {
    mount('member', hub([[]]), 'ar');
    const page = await screen.findByTestId('no-profile');
    expect(page.textContent).toContain('اطلب من المشرف');
  });

  it('lets a member with a profile through', async () => {
    mount('member', hub([['work']]));
    expect(await screen.findByTestId('app')).toBeTruthy();
    expect(screen.queryByTestId('no-profile')).toBeNull();
  });

  it('never stops an owner or admin', async () => {
    // Not a state the hub produces for them; the gate is about members only.
    mount('admin', hub([[]]));
    expect(await screen.findByTestId('app')).toBeTruthy();
  });

  it('opens the first profile granted since, when the member checks again', async () => {
    const store = mount('member', hub([[], ['work']]));
    await screen.findByTestId('no-profile');
    await userEvent.click(screen.getByText('Check again'));
    expect(await screen.findByTestId('app')).toBeTruthy();
    await waitFor(() => expect(store.read()?.profile).toBe('work'));
  });

  it('moves a member whose remembered profile was taken to the first one they still have', async () => {
    // The device remembers `default`; the admin has since given this member `work` and `lab` only.
    const store = mount('member', hub([['work', 'lab']]));
    await waitFor(() => expect(store.read()?.profile).toBe('work'));
    expect(await screen.findByTestId('app')).toBeTruthy();
    expect(screen.queryByTestId('no-profile')).toBeNull();
  });

  it('leaves a member in a profile they still have, and never moves an admin', async () => {
    const member = mount('member', hub([['lab', 'default']]));
    expect(await screen.findByTestId('app')).toBeTruthy();
    expect(member.read()?.profile).toBe('default');
    cleanup();
    const admin = mount('admin', hub([['work']]));
    expect(await screen.findByTestId('app')).toBeTruthy();
    expect(admin.read()?.profile).toBe('default');
  });
});
