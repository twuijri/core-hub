/**
 * The sidebar folds into a rail of icons (owner, 2026-09-26: the ChatGPT-style sidebar).
 *
 * The pieces — the remembered choice that survives blocked storage, the shortcut that matches
 * the physical key — and the whole app on a scripted hub: the toggle, the rail's rows keeping
 * their names, the lists giving way to two icons that open the sidebar on their list, the
 * person's menu, the choice surviving a reload, and the keyboard shortcut.
 * The browser journey (e2e zzzz-sidebar-rail) proves the widths, the tooltips and RTL.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_STORAGE,
  foldShortcutAria,
  foldShortcutLabel,
  isFoldShortcut,
  readFolded,
  writeFolded,
} from '../src/shell/sidebarFold.js';
import { openControl } from './helpers/ui.js';

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
beforeEach(() => localStorage.clear());

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

function hub() {
  return ((url: string) => {
    const path = new URL(String(url)).pathname;
    const json = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
}

function mount(path = '/chat') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: {
      id: '01J8QK3ZR2W7M5N4P6T8V9X0AA',
      username: 'noura',
      display_name: 'Noura',
      role: 'owner',
    },
  });
  render(
    <App
      store={store}
      baseUrl="http://hub.test"
      fetchImpl={hub()}
      router={(children) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>}
    />,
  );
}

const sidebar = () => screen.getAllByRole('navigation', { name: 'Main menu' })[0]!;

describe('the remembered choice and the shortcut', () => {
  it('reads and writes the choice, and a blocked storage is simply unfolded', () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    expect(readFolded(store)).toBe(false);
    writeFolded(true, store);
    expect(map.get(FOLD_STORAGE)).toBe('1');
    expect(readFolded(store)).toBe(true);
    writeFolded(false, store);
    expect(readFolded(store)).toBe(false);
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readFolded(blocked)).toBe(false);
    expect(() => writeFolded(true, blocked)).not.toThrow();
    expect(readFolded(null)).toBe(false);
  });

  it('matches Ctrl+Shift+S or ⌘⇧S on the physical key, whatever the layout types', () => {
    const keys = { ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: 'KeyS' };
    expect(isFoldShortcut({ ...keys, ctrlKey: true })).toBe(true);
    expect(isFoldShortcut({ ...keys, metaKey: true })).toBe(true);
    // An Arabic layout types «س» on that key; the code is still KeyS.
    expect(isFoldShortcut({ ...keys, ctrlKey: true, code: 'KeyS' })).toBe(true);
    expect(isFoldShortcut({ ...keys, ctrlKey: true, shiftKey: false })).toBe(false);
    expect(isFoldShortcut({ ...keys, ctrlKey: true, altKey: true })).toBe(false);
    expect(isFoldShortcut({ ...keys, ctrlKey: true, code: 'KeyD' })).toBe(false);
    expect(isFoldShortcut(keys)).toBe(false);
    expect(foldShortcutLabel(true)).toBe('⌘⇧S');
    expect(foldShortcutLabel(false)).toBe('Ctrl+Shift+S');
    expect(foldShortcutAria(true)).toBe('Meta+Shift+S');
    expect(foldShortcutAria(false)).toBe('Control+Shift+S');
  });
});

describe('the sidebar folds into a rail of icons', () => {
  it('folds with its toggle, keeps every rail row by name, and gives up the list', async () => {
    const user = userEvent.setup();
    mount();
    const nav = sidebar();
    await within(nav).findByTestId('rail');
    expect(nav.getAttribute('data-folded')).toBeNull();
    expect(within(nav).getByTestId('segments')).toBeTruthy();
    const toggle = within(nav).getByTestId('sidebar-fold');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-keyshortcuts')).toMatch(/^(Control|Meta)\+Shift\+S$/);

    await user.click(toggle);
    expect(nav.getAttribute('data-folded')).toBe('true');
    expect(localStorage.getItem(FOLD_STORAGE)).toBe('1');
    const unfold = within(nav).getByTestId('sidebar-fold');
    expect(unfold.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(unfold.getAttribute('aria-expanded')).toBe('false');
    // Every rail row is still there, and still called by its name.
    const rail = within(nav).getByTestId('rail');
    expect(
      within(rail)
        .getAllByRole('link')
        .map((link) => link.getAttribute('data-nav-id')),
    ).toEqual(['new_chat', 'search', 'agent_manager', 'tasks', 'schedules']);
    expect(within(rail).getByRole('link', { name: 'New chat' })).toBeTruthy();
    expect(within(rail).getByRole('link', { name: 'Search' })).toBeTruthy();
    // The segmented control and its list give way to two icons; the brand's name is gone.
    expect(within(nav).queryByTestId('segments')).toBeNull();
    expect(within(nav).queryByText('Core Hub')).toBeNull();
    const lists = within(nav).getByTestId('rail-segments');
    expect(within(lists).getByRole('button', { name: 'Chat' }).className).toContain('active');
    expect(within(lists).getByRole('button', { name: 'Rooms' })).toBeTruthy();
    // The footer is the person's one button.
    expect(within(nav).queryByTestId('app-version')).toBeNull();
    expect(within(nav).getByTestId('person-button').getAttribute('aria-label')).toContain('Noura');
  });

  it('remembers the choice across a reload of the app', async () => {
    localStorage.setItem(FOLD_STORAGE, '1');
    mount();
    await within(sidebar()).findByTestId('rail');
    expect(sidebar().getAttribute('data-folded')).toBe('true');
  });

  it('a list icon opens the sidebar on that list', async () => {
    const user = userEvent.setup();
    localStorage.setItem(FOLD_STORAGE, '1');
    mount();
    const nav = sidebar();
    const lists = await within(nav).findByTestId('rail-segments');
    await user.click(within(lists).getByRole('button', { name: 'Rooms' }));
    // The page changes to Rooms, so the sidebar is asked for again.
    await waitFor(() =>
      expect(
        within(within(sidebar()).getByTestId('segments')).getByRole('radio', { name: 'Rooms' }),
      ).toHaveAttribute('aria-checked', 'true'),
    );
    expect(sidebar().getAttribute('data-folded')).toBeNull();
    expect(localStorage.getItem(FOLD_STORAGE)).toBe('0');
  });

  it('the person menu holds what the footer did', async () => {
    const user = userEvent.setup();
    localStorage.setItem(FOLD_STORAGE, '1');
    mount();
    await openControl(user, await within(sidebar()).findByTestId('person-button'));
    const menu = await screen.findByTestId('person-menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(items[0]).toBe('Settings');
    expect(items).toContain('العربية');
    expect(items.some((text) => text?.startsWith('Theme: '))).toBe(true);
    expect(items.at(-1)).toBe('Sign out');
    expect(within(menu).getByText(/Noura/)).toBeTruthy();
  });

  it('Ctrl+Shift+S folds and unfolds it', async () => {
    mount();
    const nav = sidebar();
    await within(nav).findByTestId('rail');
    fireEvent.keyDown(window, { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(nav.getAttribute('data-folded')).toBe('true'));
    fireEvent.keyDown(window, { key: 'س', code: 'KeyS', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(nav.getAttribute('data-folded')).toBeNull());
    // Plain Ctrl+S is the browser's, not ours.
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
    expect(nav.getAttribute('data-folded')).toBeNull();
  });
});
