/**
 * A search result opens the conversation at the message that matched (owner, 2026-09-23:
 * «يوديني للكلمه داخل المحادثه»). The browser journey (e2e 21) proves the jump; this proves
 * the pieces it stands on: the link, the paging back to an old message, the words marked
 * inside Markdown without breaking it, and a transcript that is not pulled to the bottom.
 */
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { Transcript } from '../src/chat/MessageView.js';
import { turnsOf } from '../src/chat/turns.js';
import {
  AROUND,
  MAX_OLDER_PAGES,
  chatHref,
  pageBackUntil,
  readAnchor,
  type MessagePageLike,
} from '../src/chat/anchor.js';
import { useFollowBottom } from '../src/chat/followBottom.js';
import type { Message } from '../src/types.js';

afterEach(cleanup);

const ID = '01J8QK3ZR2W7M5N4P6T8V9X0MA';
const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';

describe('the link a search result carries', () => {
  it('names the message and the words, and reads them back', () => {
    const href = chatHref(SESSION, ID, ' زعفران ');
    expect(href).toBe(`/chat/${SESSION}?m=${ID}&q=${encodeURIComponent('زعفران')}`);
    const params = new URL(href, 'http://x').searchParams;
    expect(readAnchor(params)).toEqual({ messageId: ID, query: 'زعفران' });
  });

  it('opens the conversation plainly when the hub names no message', () => {
    expect(chatHref(SESSION, null, 'زعفران')).toBe(`/chat/${SESSION}`);
    expect(chatHref(SESSION, undefined)).toBe(`/chat/${SESSION}`);
  });

  it('ignores an `m` that is not a message id', () => {
    expect(readAnchor(new URLSearchParams('m=<script>&q=x'))).toBeNull();
    expect(readAnchor(new URLSearchParams('q=x'))).toBeNull();
  });
});

describe('an old message is paged in before the chat is shown', () => {
  // 1000 messages, newest page first; ids are their positions.
  const all = Array.from({ length: 1000 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}` }));
  const olderThan =
    (limit: number) =>
    async (before: string): Promise<MessagePageLike<{ id: string }>> => {
      const end = all.findIndex((m) => m.id === before);
      const start = Math.max(0, end - limit);
      return { items: all.slice(start, end), has_more: start > 0 };
    };
  const first = { items: all.slice(900), has_more: true };

  it('asks for the page before the oldest one it holds until the anchor is there', async () => {
    const older = vi.fn(olderThan(200));
    const { items, has_more, pages } = await pageBackUntil(first, 'm0650', older);
    expect(older).toHaveBeenCalledTimes(2);
    expect(older).toHaveBeenNthCalledWith(1, 'm0900');
    expect(older).toHaveBeenNthCalledWith(2, 'm0700');
    expect(items[0]?.id).toBe('m0500');
    expect(items.at(-1)?.id).toBe('m0999');
    // Oldest first, no gaps, no repeats.
    expect(items.map((m) => m.id)).toEqual(all.slice(500).map((m) => m.id));
    expect({ has_more, pages }).toEqual({ has_more: true, pages: 2 });
  });

  it('asks for nothing when the anchor is already in the newest page', async () => {
    const older = vi.fn(olderThan(200));
    await pageBackUntil(first, 'm0950', older);
    expect(older).not.toHaveBeenCalled();
  });

  it('stops where the conversation begins, and after a bounded number of pages', async () => {
    const gone = vi.fn(olderThan(200));
    const back = await pageBackUntil(first, 'deleted', gone);
    expect(gone).toHaveBeenCalledTimes(5);
    expect(back.items).toHaveLength(1000);
    expect(back.has_more).toBe(false);

    const tiny = vi.fn(olderThan(1));
    await pageBackUntil(first, 'deleted', tiny);
    expect(tiny).toHaveBeenCalledTimes(MAX_OLDER_PAGES);
  });

  it('opens with history on both sides: one page more when the anchor is near the top', async () => {
    const older = vi.fn(olderThan(200));
    // m0705 lands 5 messages from the top of the page that brings it in.
    const near = await pageBackUntil(first, 'm0705', older, { around: AROUND });
    expect(older).toHaveBeenCalledTimes(2);
    expect(near.items[0]?.id).toBe('m0500');

    const far = vi.fn(olderThan(200));
    await pageBackUntil(first, 'm0800', far, { around: AROUND });
    expect(far).toHaveBeenCalledTimes(1);
  });
});

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-23T10:00:00Z',
    updated_at: '2026-09-23T10:00:00Z',
    session_id: SESSION,
    room_id: null,
    seq: 1,
    author: { kind: 'user', id: null, name: '', avatar: null },
    content: [],
    reasoning: null,
    tool_calls: [],
    run_id: null,
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
    ...partial,
  } as Message;
}

describe('the anchored message: flagged, and the words marked inside it', () => {
  const USER = '01J8QK3ZR2W7M5N4P6T8V9X0U1';
  const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0A1';
  const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0A2';
  const messages = [
    message({ id: USER, role: 'user', seq: 1, content: [{ type: 'text', text: 'عن الزعفران' }] }),
    message({
      id: AGENT,
      role: 'assistant',
      seq: 2,
      author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
      content: [
        {
          type: 'text',
          text: '**الزعفران** غالٍ.\n\n- زعفران أول\n- ثانٍ\n\n```js\nconst Zafaran = "زعفران";\n```',
        },
      ],
    }),
    message({
      id: OTHER,
      role: 'assistant',
      seq: 3,
      author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
      content: [{ type: 'text', text: 'زعفران هنا لا يُعلَّم' }],
    }),
  ];

  const mount = (anchor: { messageId: string; query: string } | null) =>
    render(
      <I18nProvider language="ar">
        <PaneProvider>
          <div className="chat-turns">
            <Transcript turns={turnsOf(messages)} showReasoning runs={{}} anchor={anchor} />
          </div>
        </PaneProvider>
      </I18nProvider>,
    );

  it('every message says which it is; only the anchored one is flagged', () => {
    const { container } = mount({ messageId: AGENT, query: 'زعفران' });
    for (const id of [USER, AGENT, OTHER])
      expect(container.querySelector(`[data-message-id="${id}"]`)).not.toBeNull();
    const flagged = container.querySelectorAll('[data-anchored="true"]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.getAttribute('data-message-id')).toBe(AGENT);
  });

  it('marks the words through Markdown and code, and leaves the structure alone', () => {
    const { container } = mount({ messageId: AGENT, query: 'زعفران' });
    const agent = container.querySelector(`[data-message-id="${AGENT}"]`) as HTMLElement;
    const marks = [...agent.querySelectorAll('mark.msg-hit')].map((m) => m.textContent);
    // In bold, in a list item, and in the code block's string.
    expect(marks).toEqual(['زعفران', 'زعفران', 'زعفران']);
    expect(agent.querySelector('strong mark')).not.toBeNull();
    expect(agent.querySelectorAll('li')).toHaveLength(2);
    const code = agent.querySelector('pre code') as HTMLElement;
    expect(code.textContent).toBe('const Zafaran = "زعفران";\n');
    // Only the anchored message is marked.
    const other = container.querySelector(`[data-message-id="${OTHER}"]`) as HTMLElement;
    expect(other.querySelector('mark')).toBeNull();
  });

  it("marks the person's own words too, case-insensitively", () => {
    const { container } = mount({ messageId: USER, query: 'الزعفران' });
    const user = container.querySelector(`[data-message-id="${USER}"]`) as HTMLElement;
    expect(user.querySelector('mark.msg-hit')?.textContent).toBe('الزعفران');
    expect(user.textContent).toContain('عن الزعفران');
  });

  it('marks nothing and flags nothing without an anchor', () => {
    const { container } = mount(null);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.querySelector('[data-anchored]')).toBeNull();
  });
});

describe('an anchored open is not pulled to the bottom', () => {
  function Scroller({ hold }: { hold: boolean }) {
    const content = useRef<HTMLDivElement>(null);
    useFollowBottom(content, { hold });
    return (
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <div ref={content}>transcript</div>
      </div>
    );
  }
  const tallScroller = () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 5000,
    });
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    };
  };

  it('opens at the bottom as before, and stays put while holding', () => {
    const undo = tallScroller();
    try {
      const plain = render(<Scroller hold={false} />);
      expect(plain.getByTestId('scroller').scrollTop).toBe(5000);
      plain.unmount();
      const held = render(<Scroller hold />);
      expect(held.getByTestId('scroller').scrollTop).toBe(0);
    } finally {
      undo();
    }
  });
});
