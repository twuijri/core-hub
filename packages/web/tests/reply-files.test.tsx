/**
 * The files an agent leaves for the person come back on its reply, and are seen there
 * (owner, 2026-09-26: «سوي صورة قط يطير» — the reply said the picture was saved, printed
 * `/data/workspaces/…/.corehub/runs/<run>/out/flying_cat.png`, and showed no picture).
 *
 * - A picture on a reply is drawn in it, fetched with the bearer header; it opens beside the
 *   chat. Any other file is its name, which opens the same preview.
 * - The run folder's path is drawn as the file's own name, which opens that file; a fenced
 *   code block keeps what was written.
 * - A name the reply uses means the file the reply carries, even when an older file of the
 *   conversation has the same name.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { MessageView } from '../src/chat/MessageView.js';
import { ThemeProvider } from '../src/design/theme.js';
import { SessionFilesProvider } from '../src/files/context.js';
import { hideRunPaths } from '../src/files/run-paths.js';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { SplitPane } from '../src/shell/SplitPane.js';
import type { Message, SessionFile } from '../src/types.js';

const SESSION = '01M3AZNF7BRBM4JJ0GM1XNHP74';
const RUN = '01M3CXDE8PXTY3W2C3DRCF00YZ';
const CAT = '01M3CXDE8PXTY3W2C3DRCF0CAT';
const OLD_CAT = '01M3CXDE8PXTY3W2C3DRCF0OLD';
const NOTES = '01M3CXDE8PXTY3W2C3DRCF0TXT';
const OUT = `/data/workspaces/default/${SESSION}/.corehub/runs/${RUN}/out`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function attachment(id: string, name: string, mime: string, preview: SessionFile['preview']) {
  return {
    key: `attachment:${id}`,
    name,
    path: null,
    attachment_id: id,
    message_id: 'm-reply',
    mime,
    preview,
    size_bytes: 8,
    preview_max_bytes: 2 * 1024 * 1024,
    modified_at: null,
    sources: ['attachment'],
    tool_call_ids: [],
  } satisfies SessionFile;
}

function reply(text: string, extra: Message['content'] = []): Message {
  return {
    id: 'm-reply',
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-26T10:00:00Z',
    updated_at: '2026-09-26T10:00:00Z',
    session_id: SESSION,
    room_id: null,
    seq: 2,
    author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
    content: [{ type: 'text', text }, ...extra],
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

const catBlock = {
  type: 'image' as const,
  attachment_id: CAT,
  url: `/api/v1/attachments/${CAT}/content`,
  name: 'flying_cat.png',
  mime: 'image/png',
  size_bytes: 8,
};
const notesBlock = {
  type: 'file' as const,
  attachment_id: NOTES,
  url: `/api/v1/attachments/${NOTES}/content`,
  name: 'notes.txt',
  mime: 'text/plain',
  size_bytes: 5,
};

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

const requests: Array<{ path: string; auth: string | null }> = [];

function mount(message: Message, files: SessionFile[]) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(String(request ? request.url : input));
    const headers = new Headers(request ? request.headers : init?.headers);
    requests.push({ path: url.pathname, auth: headers.get('authorization') });
    if (url.pathname.endsWith('/files')) {
      return Promise.resolve(
        new Response(JSON.stringify({ working_dir: '/w', truncated: false, items: files }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.pathname.endsWith(`/attachments/${NOTES}/content`)) {
      return Promise.resolve(
        new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      );
    }
    return Promise.resolve(
      new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <SessionFilesProvider sessionId={SESSION} revision="r1">
              <PaneProvider>
                <MessageView message={message} showReasoning={false} />
                <SplitPane />
              </PaneProvider>
            </SessionFilesProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeAll(() => {
  // jsdom has no object URLs; an <img> only needs a string to point at.
  URL.createObjectURL = vi.fn(() => 'blob:http://hub.test/picture');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  requests.length = 0;
});

describe('the run folder in a reply’s words', () => {
  it('is drawn as the file’s own name, in text, inline code and links, for both folder names', () => {
    expect(hideRunPaths(`I saved it to: ${OUT}/flying_cat.png`)).toBe(
      'I saved it to: flying_cat.png',
    );
    expect(hideRunPaths(`see \`${OUT}/flying_cat.png\`.`)).toBe('see `flying_cat.png`.');
    expect(hideRunPaths(`[test.txt](majlis/runs/${RUN}/out/test.txt)`)).toBe(
      '[test.txt](test.txt)',
    );
    expect(hideRunPaths(`file:///x/.majlis/runs/${RUN}/in/sub/a.pdf`)).toBe('sub/a.pdf');
  });

  it('leaves fenced code, a bare folder and other paths as written', () => {
    const fenced = `\`\`\`\n${OUT}/x.png\n\`\`\`\nthen ${OUT}/y.png`;
    expect(hideRunPaths(fenced)).toBe(`\`\`\`\n${OUT}/x.png\n\`\`\`\nthen y.png`);
    expect(hideRunPaths(`the folder ${OUT}/ is empty`)).toBe(`the folder ${OUT}/ is empty`);
    expect(hideRunPaths('/etc/hosts and src/runs/x/out/y')).toBe('/etc/hosts and src/runs/x/out/y');
  });
});

describe('a reply that carries files', () => {
  it('draws its picture, fetched with the bearer header, and opens it beside the chat', async () => {
    mount(reply(`I generated the image and saved it to: ${OUT}/flying_cat.png`, [catBlock]), [
      attachment(CAT, 'flying_cat.png', 'image/png', 'image'),
    ]);
    const picture = await screen.findByTestId('message-image');
    expect(picture).toHaveAttribute('src', 'blob:http://hub.test/picture');
    expect(picture).toHaveAttribute('alt', 'flying_cat.png');
    expect(requests.find((r) => r.path === `/api/v1/attachments/${CAT}/content`)?.auth).toBe(
      'Bearer t',
    );

    // The words name the file, not the machine's folder, and the name opens it.
    const body = screen.getByTestId('message-assistant');
    expect(body.textContent).not.toContain('/.corehub/');
    expect(body.textContent).not.toContain('/data/workspaces');
    const mention = await screen.findByTestId('file-mention');
    expect(mention.textContent).toBe('flying_cat.png');

    fireEvent.click(await screen.findByRole('button', { name: 'Open flying_cat.png' }));
    expect(await screen.findByTestId('file-view')).toBeInTheDocument();
  });

  it('shows any other file as its name, which opens the same preview', async () => {
    mount(reply('Here are your notes.', [notesBlock]), [
      attachment(NOTES, 'notes.txt', 'text/plain', 'text'),
    ]);
    const row = await screen.findByTestId('message-attachments');
    const chip = await within(row).findByTestId('attachment-open');
    expect(chip.textContent).toBe('notes.txt');
    fireEvent.click(chip);
    expect(await screen.findByText('hello')).toBeInTheDocument();
  });

  it('means its own file by a name an older file of the conversation also has', async () => {
    mount(reply(`Saved as \`${OUT}/flying_cat.png\``, [catBlock]), [
      { ...attachment(OLD_CAT, 'flying_cat.png', 'image/png', 'image'), message_id: 'm-old' },
      attachment(CAT, 'flying_cat.png', 'image/png', 'image'),
    ]);
    const mention = await screen.findByTestId('file-mention');
    expect(mention.textContent).toBe('flying_cat.png');
    fireEvent.click(mention);
    await screen.findByTestId('file-view');
    expect(requests.some((r) => r.path === `/api/v1/attachments/${OLD_CAT}/content`)).toBe(false);
  });
});
