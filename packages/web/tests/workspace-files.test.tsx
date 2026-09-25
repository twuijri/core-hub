// The Files page (DECISIONS §56): the profile's working folder, against a scripted hub.
// What is worth pinning here is what a person relies on — the folder in the address, a
// delete that asks first, a save that sends back what it read and says so when the file
// moved under it, and a file handed to the next composer in the same profile only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { HubApiError } from '@corehub/contracts';
import { HANDOFF_TTL_MS, handOff, takeHandOff } from '../src/attachments/handoff.js';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Composer } from '../src/chat/Composer.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import type { Attachment } from '../src/types.js';
import { highlight } from '../src/workspace-files/CodeEditor.js';
import { FilesTool, copyName, filesHref } from '../src/workspace-files/FilesTool.js';
import {
  crumbsOf,
  joinPath,
  normalisePath,
  parentOf,
  previewKindOf,
  textDirectionOf,
} from '../src/workspace-files/paths.js';
import { conflictOf } from '../src/workspace-files/TextEditorDialog.js';

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

const LIMITS = {
  max_upload_bytes: 26214400,
  max_edit_bytes: 1048576,
  max_archive_bytes: 209715200,
  max_archive_entries: 20000,
};

const entry = (over: Record<string, unknown>) => ({
  link: false,
  size_bytes: null,
  modified_at: '2026-09-25T08:00:00Z',
  mime: null,
  editable: false,
  ...over,
});

const FOLDERS: Record<string, unknown[]> = {
  '': [
    entry({ name: 'session-1', path: 'session-1', kind: 'directory' }),
    entry({ name: 'keys-link', path: 'keys-link', kind: 'link', link: true, modified_at: null }),
    entry({
      name: 'plan.md',
      path: 'plan.md',
      kind: 'file',
      size_bytes: 7,
      mime: 'text/markdown',
      editable: true,
    }),
  ],
  'session-1': [
    entry({
      name: 'app.ts',
      path: 'session-1/app.ts',
      kind: 'file',
      size_bytes: 20,
      mime: 'text/javascript',
      editable: true,
    }),
  ],
};

interface Sent {
  path: string;
  query: string;
  method: string;
  body: unknown;
}

/** A scripted hub: folders, one text file, and a save that can be told to conflict. */
function hub(options: { conflictOnce?: boolean } = {}) {
  const sent: Sent[] = [];
  let conflict = options.conflictOnce ?? false;
  let etag = '"v1"';
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace('/api/v1', '');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ path, query: parsed.search, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path === '/workspace-files' && method === 'GET') {
      const folder = parsed.searchParams.get('path') ?? '';
      const entries = FOLDERS[folder];
      if (!entries) return json({ error: 'not here', code: 'not_found' }, 404);
      return json({ profile: 'default', path: folder, entries, truncated: false, limits: LIMITS });
    }
    if (path === '/workspace-files' && method === 'DELETE') return json(null, 204);
    if (path === '/workspace-files/text' && method === 'GET') {
      return json({
        path: parsed.searchParams.get('path'),
        content: '# Plan\n',
        etag,
        size_bytes: 7,
        modified_at: '2026-09-25T08:00:00Z',
      });
    }
    if (path === '/workspace-files/text' && method === 'PUT') {
      if (conflict) {
        conflict = false;
        etag = '"v-agent"';
        return json(
          {
            error: 'changed',
            code: 'conflict',
            details: { reason: 'changed', etag, path: body.path },
          },
          409,
        );
      }
      etag = `"v${String(sent.length)}"`;
      return json({
        path: body.path,
        content: body.content,
        etag,
        size_bytes: body.content.length,
        modified_at: '2026-09-25T09:00:00Z',
      });
    }
    if (path === '/sessions') return json({ items: [], next_cursor: null });
    if (path === '/profiles') return json({ items: [] });
    return json({ error: path, code: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

/** Shows where the router is, so a test can read the folder from the address. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function mount(fetchImpl: typeof fetch, at = filesHref('')) {
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
              <MemoryRouter initialEntries={[at]}>
                <Routes>
                  <Route
                    path="*"
                    element={
                      <>
                        <FilesTool />
                        <Where />
                      </>
                    }
                  />
                </Routes>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('Files: paths', () => {
  it('builds and splits the contract’s relative paths', () => {
    expect(joinPath('', 'a.md')).toBe('a.md');
    expect(joinPath('a/b', 'c')).toBe('a/b/c');
    expect(parentOf('a/b/c')).toBe('a/b');
    expect(parentOf('c')).toBe('');
    expect(crumbsOf('a/b')).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
    ]);
    expect(normalisePath(' ./reports//2026/ ')).toBe('reports/2026');
    expect(normalisePath('a\\b')).toBe('a/b');
    expect(copyName('notes.md')).toBe('notes copy.md');
    expect(copyName('Makefile')).toBe('Makefile copy');
    expect(filesHref('a b/c')).toBe('/settings/files?path=a%20b%2Fc');
  });

  it('never draws an SVG or HTML file as a document', () => {
    expect(previewKindOf({ mime: 'image/png', editable: false })).toBe('image');
    expect(previewKindOf({ mime: 'image/svg+xml', editable: true })).toBe('text');
    expect(previewKindOf({ mime: 'text/html', editable: true })).toBe('text');
    expect(previewKindOf({ mime: 'application/pdf', editable: false })).toBe('pdf');
    expect(previewKindOf({ mime: 'application/zip', editable: false })).toBe('none');
  });

  it('colours code and writes it left to right; prose follows its own letters', () => {
    const spans = highlight('const a = 1;', 'app.ts');
    expect(spans).not.toBeNull();
    const { container } = render(<pre>{spans}</pre>);
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(highlight('just words', 'notes.txt')).toBeNull();
    expect(textDirectionOf('app.ts')).toBe('ltr');
    expect(textDirectionOf('ملاحظات.md')).toBe('auto');
  });

  it('reads a save conflict from the hub’s answer', () => {
    const refused = new HubApiError(409, 'conflict', 'changed', {
      details: { reason: 'changed', etag: '"x"' },
    });
    expect(conflictOf(refused)).toEqual({ reason: 'changed', etag: '"x"' });
    expect(conflictOf(new HubApiError(400, 'validation_failed', 'no', {}))).toBeNull();
  });
});

describe('Files: the page', () => {
  it('lists the folder, marks a link that leads out, and keeps the folder in the address', async () => {
    const { fetchImpl, sent } = hub();
    mount(fetchImpl);
    const table = await screen.findByTestId('files-table');
    expect(within(table).getByText('plan.md')).toBeTruthy();
    expect(within(table).getByText('Link outside')).toBeTruthy();
    // The escaping link is a name, not a button: nothing opens it.
    expect(
      within(table)
        .getAllByTestId('files-entry')
        .map((button) => button.textContent),
    ).toEqual(['session-1', 'plan.md']);

    fireEvent.click(within(table).getByText('session-1'));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/settings/files?path=session-1'),
    );
    await screen.findByText('app.ts');
    expect(sent.some((call) => call.query === '?path=session-1')).toBe(true);
    const crumbs = screen.getByTestId('files-breadcrumb');
    expect(within(crumbs).getByText('session-1').getAttribute('aria-current')).toBe('page');
  });

  it('says a folder that is not there, and offers the way back to the top', async () => {
    const { fetchImpl } = hub();
    mount(fetchImpl, filesHref('gone'));
    const error = await screen.findByTestId('files-error');
    fireEvent.click(within(error).getByRole('button', { name: 'Back to the top folder' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/settings/files'));
  });

  it('deletes only after the confirm, and sends the path it names', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = hub();
    mount(fetchImpl);
    await screen.findByTestId('files-table');
    const menus = screen.getAllByTestId('files-row-actions');
    menus[2]!.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete «plan.md»?')).toBeTruthy();
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(sent.find((call) => call.method === 'DELETE')?.query).toBe('?path=plan.md'),
    );
  });

  it('saves against the etag it read, and on a conflict overwrites only when asked', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = hub({ conflictOnce: true });
    mount(fetchImpl);
    await screen.findByTestId('files-table');
    fireEvent.click(screen.getByText('plan.md'));
    await user.click(await screen.findByTestId('files-preview-edit'));
    const input = (await screen.findByTestId('files-editor-text-input')) as HTMLTextAreaElement;
    expect(input.value).toBe('# Plan\n');
    fireEvent.change(input, { target: { value: '# Plan\n\nmine\n' } });
    await user.click(screen.getByTestId('files-editor-save'));

    // An agent wrote the file meanwhile: nothing is saved, and the choice is the person's.
    await screen.findByTestId('files-editor-conflict');
    const first = sent.filter((call) => call.method === 'PUT');
    expect(first).toHaveLength(1);
    expect(first[0]!.body).toEqual({ path: 'plan.md', content: '# Plan\n\nmine\n', etag: '"v1"' });

    await user.click(screen.getByTestId('files-editor-overwrite'));
    await waitFor(() => expect(sent.filter((call) => call.method === 'PUT')).toHaveLength(2));
    expect(sent.filter((call) => call.method === 'PUT')[1]!.body).toMatchObject({
      etag: '"v-agent"',
    });
    await waitFor(() => expect(screen.queryByTestId('files-editor-conflict')).toBeNull());
    expect(screen.getByText('All changes saved')).toBeTruthy();
  });
});

describe('Files: attach to chat', () => {
  const attachment = {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0AT',
    name: 'plan.md',
    mime: 'text/markdown',
    size_bytes: 7,
    kind: 'file',
  } as Attachment;

  it('hands a file to the next composer in the same profile, once', () => {
    handOff('work', [attachment]);
    expect(takeHandOff('default')).toEqual([]);
    expect(takeHandOff('work')).toEqual([attachment]);
    expect(takeHandOff('work')).toEqual([]);
  });

  it('forgets a hand-off nobody took in time', () => {
    handOff('default', [attachment]);
    expect(takeHandOff('default', Date.now() + HANDOFF_TTL_MS + 1)).toEqual([]);
    expect(takeHandOff('default')).toEqual([]);
  });

  it('opens the composer with the handed file already in its tray', async () => {
    handOff('default', [attachment]);
    const store = new SessionStore(memoryStorage());
    store.save({
      profile: 'default',
      token: 't',
      refresh_token: null,
      expires_at: null,
      user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
    });
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('{"items":[]}', { status: 200 }));
    const blocks: unknown[] = [];
    render(
      <ThemeProvider>
        <I18nProvider language="en">
          <QueryClientProvider client={new QueryClient()}>
            <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
              <RealtimeProvider>
                <MemoryRouter>
                  <Composer
                    busy={false}
                    disabled={false}
                    onSend={async (content) => {
                      blocks.push(...content);
                    }}
                    onCancel={async () => {}}
                  />
                </MemoryRouter>
              </RealtimeProvider>
            </AuthProvider>
          </QueryClientProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
    const tray = await screen.findByTestId('composer-attachments');
    expect(within(tray).getByText('plan.md')).toBeTruthy();
    fireEvent.submit(screen.getByTestId('composer'));
    await waitFor(() => expect(blocks).toHaveLength(1));
    expect(blocks[0]).toMatchObject({ type: 'file', attachment_id: attachment.id });
  });
});
