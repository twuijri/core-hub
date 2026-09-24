/**
 * Scrolling back through a long conversation (owner, 2026-09-24). The browser journey
 * (e2e zzz-chat-history) proves it in a real layout; this proves the pieces: older pages
 * join the transcript without repeats, the reader's place is kept to the pixel, and the
 * next page is asked for only when the top comes near — once, and not again after a failure.
 */
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrate, initialChat, prependOlder, reduce } from '../src/chat/transcript.js';
import {
  PREFETCH_PX,
  keepPlace,
  useLoadOlderOnScroll,
  type LoadOlder,
} from '../src/chat/olderMessages.js';
import type { Envelope } from '../src/realtime/envelope.js';
import type { Message, SessionDetail } from '../src/types.js';

afterEach(cleanup);

const S = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const msg = (seq: number): Message => ({
  id: `m${String(seq).padStart(4, '0')}`,
  profile: 'default',
  owner_id: 'u',
  created_at: 't',
  updated_at: 't',
  session_id: S,
  room_id: null,
  seq,
  role: seq % 2 ? 'user' : 'assistant',
  author: { kind: 'user', id: null, name: '', avatar: null },
  content: [{ type: 'text', text: `رسالة ${seq}` }],
  reasoning: null,
  tool_calls: [],
  run_id: null,
  status: 'complete',
  mentions: [],
  handoff: null,
  usage: null,
  reply_to_message_id: null,
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const detail = {
  id: S,
  profile: 'default',
  status: 'idle',
  context: null,
  runs: [],
  pending_approvals: [],
} as unknown as SessionDetail;

describe('older pages join the transcript', () => {
  it('hydrate records whether older messages exist', () => {
    const state = hydrate(initialChat(), detail, range(151, 250), {
      hasOlder: true,
      pagedBack: false,
    });
    expect(state.hasOlder).toBe(true);
    expect(state.pagedBack).toBe(false);
    // Without the page flags a transcript is complete, as before.
    expect(hydrate(initialChat(), detail, range(1, 3)).hasOlder).toBe(false);
  });

  it('prepends in order, without repeats, and learns where the conversation starts', () => {
    let state = hydrate(initialChat(), detail, range(151, 250), {
      hasOlder: true,
      pagedBack: false,
    });
    state = prependOlder(state, { items: range(51, 150), has_more: true });
    expect(state.messages.map((m) => m.seq)).toEqual(range(51, 250).map((m) => m.seq));
    expect(state).toMatchObject({ hasOlder: true, pagedBack: true });

    // A page that overlaps what is held (a resync in between) adds only what is new.
    state = prependOlder(state, { items: range(1, 60), has_more: false });
    expect(state.messages).toHaveLength(250);
    expect(new Set(state.messages.map((m) => m.id)).size).toBe(250);
    expect(state.messages[0]?.seq).toBe(1);
    expect(state.hasOlder).toBe(false);

    // An empty page is the start.
    const start = prependOlder({ ...state, hasOlder: true }, { items: [], has_more: false });
    expect(start.hasOlder).toBe(false);
  });

  it('a page that does not reach past what is held leaves hasOlder alone', () => {
    const state = hydrate(initialChat(), detail, range(1, 50), {
      hasOlder: true,
      pagedBack: true,
    });
    const after = prependOlder(state, { items: range(20, 30), has_more: false });
    expect(after.hasOlder).toBe(true);
    expect(after.messages).toHaveLength(50);
  });

  it('a live message after paging back lands at the bottom, history intact', () => {
    let state = hydrate(initialChat(), detail, range(101, 200), {
      hasOlder: true,
      pagedBack: false,
    });
    state = prependOlder(state, { items: range(1, 100), has_more: false });
    const created: Envelope = {
      event: 'message.created',
      namespace: '/rt/sessions',
      profile: 'default',
      ts: 't',
      seq: 1,
      payload: { message: msg(201) },
    };
    state = reduce(state, created, S);
    expect(state.messages.map((m) => m.seq)).toEqual(range(1, 201).map((m) => m.seq));
    expect(state.hasOlder).toBe(false);
  });
});

/** Give an element a fixed box, as a real layout would. */
function box(node: Element, top: () => number, height = 100) {
  node.getBoundingClientRect = () =>
    ({ top: top(), bottom: top() + height, height, left: 0, right: 0, width: 0 }) as DOMRect;
}

describe('the reader keeps their place while a page is added above', () => {
  it('moves the scroller by exactly how far the top message was pushed down', () => {
    const scroller = document.createElement('div');
    const content = document.createElement('div');
    scroller.append(content);
    document.body.append(scroller);
    box(scroller, () => 0, 600);
    scroller.scrollTop = 40;

    // Two messages; the second is the one at the top of the screen.
    const first = document.createElement('div');
    first.dataset.messageId = 'm0101';
    const second = document.createElement('div');
    second.dataset.messageId = 'm0102';
    content.append(first, second);
    let shift = 0;
    box(first, () => -140 + shift);
    box(second, () => -40 + shift);

    keepPlace(content, scroller, () => {
      // A page of older messages, 2400 px tall, joins above.
      const older = document.createElement('div');
      older.dataset.messageId = 'm0001';
      content.prepend(older);
      box(older, () => -2540 + shift, 2400);
      shift = 2400;
    });
    expect(scroller.scrollTop).toBe(40 + 2400);
    scroller.remove();
  });

  it('does nothing more when the browser already kept the place', () => {
    const scroller = document.createElement('div');
    const content = document.createElement('div');
    scroller.append(content);
    box(scroller, () => 0, 600);
    scroller.scrollTop = 10;
    const only = document.createElement('div');
    only.dataset.messageId = 'm0001';
    content.append(only);
    box(only, () => 5);
    keepPlace(content, scroller, () => content.prepend(document.createElement('div')));
    expect(scroller.scrollTop).toBe(10);
  });
});

function Harness({ load, enabled = true }: { load: LoadOlder; enabled?: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  useLoadOlderOnScroll(content, edge, enabled, load);
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div ref={content}>
        <div ref={edge} data-testid="edge" />
        <div data-message-id="m0001" />
      </div>
    </div>
  );
}

describe('the next page is asked for when the top comes near', () => {
  // A transcript tall enough to scroll: nothing is asked for on open.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  });
  afterEach(() => vi.restoreAllMocks());

  const mount = (load: LoadOlder, enabled = true) => {
    const view = render(<Harness load={load} enabled={enabled} />);
    const scroller = view.getByTestId('scroller');
    const edge = view.getByTestId('edge');
    box(scroller, () => 0, 600);
    let edgeTop = -3000;
    box(edge, () => edgeTop, 40);
    return {
      view,
      scroller,
      scrollEdgeTo(top: number) {
        edgeTop = top;
        scroller.dispatchEvent(new Event('scroll'));
      },
    };
  };

  it('not while the top is far above the screen; once it is within reach', async () => {
    const load = vi.fn<LoadOlder>(async () => false);
    const { scrollEdgeTo } = mount(load);
    scrollEdgeTo(-2000);
    expect(load).not.toHaveBeenCalled();
    scrollEdgeTo(-PREFETCH_PX + 50);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks once per page, however many scroll events arrive while it loads', async () => {
    let finish: (loaded: boolean) => void = () => {};
    const load = vi.fn<LoadOlder>(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { scrollEdgeTo } = mount(load);
    scrollEdgeTo(-100);
    scrollEdgeTo(-50);
    scrollEdgeTo(0);
    expect(load).toHaveBeenCalledTimes(1);
    // The page landed and the top is still within reach (a fast fling): the next one.
    finish(true);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('asks at once when the transcript is too short to scroll', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    const load = vi.fn<LoadOlder>(async () => false);
    render(<Harness load={load} />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed page by itself', async () => {
    const load = vi.fn<LoadOlder>(async () => false);
    const { scrollEdgeTo } = mount(load);
    scrollEdgeTo(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while disabled (no older messages, or an anchored open not yet made)', () => {
    const load = vi.fn<LoadOlder>(async () => true);
    const { scrollEdgeTo } = mount(load, false);
    scrollEdgeTo(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('hands the page to keepPlace, so what is added lands above the reader', async () => {
    const load = vi.fn<LoadOlder>(async (wrap) => {
      const apply = vi.fn();
      wrap(apply);
      expect(apply).toHaveBeenCalledTimes(1);
      return false;
    });
    const { scrollEdgeTo } = mount(load);
    scrollEdgeTo(0);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });
});
