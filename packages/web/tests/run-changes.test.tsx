/**
 * The files a run changed (decision §49): the card under a run's last reply and the diff it
 * opens in the file panel.
 *
 * The pure rules first — reading a unified diff into numbered lines, pairing them side by
 * side, which reply carries a run's card, the plural a count takes — then the card and the
 * panel against a scripted hub: the counts stay left to right in an Arabic page, a file opens
 * its diff, the diff opens the file, and what cannot be shown says why.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Transcript } from '../src/chat/MessageView.js';
import { turnsOf } from '../src/chat/turns.js';
import { ThemeProvider } from '../src/design/theme.js';
import {
  changesRevisionOf,
  diffKey,
  lastReplyOfRuns,
  parseDiffKey,
  parseUnifiedDiff,
  pluralOf,
  splitRows,
} from '../src/files/changes.js';
import { SessionFilesProvider } from '../src/files/context.js';
import { I18nProvider } from '../src/i18n/context.js';
import type { Language } from '../src/i18n/index.js';
import { PaneProvider } from '../src/shell/pane.js';
import { SplitPane } from '../src/shell/SplitPane.js';
import type { Message, RunChanges, RunFileDiff, SessionFile } from '../src/types.js';

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const RUN = '01J8QK3ZR2W7M5N4P6T8V9X0RN';

const DIFF = '@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n end\n';

describe('reading a diff', () => {
  it('numbers every line on its side', () => {
    const [hunk] = parseUnifiedDiff(DIFF);
    expect(hunk!.header).toBe('@@ -1,3 +1,4 @@');
    expect(hunk!.lines).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'const a = 1;' },
      { kind: 'del', old: 2, new: null, text: 'const b = 2;' },
      { kind: 'add', old: null, new: 2, text: 'const b = 3;' },
      { kind: 'add', old: null, new: 3, text: 'const c = 4;' },
      { kind: 'context', old: 3, new: 4, text: 'end' },
    ]);
    const two = parseUnifiedDiff(
      '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n@@ -9,2 +9,2 @@\n x\n',
    );
    expect(two).toHaveLength(2);
    expect(two[0]!.lines[1]).toEqual({
      kind: 'note',
      old: null,
      new: null,
      text: 'No newline at end of file',
    });
    expect(two[1]!.lines[0]).toMatchObject({ old: 9, new: 9 });
  });

  it('pairs removed and added lines side by side', () => {
    const rows = splitRows(parseUnifiedDiff(DIFF)[0]!);
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['const a = 1;', 'const a = 1;'],
      ['const b = 2;', 'const b = 3;'],
      [null, 'const c = 4;'],
      ['end', 'end'],
    ]);
  });

  it('keys a diff tab by run and path, and puts a card under a run’s last reply', () => {
    const key = diffKey(RUN, 'src/a:b.ts');
    expect(parseDiffKey(key)).toEqual({ runId: RUN, path: 'src/a:b.ts' });
    expect(parseDiffKey('path:src/a.ts')).toBeNull();
    const last = lastReplyOfRuns([
      { id: 'u1', role: 'user', run_id: RUN },
      { id: 'a1', role: 'assistant', run_id: RUN },
      { id: 'a2', role: 'assistant', run_id: RUN },
      { id: 'a3', role: 'assistant', run_id: null },
    ]);
    expect([...last]).toEqual([[RUN, 'a2']]);
    expect(
      changesRevisionOf({
        b: { status: 'succeeded' },
        a: { status: 'failed' },
        c: { status: 'running' },
      }),
    ).toBe('a,b');
  });

  it('takes Arabic’s six plural forms', () => {
    expect([0, 1, 2, 3, 11, 100].map((n) => pluralOf('ar', n))).toEqual([
      'zero',
      'one',
      'two',
      'few',
      'many',
      'other',
    ]);
    expect(pluralOf('en', 3)).toBe('other');
  });
});

// ---------------------------------------------------------------- the card and the panel

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

function change(path: string, over: Partial<RunChanges['files'][number]> = {}) {
  return {
    path,
    old_path: null,
    change: 'modified' as const,
    additions: 1,
    deletions: 1,
    binary: false,
    diff: 'available' as const,
    ...over,
  };
}

function runChanges(files: RunChanges['files'], over: Partial<RunChanges> = {}): RunChanges {
  return {
    run_id: RUN,
    source: 'git',
    complete: true,
    files_changed: files.length,
    additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
    deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    truncated: false,
    recorded_at: '2026-09-25T10:00:00.000Z',
    files,
    ...over,
  };
}

function message(id: string, role: 'user' | 'assistant', text: string): Message {
  return {
    id,
    profile: 'default',
    owner_id: 'u',
    created_at: '2026-09-25T10:00:00Z',
    updated_at: '2026-09-25T10:00:00Z',
    session_id: SESSION,
    room_id: null,
    seq: id === 'u1' ? 1 : id === 'a1' ? 2 : 3,
    role,
    author:
      role === 'user'
        ? { kind: 'user', id: 'u', name: 'Admin', avatar: null }
        : { kind: 'agent', id: 'ag', name: 'Hermes', avatar: null },
    content: [{ type: 'text', text }],
    reasoning: null,
    tool_calls: [],
    run_id: RUN,
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
  } as unknown as Message;
}

function sessionFile(path: string): SessionFile {
  return {
    key: `path:${path}`,
    name: path.split('/').at(-1)!,
    path,
    attachment_id: null,
    message_id: null,
    mime: 'text/plain',
    preview: 'code',
    size_bytes: 20,
    preview_max_bytes: 2 * 1024 * 1024,
    modified_at: '2026-09-25T10:00:00.000Z',
    sources: ['working_dir'],
    tool_call_ids: [],
  };
}

const requests: string[] = [];

function mount(
  changes: RunChanges,
  diffs: Record<string, RunFileDiff>,
  options: {
    language?: Language;
    files?: SessionFile[];
    /** The last reply is still streaming, and the hub answers this for the live run (§102). */
    live?: RunChanges | null;
  } = {},
) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/files'))
      return json({ working_dir: '/w', truncated: false, items: options.files ?? [] });
    if (url.pathname.endsWith(`/sessions/${SESSION}/changes`))
      return json({ items: options.live !== undefined ? [] : [changes], next_cursor: null });
    if (url.pathname.endsWith(`/runs/${RUN}/changes`) && options.live !== undefined)
      return options.live ? json(options.live) : json({ error: 'no', code: 'not_found' }, 404);
    if (url.pathname.endsWith('/changes/diff')) {
      const found = diffs[url.searchParams.get('path') ?? ''];
      return found ? json(found) : json({ error: 'gone', code: 'not_found' }, 404);
    }
    if (url.pathname.endsWith('/files/content'))
      return Promise.resolve(new Response('const b = 3;'));
    return json({ error: 'no', code: 'not_found' }, 404);
  };
  const messages = [
    message('u1', 'user', 'عدّل الملفات'),
    message('a1', 'assistant', 'بدأت'),
    options.live !== undefined
      ? ({ ...message('a2', 'assistant', 'أعمل'), status: 'streaming' } as Message)
      : message('a2', 'assistant', 'انتهيت'),
  ];
  render(
    <ThemeProvider>
      <I18nProvider language={options.language ?? 'en'}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <SessionFilesProvider sessionId={SESSION} revision="r1" changesRevision="c1">
              <PaneProvider>
                <Transcript turns={turnsOf(messages)} showReasoning={false} runs={{}} />
                <SplitPane />
              </PaneProvider>
            </SessionFilesProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

function diffOf(path: string, over: Partial<RunFileDiff> = {}): RunFileDiff {
  return { ...change(path), run_id: RUN, truncated: false, text: DIFF, ...over };
}

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:http://hub.test/preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  requests.length = 0;
});

describe('the card under a run', () => {
  it('says how many files changed in Arabic, once, under the run’s last reply, counts left to right', async () => {
    mount(
      runChanges([
        change('src/app.ts', { additions: 6, deletions: 2 }),
        change('ملاحظات.md', { change: 'added', additions: 8, deletions: 0 }),
        change('logo.png', { binary: true, additions: null, deletions: null, diff: 'binary' }),
      ]),
      {},
      { language: 'ar' },
    );
    const card = await screen.findByTestId('run-changes');
    expect(screen.getAllByTestId('run-changes')).toHaveLength(1);
    // The card belongs to the last reply of the run, not the first.
    expect(card.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a2');
    expect(within(card).getByTestId('run-changes-title').textContent).toBe('غيّر 3 ملفات');
    const counts = within(card).getAllByTestId('run-change-counts');
    expect(counts[0]!.getAttribute('dir')).toBe('ltr');
    expect(counts[0]!.textContent).toBe('+14−2');
    const rows = within(card).getAllByTestId('run-change-file');
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual([
      'src/app.ts',
      'ملاحظات.md',
      'logo.png',
    ]);
    expect(rows[0]!.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(within(rows[2]!).getByText('ثنائي')).toBeTruthy();
    expect(within(rows[1]!).getByText('جديد')).toBeTruthy();
  });

  it('shows five files, then all of them; says what it could not list or read', async () => {
    const files = Array.from({ length: 7 }, (_, i) => change(`f${i}.ts`));
    mount(runChanges(files, { files_changed: 250, truncated: true, complete: false }), {});
    const card = await screen.findByTestId('run-changes');
    expect(within(card).getByTestId('run-changes-title').textContent).toBe('Changed 250 files');
    expect(within(card).getAllByTestId('run-change-file')).toHaveLength(5);
    fireEvent.click(within(card).getByTestId('run-changes-more'));
    expect(within(card).getAllByTestId('run-change-file')).toHaveLength(7);
    expect(card.textContent).toContain('And more files not listed here (243).');
    expect(card.textContent).toContain('may be missing');
  });
});

describe('the card while the run is still going (decision §102)', () => {
  it('shows what the run has changed so far under the live reply, with no diff to open yet', async () => {
    mount(
      runChanges([]),
      {},
      {
        language: 'ar',
        live: runChanges(
          [change('src/app.ts', { additions: 2, deletions: 0 }), change('notes.md')],
          { live: true },
        ),
      },
    );
    const card = await screen.findByTestId('run-changes-live');
    expect(card.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a2');
    expect(within(card).getByTestId('run-changes-live-badge').textContent).toBe('حتى الآن');
    expect(within(card).getByTestId('run-changes-title').textContent).toBe('غيّر ملفين');
    // Recorded diffs come with the run's end: the rows open nothing yet.
    const rows = within(card).getAllByTestId('run-change-file');
    expect(rows.map((row) => row.tagName)).toEqual(['DIV', 'DIV']);
    expect(requests.some((r) => r.includes(`/runs/${RUN}/changes`))).toBe(true);
    expect(screen.queryByTestId('run-changes')).toBeNull();
  });

  it('draws nothing while the run has changed nothing, or has no folder', async () => {
    mount(runChanges([]), {}, { live: null });
    await waitFor(() =>
      expect(requests.some((r) => r.includes(`/runs/${RUN}/changes`))).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('run-changes-live')).toBeNull();
  });
});

describe('the diff beside the chat', () => {
  it('opens a file’s diff with its line numbers, and the file from it', async () => {
    mount(
      runChanges([change('src/app.ts', { additions: 2, deletions: 1 })]),
      {
        'src/app.ts': diffOf('src/app.ts', { additions: 2, deletions: 1 }),
      },
      { files: [sessionFile('src/app.ts')] },
    );
    fireEvent.click(await screen.findByTestId('run-change-file'));
    const view = await screen.findByTestId('diff-view');
    expect(requests).toContain(
      `/api/v1/sessions/${SESSION}/runs/${RUN}/changes/diff?path=src%2Fapp.ts`,
    );
    const table = await within(view).findByTestId('diff-table');
    expect(table.closest('[dir]')?.getAttribute('dir')).toBe('ltr');
    const lines = within(table).getAllByTestId('diff-line');
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual([
      'context',
      'del',
      'add',
      'add',
      'context',
    ]);
    const cells = (i: number) => [...lines[i]!.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells(1)).toEqual(['2', '', '-const b = 2;']);
    expect(cells(3)).toEqual(['', '3', '+const c = 4;']);
    expect(screen.getAllByTestId('file-tab')[0]!.textContent).toBe('app.ts (changes)');

    fireEvent.click(within(view).getByTestId('diff-open-file'));
    expect(await screen.findByTestId('file-view')).toBeTruthy();
    expect(screen.getAllByTestId('file-tab')).toHaveLength(2);
  });

  it('draws the two sides next to each other on a wide screen', async () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('min-width'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      mount(runChanges([change('src/app.ts')]), { 'src/app.ts': diffOf('src/app.ts') });
      fireEvent.click(await screen.findByTestId('run-change-file'));
      await screen.findByTestId('diff-table');
      fireEvent.click(screen.getByTestId('diff-split'));
      const table = await screen.findByTestId('diff-table');
      expect(table.getAttribute('data-split')).toBe('true');
      const second = within(table).getAllByTestId('diff-line')[1]!;
      expect([...second.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
        '2',
        'const b = 2;',
        '2',
        'const b = 3;',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says why there are no lines, and offers no file for one the run deleted', async () => {
    mount(
      runChanges([
        change('gone.txt', {
          change: 'deleted',
          diff: 'unavailable',
          additions: null,
          deletions: null,
        }),
      ]),
      {
        'gone.txt': diffOf('gone.txt', {
          change: 'deleted',
          diff: 'unavailable',
          additions: null,
          deletions: null,
          text: null,
        }),
      },
    );
    fireEvent.click(await screen.findByTestId('run-change-file'));
    const view = await screen.findByTestId('diff-view');
    expect(await within(view).findByText(/kept no copy of it/)).toBeTruthy();
    expect(within(view).queryByTestId('diff-open-file')).toBeNull();
  });
});
