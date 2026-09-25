/**
 * The chats list in groups (contract decision §54): categories above the loose chats, a group
 * per messaging channel, each collapsible — remembered by this browser — and a chat moved into
 * a category from its menu («نقل إلى تصنيف»), or by dropping it on the category's header.
 *
 * The grouping and the drop rules are pure (`sessions/groups.ts`) and asserted directly; the
 * list is asserted by what a person sees and by the requests it sends, since the request is
 * the contract. The hub's half is `modules/sessions/categories.test.ts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { SessionList } from '../src/sessions/SessionList.js';
import {
  COLLAPSED_KEY,
  dropGroup,
  dropOutcome,
  groupSessions,
  readCollapsed,
  toggled,
  unknownCategories,
  writeCollapsed,
  type SessionCategory,
} from '../src/sessions/groups.js';
import type { Session } from '../src/types.js';
import { openControl } from './helpers/ui.js';

const LAUNCH = '01J8QK3ZR2W7M5N4P6T8V9X0C1';
const EMPTY = '01J8QK3ZR2W7M5N4P6T8V9X0C2';
const ELSEWHERE = '01J8QK3ZR2W7M5N4P6T8V9X0C3';

function session(
  id: string,
  title: string,
  extra: Partial<Pick<Session, 'category_id' | 'source' | 'channel' | 'profile' | 'pinned'>> = {},
): Session {
  return {
    id,
    profile: 'default',
    owner_id: 'u',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    agent_id: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
    title,
    source: 'chat',
    origin: null,
    channel: null,
    model: null,
    provider: null,
    reasoning_effort: null,
    working_dir: null,
    preview: null,
    pinned: false,
    archived: false,
    category_id: null,
    status: 'idle',
    active_run_id: null,
    parent_session_id: null,
    notify: true,
    message_count: 0,
    usage: null,
    context: null,
    last_message_at: null,
    match: null,
    ...extra,
  } as Session;
}

function category(id: string, name: string, position: number, profile = 'default') {
  return {
    id,
    profile,
    owner_id: 'u',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    name,
    color: null,
    position,
    session_count: 0,
  } as SessionCategory;
}

const PLAN = session('01J8QK3ZR2W7M5N4P6T8V9X0S1', 'Launch plan', { category_id: LAUNCH });
const LOOSE = session('01J8QK3ZR2W7M5N4P6T8V9X0S2', 'Loose chat');
const TG = session('01J8QK3ZR2W7M5N4P6T8V9X0S3', 'From Telegram', {
  source: 'channel',
  channel: 'telegram',
});
const WA = session('01J8QK3ZR2W7M5N4P6T8V9X0S4', 'From WhatsApp', {
  source: 'channel',
  channel: 'whatsapp',
});
const CATEGORIES = [category(LAUNCH, 'الإطلاق', 0), category(EMPTY, 'Research', 1)];

describe('grouping the list', () => {
  it('puts categories first in their order, then Telegram, then WhatsApp, then the rest', () => {
    const groups = groupSessions([WA, LOOSE, TG, PLAN], CATEGORIES);
    expect(groups.map((g) => [g.key, g.items.map((s) => s.title)])).toEqual([
      [`category:${LAUNCH}`, ['Launch plan']],
      [`category:${EMPTY}`, []],
      ['channel:telegram', ['From Telegram']],
      ['channel:whatsapp', ['From WhatsApp']],
      ['rest', ['Loose chat']],
    ]);
  });

  it('files a channel chat under the category the person chose', () => {
    const filed = { ...TG, category_id: LAUNCH };
    const groups = groupSessions([filed], CATEGORIES);
    expect(groups.find((g) => g.key === `category:${LAUNCH}`)?.items).toEqual([filed]);
    expect(groups.some((g) => g.kind === 'channel')).toBe(false);
  });

  it('hides empty categories while filtering, and keeps an unknown category visible as loose', () => {
    const groups = groupSessions([PLAN], CATEGORIES, { keepEmpty: false });
    expect(groups.map((g) => g.key)).toEqual([`category:${LAUNCH}`, 'rest']);
    const orphan = session('01J8QK3ZR2W7M5N4P6T8V9X0S9', 'Orphan', { category_id: ELSEWHERE });
    expect(groupSessions([orphan], CATEGORIES).find((g) => g.key === 'rest')?.items).toEqual([
      orphan,
    ]);
    expect(unknownCategories([orphan, PLAN], CATEGORIES)).toEqual([ELSEWHERE]);
  });

  it('pins first inside a group, then the remembered order', () => {
    const a = session('01J8QK3ZR2W7M5N4P6T8V9X0SA', 'A', { category_id: LAUNCH });
    const b = session('01J8QK3ZR2W7M5N4P6T8V9X0SB', 'B', { category_id: LAUNCH, pinned: true });
    const c = session('01J8QK3ZR2W7M5N4P6T8V9X0SC', 'C', { category_id: LAUNCH });
    const [launch] = groupSessions([a, b, c], CATEGORIES, { manual: [c.id, a.id] });
    expect(launch?.items.map((s) => s.title)).toEqual(['B', 'C', 'A']);
  });
});

describe('dropping a chat', () => {
  const groups = groupSessions(
    [PLAN, LOOSE, TG],
    [...CATEGORIES, category(ELSEWHERE, 'Other profile', 0, 'designer')],
  );
  const groupOf = (s: Session) => groups.find((g) => g.items.includes(s)) ?? null;

  it('moves into a category when dropped on its header or on a row inside it', () => {
    expect(
      dropOutcome(LOOSE, groupOf(LOOSE), dropGroup(`group:category:${EMPTY}`, groups)),
    ).toEqual({ kind: 'move', categoryId: EMPTY });
    expect(dropOutcome(LOOSE, groupOf(LOOSE), dropGroup(PLAN.id, groups))).toEqual({
      kind: 'move',
      categoryId: LAUNCH,
    });
  });

  it('takes a chat out of its category when dropped among the loose chats', () => {
    expect(dropOutcome(PLAN, groupOf(PLAN), dropGroup(LOOSE.id, groups))).toEqual({
      kind: 'move',
      categoryId: null,
    });
  });

  it('reorders within a group, and never files into a channel or another profile', () => {
    expect(dropOutcome(PLAN, groupOf(PLAN), dropGroup(PLAN.id, groups))).toEqual({
      kind: 'reorder',
    });
    expect(dropOutcome(LOOSE, groupOf(LOOSE), dropGroup(TG.id, groups))).toEqual({
      kind: 'none',
    });
    expect(
      dropOutcome(LOOSE, groupOf(LOOSE), dropGroup(`group:category:${ELSEWHERE}`, groups)),
    ).toEqual({ kind: 'none' });
  });
});

describe('collapsed groups are remembered per viewer', () => {
  it('round-trips through storage, and survives a broken value', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: map.set.bind(map) };
    writeCollapsed(storage, toggled(new Set(), `category:${LAUNCH}`));
    expect([...readCollapsed(storage)]).toEqual([`category:${LAUNCH}`]);
    expect([...toggled(readCollapsed(storage), `category:${LAUNCH}`)]).toEqual([]);
    map.set(COLLAPSED_KEY, '{not json');
    expect(readCollapsed(storage).size).toBe(0);
  });
});

// --------------------------------------------------------------------- the list itself

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

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function renderList(language: 'en' | 'ar' = 'en') {
  const calls: Call[] = [];
  let sessions = [PLAN, LOOSE, TG, WA];
  let categories = [...CATEGORIES];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (path === '/session-categories' && method === 'GET') return json({ items: categories });
    if (path === '/session-categories' && method === 'POST') {
      const made = category('01J8QK3ZR2W7M5N4P6T8V9X0C9', String(body?.name), categories.length);
      categories = [...categories, made];
      return json(made, 201);
    }
    if (path === '/sessions' && method === 'GET')
      return json({ items: sessions, next_cursor: null });
    const one = sessions.find((s) => path === `/sessions/${s.id}`);
    if (one && method === 'PATCH') {
      const updated = { ...one, ...(body as Partial<Session>) };
      sessions = sessions.map((s) => (s.id === one.id ? updated : s));
      return json(updated);
    }
    return json({ items: [], next_cursor: null });
  };
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const view = render(
    <ThemeProvider>
      <I18nProvider language={language}>
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
  return { calls, view };
}

const groupNamed = async (name: string) => {
  const heads = await screen.findAllByTestId('session-group');
  const found = heads.find(
    (g) => within(g).getByTestId('session-group-toggle').textContent?.includes(name) ?? false,
  );
  if (!found) throw new Error(`no group ${name}`);
  return found;
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('the chats list in groups', () => {
  it('shows the categories, then Telegram and WhatsApp, above the loose chats — in Arabic', async () => {
    renderList('ar');
    await screen.findByText('Launch plan');
    const names = (await screen.findAllByTestId('session-group-toggle')).map(
      (b) => b.textContent ?? '',
    );
    expect(names.map((n) => n.replace(/\d+$/, ''))).toEqual([
      'الإطلاق',
      'Research',
      'تيليجرام',
      'واتساب',
    ]);
    expect(within(await groupNamed('الإطلاق')).getByText('Launch plan')).toBeTruthy();
    expect(within(await groupNamed('تيليجرام')).getByText('From Telegram')).toBeTruthy();
    // The loose chat is in no group.
    const loose = screen.getByText('Loose chat');
    expect(loose.closest('[data-testid="session-group"]')).toBeNull();
  });

  it('collapses a group, remembers it, and a new list opens it collapsed', async () => {
    const user = userEvent.setup();
    const first = renderList();
    const launch = await groupNamed('الإطلاق');
    const toggle = within(launch).getByTestId('session-group-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(launch).queryByText('Launch plan')).toBeNull();
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual([`category:${LAUNCH}`]);

    first.view.unmount();
    renderList();
    const again = await groupNamed('الإطلاق');
    expect(within(again).getByTestId('session-group-toggle').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(within(again).queryByText('Launch plan')).toBeNull();
    // A typed filter shows every match, collapsed or not.
    await user.type(screen.getByRole('searchbox'), 'launch');
    expect(await within(await groupNamed('الإطلاق')).findByText('Launch plan')).toBeTruthy();
  });

  it('moves a chat into a category from its menu, and sends exactly that', async () => {
    const user = userEvent.setup();
    const { calls } = renderList();
    await screen.findByText('Loose chat');
    const row = screen
      .getByText('Loose chat')
      .closest('[data-testid="session-row"]') as HTMLElement;
    await openControl(user, within(row).getByTestId('session-more-button'));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to category' }));
    const dialog = await screen.findByTestId('move-category-dialog');
    await user.click(within(dialog).getByRole('button', { name: /Research/ }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: `/sessions/${LOOSE.id}`, body: { category_id: EMPTY } },
      ]),
    );
    expect(await within(await groupNamed('Research')).findByText('Loose chat')).toBeTruthy();
  });

  it('takes a chat out of its category with "No category"', async () => {
    const user = userEvent.setup();
    const { calls } = renderList();
    const row = (await screen.findByText('Launch plan')).closest(
      '[data-testid="session-row"]',
    ) as HTMLElement;
    await openControl(user, within(row).getByTestId('session-more-button'));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to category' }));
    const dialog = await screen.findByTestId('move-category-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'No category' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ category_id: null }),
    );
  });

  it('creates a category from the list', async () => {
    const user = userEvent.setup();
    const { calls } = renderList();
    await screen.findByText('Loose chat');
    await user.click(screen.getByTestId('session-category-new'));
    const field = await screen.findByTestId('prompt-field');
    await user.type(field, 'عملاء');
    await user.click(screen.getByTestId('prompt-confirm'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: '/session-categories',
        body: { name: 'عملاء' },
      }),
    );
    expect(await groupNamed('عملاء')).toBeTruthy();
  });
});
