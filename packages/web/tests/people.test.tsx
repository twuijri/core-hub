// People and Workspaces: two admin pages whose whole job is to offer only what the hub
// will accept. The owner is immutable, nobody may disable or delete themselves, the
// default workspace stays, and removing a workspace archives it — so the button says so.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { openControl } from './helpers/ui.js';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { UsersTab } from '../src/people/UsersTab.js';
import { WorkspacesTab } from '../src/people/WorkspacesTab.js';

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

const ME = '01J8QK3ZR2W7M5N4P6T8V9X0HM';

function person(over: Record<string, unknown> = {}) {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0AA',
    username: 'sara',
    display_name: 'سارة',
    role: 'member',
    status: 'active',
    locale: 'ar',
    avatar: null,
    profiles: [],
    default_profile: 'default',
    last_login_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

function workspace(over: Record<string, unknown> = {}) {
  return {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0W1',
    slug: 'default',
    name: 'الافتراضي',
    avatar: null,
    default_model: null,
    agent_count: 2,
    session_count: 9,
    owner_id: ME,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function hub(state: { users?: unknown[]; workspaces?: unknown[]; lockouts?: unknown[] } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
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
    if (path.endsWith('/auth/users') && method === 'GET')
      return json({ items: state.users ?? [], next_cursor: null });
    if (path.includes('/auth/users')) return json(person());
    if (path.endsWith('/auth/lockouts')) return json({ items: state.lockouts ?? [] });
    if (path.endsWith('/profiles') && method === 'GET')
      return json({ items: state.workspaces ?? [workspace()] });
    if (path.includes('/profiles')) return json(workspace());
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
    user: { id: ME, username: 'admin', display_name: 'Admin', role: 'owner' },
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

afterEach(cleanup);

describe('People', () => {
  it('gives the owner only a password on their own row (owner, 2026-09-23)', async () => {
    const { fetchImpl, sent } = hub({
      users: [person({ id: ME, username: 'admin', role: 'owner' })],
    });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('user-table')).toBeTruthy());
    // Role and status never change; delete and the menu are not offered.
    expect(screen.queryByTestId('user-menu')).toBeNull();
    expect(screen.queryByTestId('user-delete')).toBeNull();
    await userEvent.click(screen.getByTestId('user-password'));
    // Their own: this device stays signed in, and the dialog says so.
    expect(await screen.findByText(/This device stays signed in/)).toBeTruthy();
    await userEvent.type(await screen.findByLabelText('New password'), 'a-long-enough-one');
    await userEvent.click(screen.getByTestId('save-password'));
    await waitFor(() => {
      const patch = sent.find((s) => s.method === 'PATCH');
      expect(patch?.url).toContain(ME);
      expect(patch?.body).toEqual({ password: 'a-long-enough-one' });
    });
  });

  it('shows an admin that the owner’s account is not theirs to edit, and says why once', async () => {
    const { fetchImpl } = hub({ users: [person({ username: 'owner', role: 'owner' })] });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('user-table')).toBeTruthy());
    expect(screen.getByTestId('owner-note')).toBeTruthy();
    expect(screen.queryByTestId('user-password')).toBeNull();
  });

  it('does not offer to disable or delete the person who is signed in', async () => {
    // An admin looking at their own row: the hub refuses both, so neither is shown.
    const { fetchImpl } = hub({ users: [person({ id: ME, username: 'admin', role: 'admin' })] });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('user-menu')).toBeTruthy());
    // What is legal is there…
    expect(screen.getByTestId('user-password')).toBeTruthy();
    // …and what the hub refuses is not offered at all.
    expect(screen.queryByTestId('user-delete')).toBeNull();
    await openControl(userEvent, screen.getByTestId('user-menu'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('Disable')).toBeNull();
    expect(within(menu).queryByText('Delete')).toBeNull();
  });

  it('puts password and delete on somebody else’s row, and disable in its menu', async () => {
    // Owner, 2026-09-23: behind "⋯" they were not found at all.
    const { fetchImpl } = hub({ users: [person()] });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('user-menu')).toBeTruthy());
    expect(screen.getByTestId('user-password')).toBeTruthy();
    expect(screen.getByTestId('user-delete')).toBeTruthy();
    await openControl(userEvent, screen.getByTestId('user-menu'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Disable')).toBeTruthy();
  });

  it('sends a password as a patch and never asks for one back', async () => {
    const { fetchImpl, sent } = hub({ users: [person()] });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('user-password')).toBeTruthy());
    await userEvent.click(screen.getByTestId('user-password'));
    const field = await screen.findByLabelText('New password');
    await userEvent.type(field, 'a-long-enough-one');
    await userEvent.click(screen.getByTestId('save-password'));
    await waitFor(() => {
      const patch = sent.find((s) => s.method === 'PATCH');
      expect(patch?.body).toEqual({ password: 'a-long-enough-one' });
    });
    // Nothing in the page ever reads a password back: no GET carries one.
    expect(sent.filter((s) => s.method === 'GET').some((s) => s.url.includes('password'))).toBe(
      false,
    );
  });

  it('will not save a password shorter than the contract allows', async () => {
    const { fetchImpl, sent } = hub({ users: [person()] });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('user-password')).toBeTruthy());
    await userEvent.click(screen.getByTestId('user-password'));
    await userEvent.type(await screen.findByLabelText('New password'), 'short');
    expect(screen.getByTestId('save-password').hasAttribute('disabled')).toBe(true);
    expect(sent.some((s) => s.method === 'PATCH')).toBe(false);
  });

  it('says an empty lockout list is an answer, not a missing table', async () => {
    const { fetchImpl } = hub({ users: [person()] });
    mount(<UsersTab />, fetchImpl);
    await waitFor(() => expect(screen.getByText('No lockouts')).toBeTruthy());
    expect(screen.queryByTestId('lockout-table')).toBeNull();
    expect(screen.queryByTestId('clear-lockouts')).toBeNull();
  });
});

describe('Workspaces', () => {
  it('never offers to archive the default workspace', async () => {
    const { fetchImpl } = hub();
    mount(<WorkspacesTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('workspace-list')).toBeTruthy());
    expect(screen.queryByTestId('archive-workspace')).toBeNull();
  });

  it('calls it archive, and says what actually happens to the conversations', async () => {
    // The hub archives rather than deletes, so a button labelled delete would be a lie
    // the person discovers later.
    const { fetchImpl } = hub({
      workspaces: [
        workspace(),
        workspace({ id: 'w2', slug: 'work', name: 'العمل', session_count: 4 }),
      ],
    });
    mount(<WorkspacesTab />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('archive-workspace')).toBeTruthy());
    await userEvent.click(screen.getByTestId('archive-workspace'));
    expect(await screen.findByText(/Archive العمل\?/)).toBeTruthy();
    expect(screen.getByText(/are not erased/)).toBeTruthy();
  });

  it('suggests a slug from the name and stops as soon as one is typed', async () => {
    const { fetchImpl } = hub();
    mount(<WorkspacesTab />, fetchImpl);
    await userEvent.click(screen.getByTestId('add-workspace'));
    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, 'Side Projects');
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('side-projects');
    const slug = screen.getByLabelText('Slug');
    await userEvent.clear(slug);
    await userEvent.type(slug, 'labs');
    await userEvent.type(name, ' Two');
    // The name kept changing; the slug the person chose did not.
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('labs');
  });

  it('refuses a slug that already exists, before the hub has to', async () => {
    const { fetchImpl, sent } = hub();
    mount(<WorkspacesTab />, fetchImpl);
    await userEvent.click(screen.getByTestId('add-workspace'));
    await userEvent.type(await screen.findByLabelText('Name'), 'Default');
    expect(screen.getByText('That slug is taken')).toBeTruthy();
    expect(screen.getByTestId('save-workspace').hasAttribute('disabled')).toBe(true);
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });

  it('creates with clone_from only when one was chosen', async () => {
    const { fetchImpl, sent } = hub();
    mount(<WorkspacesTab />, fetchImpl);
    await userEvent.click(screen.getByTestId('add-workspace'));
    await userEvent.type(await screen.findByLabelText('Name'), 'Labs');
    await userEvent.click(screen.getByTestId('save-workspace'));
    await waitFor(() => {
      const post = sent.find((s) => s.method === 'POST');
      expect(post?.body).toEqual({ slug: 'labs', name: 'Labs' });
    });
  });
});
