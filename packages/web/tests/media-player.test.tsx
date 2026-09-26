/**
 * Media in chat (decision §98): a video or a sound plays in the side file panel and in a reply,
 * from a one-hour stream address, so the player asks the hub for byte ranges and can seek — the
 * page never reads the whole file into itself first.
 *
 * - a working-folder video opens in the panel as a player whose `src` is the ticket from
 *   `sessions.createFileStream` (asked with the file's path); the bytes route is never read;
 * - an audio attachment plays from `sessions.createAttachmentStream`;
 * - a reply's file whose stored type says nothing but whose name is `.mp4` plays in place;
 * - a format the browser cannot play falls back: the name in a reply, a note in the panel.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { isPlayable, mediaTypeOf } from '../src/chat/InlineMedia.js';
import { MessageView } from '../src/chat/MessageView.js';
import { ThemeProvider } from '../src/design/theme.js';
import { SessionFilesProvider, useOpenFile } from '../src/files/context.js';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { SplitPane } from '../src/shell/SplitPane.js';
import type { Message, SessionFile } from '../src/types.js';

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const SONG = '01J8QK3ZR2W7M5N4P6T8V9X0SG';
const CLIP = '01J8QK3ZR2W7M5N4P6T8V9X0CP';
const FILE_TICKET = 'f'.repeat(64);
const ATTACHMENT_TICKET = 'a'.repeat(64);

function file(over: Partial<SessionFile> & { name: string }): SessionFile {
  const path = over.path === undefined ? over.name : over.path;
  return {
    key: over.attachment_id ? `attachment:${over.attachment_id}` : `path:${path}`,
    path,
    attachment_id: null,
    message_id: null,
    mime: 'video/mp4',
    preview: 'video',
    size_bytes: 4 * 1024 * 1024 * 1024,
    preview_max_bytes: 64 * 1024 * 1024 * 1024,
    modified_at: '2026-09-27T01:00:00.000Z',
    sources: ['working_dir'],
    tool_call_ids: [],
    ...over,
  };
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

const requests: Array<{ method: string; path: string; body: string | null }> = [];

function Opener({ fileKey }: { fileKey: string }) {
  const open = useOpenFile();
  return (
    <>
      <button type="button" onClick={() => open?.(fileKey)}>
        open it
      </button>
      <SplitPane />
    </>
  );
}

function mount(files: SessionFile[], children: ReactNode) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(String(request ? request.url : input));
    const body = request ? await request.clone().text() : ((init?.body as string) ?? null);
    requests.push({ method: request?.method ?? init?.method ?? 'GET', path: url.pathname, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.pathname.endsWith('/files')) {
      return json({ working_dir: '/w', truncated: false, items: files });
    }
    if (url.pathname === `/api/v1/sessions/${SESSION}/files/stream`) {
      return json(
        { url: `/api/v1/file-streams/${FILE_TICKET}`, expires_at: '2026-09-27T02:00:00Z' },
        201,
      );
    }
    if (url.pathname.endsWith('/stream')) {
      return json(
        {
          url: `/api/v1/attachment-streams/${ATTACHMENT_TICKET}`,
          expires_at: '2026-09-27T02:00:00Z',
        },
        201,
      );
    }
    return json({ error: 'not in this test', code: 'not_found' }, 404);
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <SessionFilesProvider sessionId={SESSION} revision="r1">
              <PaneProvider>{children}</PaneProvider>
            </SessionFilesProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  requests.length = 0;
});

describe('which files play (§98)', () => {
  it('knows a video or a sound by its type, or by its name when the type says nothing', () => {
    expect(isPlayable('video/webm')).toBe('video');
    expect(isPlayable('audio/ogg')).toBe('audio');
    expect(isPlayable('application/octet-stream', 'render.MP4')).toBe('video');
    expect(isPlayable(null, 'voice.m4a')).toBe('audio');
    expect(isPlayable('application/pdf', 'scan.pdf')).toBeNull();
    expect(mediaTypeOf('application/octet-stream', 'take.mov')).toBe('video/quicktime');
  });
});

describe('the side file panel plays media from a stream address', () => {
  it('plays a working-folder video from its ticket, without reading the bytes', async () => {
    mount(
      [file({ name: 'renders/final.mp4', path: 'renders/final.mp4' })],
      <Opener fileKey="path:renders/final.mp4" />,
    );
    fireEvent.click(screen.getByText('open it'));
    const video = await screen.findByTestId('file-video');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('src', `/api/v1/file-streams/${FILE_TICKET}`);
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    const asked = requests.find((r) => r.path === `/api/v1/sessions/${SESSION}/files/stream`);
    expect(asked?.method).toBe('POST');
    expect(JSON.parse(asked?.body ?? '{}')).toEqual({ path: 'renders/final.mp4' });
    // Four gigabytes are never fetched into the page.
    expect(requests.some((r) => r.path.endsWith('/files/content'))).toBe(false);
    // A format this browser cannot decode: a note, and Download stays.
    fireEvent.error(video);
    expect(await screen.findByText(/cannot play this file/)).toBeTruthy();
    expect(screen.getByTestId('file-download')).toBeTruthy();
  });

  it('plays an audio attachment from the attachment’s ticket', async () => {
    mount(
      [
        file({
          name: 'voice-note.ogg',
          path: null,
          attachment_id: SONG,
          mime: 'audio/ogg',
          preview: 'audio',
          sources: ['attachment'],
          modified_at: null,
        }),
      ],
      <Opener fileKey={`attachment:${SONG}`} />,
    );
    fireEvent.click(screen.getByText('open it'));
    const audio = await screen.findByTestId('file-audio');
    expect(audio.tagName).toBe('AUDIO');
    expect(audio).toHaveAttribute('src', `/api/v1/attachment-streams/${ATTACHMENT_TICKET}`);
    expect(requests.some((r) => r.path === `/api/v1/attachments/${SONG}/stream`)).toBe(true);
  });
});

describe('a reply plays media in place', () => {
  function reply(content: Message['content']): Message {
    return {
      id: 'm-reply',
      profile: 'default',
      owner_id: 'u1',
      created_at: '2026-09-27T01:00:00Z',
      updated_at: '2026-09-27T01:00:00Z',
      session_id: SESSION,
      room_id: null,
      seq: 2,
      author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
      content: [{ type: 'text', text: 'Here is the render.' }, ...content],
      reasoning: null,
      tool_calls: [],
      run_id: null,
      status: 'complete',
      mentions: [],
      handoff: null,
      usage: null,
      reply_to_message_id: null,
    } as unknown as Message;
  }

  it('plays a file whose name says video even when its stored type does not', async () => {
    mount(
      [],
      <MessageView
        message={reply([
          {
            type: 'file',
            attachment_id: CLIP,
            url: `/api/v1/attachments/${CLIP}/content`,
            name: 'render.mp4',
            mime: 'application/octet-stream',
            size_bytes: 10,
          } as never,
        ])}
        showReasoning={false}
      />,
    );
    const video = await screen.findByTestId('message-video');
    expect(video).toHaveAttribute('src', `/api/v1/attachment-streams/${ATTACHMENT_TICKET}`);
    expect(video).toHaveAttribute('aria-label', 'render.mp4');
    // The browser says it cannot play it: the player steps aside, the name stays.
    fireEvent.error(video);
    expect(screen.queryByTestId('message-video')).toBeNull();
    expect(screen.getByText('render.mp4')).toBeTruthy();
  });
});
