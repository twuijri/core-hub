/**
 * The two halves of naming a session, from the sidebar's own menu
 * (contract decision §26).
 *
 * **Rename** is the person's words, typed into our own dialog — never `window.prompt`,
 * which cannot label its field in Arabic and has no direction of its own (UI policy).
 * **Retitle** hands the naming back to the hub, and the whole of that gesture on the wire
 * is `title: null`; the new name then arrives on `/rt/sessions` rather than from here.
 *
 * What is asserted is the request, because the request is the contract. That the hub then
 * honours it is asserted on the hub (`modules/sessions/naming.test.ts`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openControl } from './helpers/ui.js';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SessionList } from '../src/sessions/SessionList.js';

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

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';

interface Patch {
  url: string;
  body: Record<string, unknown>;
}

function renderList(title: string | null) {
  const patches: Patch[] = [];
  const session = {
    id: SESSION,
    profile: 'default',
    owner_id: 'u',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
    title,
    source: 'chat',
    preview: null,
    pinned: false,
    archived: false,
    status: 'idle',
    message_count: 2,
  };
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
      patches.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items: [session], next_cursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={['/chat']}>
                <SessionList />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return patches;
}

/**
 * The row's own "more" button — the path that exists for the keyboard and for touch. The
 * right-click menu offers the same two items and is asserted once, below.
 */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openControl(user, await screen.findByTestId('session-more-button'));
  await screen.findByTestId('session-more');
}

afterEach(cleanup);

describe('the session menu names a session, or gives the naming back', () => {
  it('shows "New chat" for a session nothing has named yet', async () => {
    renderList(null);
    expect((await screen.findByTestId('session-row')).textContent).toContain('New chat');
  });

  it('offers the same two items on a right-click', async () => {
    renderList('خطة الإطلاق');
    fireEvent.contextMenu(await screen.findByTestId('session-row'));
    const menu = await screen.findByTestId('session-menu');
    expect(menu.textContent).toContain('Rename');
    expect(menu.textContent).toContain('Retitle');
  });

  it('renames through our own dialog, and sends the typed title', async () => {
    const user = userEvent.setup();
    const patches = renderList('New chat');
    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByTestId('prompt-field');
    await user.clear(field);
    await user.type(field, 'خطة الإطلاق');
    await user.click(screen.getByTestId('prompt-confirm'));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.url).toContain(`/sessions/${SESSION}`);
    expect(patches[0]!.body).toEqual({ title: 'خطة الإطلاق' });
  });

  it('backing out of the dialog changes nothing', async () => {
    const user = userEvent.setup();
    const patches = renderList('خطة الإطلاق');
    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await screen.findByTestId('prompt-field');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('prompt-dialog')).toBeNull());
    expect(patches).toEqual([]);
  });

  it('retitles by clearing the title — that is the whole request', async () => {
    const user = userEvent.setup();
    const patches = renderList('اسم كتبته بنفسي');
    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Retitle' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.body).toEqual({ title: null });
  });
});
