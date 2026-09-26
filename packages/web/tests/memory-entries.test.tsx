/**
 * An agent's Memory page draws each entry of its two lists on its own, with the budget the list
 * counts against (decision §102): an entry is edited or removed alone — the rest of the list is
 * sent unchanged, joined as Hermes joins it — and a write that would grow a list past its budget
 * is held back with the reason before the hub has to refuse it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shell/AppShell.js', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { AgentMemoryScreen } = await import('../src/agents/AgentMemoryScreen.js');
const { entriesOf, fits, joinEntries, lengthOf } = await import('../src/agents/memoryEntries.js');

afterEach(cleanup);

const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

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

interface Doc {
  id: string;
  content: string;
  limit: number | null;
}

/** A hub holding three documents; PUT stores what it is sent, as the real one does. */
function hub(docs: Doc[]) {
  const puts: Array<{ id: string; content: string }> = [];
  const state = new Map(docs.map((doc) => [doc.id, doc]));
  const item = (doc: Doc) => {
    const list = doc.id !== 'soul';
    const entries = list ? entriesOf(doc.content) : null;
    return {
      id: doc.id,
      kind: 'document',
      title: doc.id === 'soul' ? 'SOUL.md' : `memories/${doc.id.toUpperCase()}.md`,
      content: doc.content,
      tags: [],
      revision: 0,
      updated_at: null,
      entries,
      char_limit: list ? doc.limit : null,
      char_count: list ? lengthOf(entries ?? []) : null,
    };
  };
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    let body: unknown = { items: [], next_cursor: null };
    if (path === '/agents')
      body = { items: [{ id: AGENT, name: 'Hermes', kind: 'hermes' }], next_cursor: null };
    else if (path === `/agents/${AGENT}/memory`)
      body = { items: [...state.values()].map(item), next_cursor: null };
    else if (path.startsWith(`/agents/${AGENT}/memory/`) && method === 'PUT') {
      const id = path.split('/').at(-1)!;
      const content = (JSON.parse(String(init.body)) as { content: string }).content;
      puts.push({ id, content });
      const doc = { ...state.get(id)!, content };
      state.set(id, doc);
      body = item(doc);
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, puts };
}

function mount(fetchImpl: typeof fetch, language: 'en' | 'ar' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter initialEntries={[`/agents/${AGENT}/memory`]}>
              <Routes>
                <Route path="/agents/:agentId/memory" element={<AgentMemoryScreen />} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const DOCS: Doc[] = [
  { id: 'soul', content: 'You are calm.', limit: null },
  {
    id: 'memory',
    content: 'The deploy runs on Fridays.\n§\nThe API lives in /srv/api.',
    limit: 2200,
  },
  { id: 'user', content: 'Prefers short answers.', limit: 60 },
];

describe('the entries, the way the agent reads them', () => {
  it('splits, joins and counts as Hermes does', () => {
    expect(entriesOf(' a \n§\n\n§\nب ')).toEqual(['a', 'ب']);
    expect(joinEntries(['a', 'ب'])).toBe('a\n§\nب');
    // Code points, not UTF-16 units: an emoji is one character.
    expect(lengthOf(['😀'])).toBe(1);
    expect(fits(70, 50, 60)).toBe(false);
    // A list already over its budget may always shrink.
    expect(fits(65, 70, 60)).toBe(true);
  });
});

describe('the Memory page', () => {
  it('draws each entry on its own, with the budget it counts against', async () => {
    const { fetchImpl } = hub(DOCS);
    mount(fetchImpl);
    const memory = await screen.findByTestId('memory-entries-memory');
    const rows = within(memory).getAllByTestId('memory-entry');
    expect(rows.map((row) => row.textContent)).toEqual([
      'The deploy runs on Fridays.',
      'The API lives in /srv/api.',
    ]);
    const budget = within(screen.getByTestId('memory-doc-memory')).getByTestId('memory-budget');
    expect(budget.textContent).toBe('56 of 2,200 characters');
    // The persona is one text, with no budget and no entries.
    const soul = screen.getByTestId('memory-doc-soul');
    expect(within(soul).queryByTestId('memory-budget')).toBeNull();
    expect(soul.textContent).toContain('You are calm.');
  });

  it('edits one entry and sends the whole list, joined as the agent joins it', async () => {
    const user = userEvent.setup();
    const { fetchImpl, puts } = hub(DOCS);
    mount(fetchImpl);
    const memory = await screen.findByTestId('memory-entries-memory');
    const second = within(memory).getAllByTestId('memory-entry')[1]!;
    await user.click(within(second).getByTestId('memory-entry-edit'));
    const field = await screen.findByTestId('memory-entry-content');
    await user.clear(field);
    await user.type(field, 'The API lives in /opt/api.');
    await user.click(screen.getByTestId('save-memory-entry'));
    await waitFor(() =>
      expect(puts).toEqual([
        { id: 'memory', content: 'The deploy runs on Fridays.\n§\nThe API lives in /opt/api.' },
      ]),
    );
  });

  it('removes one entry after asking', async () => {
    const user = userEvent.setup();
    const { fetchImpl, puts } = hub(DOCS);
    mount(fetchImpl);
    const memory = await screen.findByTestId('memory-entries-memory');
    await user.click(within(memory).getAllByTestId('memory-entry-remove')[0]!);
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(puts).toEqual([{ id: 'memory', content: 'The API lives in /srv/api.' }]),
    );
  });

  it('holds back an entry that would fill the list past its budget, and says why', async () => {
    const user = userEvent.setup();
    const { fetchImpl, puts } = hub(DOCS);
    mount(fetchImpl, 'ar');
    await screen.findByTestId('memory-entries-user');
    await user.click(screen.getByTestId('memory-add-user'));
    const field = await screen.findByTestId('memory-entry-content');
    await user.type(field, 'Writes commit messages in English, always.');
    const budget = screen.getByTestId('memory-entry-budget');
    expect(budget.getAttribute('data-tone')).toBe('danger');
    expect(budget.textContent).toContain('ممتلئة');
    expect((screen.getByTestId('save-memory-entry') as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    await user.type(field, 'Likes tea.');
    expect(screen.getByTestId('memory-entry-budget').getAttribute('data-tone')).not.toBe('danger');
    await user.click(screen.getByTestId('save-memory-entry'));
    await waitFor(() =>
      expect(puts).toEqual([{ id: 'user', content: 'Prefers short answers.\n§\nLikes tea.' }]),
    );
  });
});
