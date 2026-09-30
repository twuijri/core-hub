// The tab tells the hub which conversation the person is looking at (DECISIONS §149), so a reply
// finishing there is not pushed to their phone: visible and focused says `viewing { session_id }`
// and repeats it; hidden, blurred, another page or a closed conversation says `null`.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted: Array<{ session_id: string | null }> = [];
const handlers = new Map<string, () => void>();
const fakeSocket = {
  connected: true,
  emit: (event: string, payload: { session_id: string | null }) => {
    if (event === 'viewing') emitted.push(payload);
  },
  on: (event: string, handler: () => void) => void handlers.set(event, handler),
  off: (event: string) => void handlers.delete(event),
};
vi.mock('../src/realtime/context.js', () => ({
  useRealtime: () => ({ socket: () => fakeSocket, state: 'connected', epoch: 0 }),
}));

const { useViewing, VIEWING_HEARTBEAT_MS } = await import('../src/realtime/useViewing.js');

function Chat({ id }: { id: string | null }) {
  useViewing(id);
  return null;
}

let visible: DocumentVisibilityState = 'visible';
let focused = true;
beforeEach(() => {
  emitted.length = 0;
  visible = 'visible';
  focused = true;
  fakeSocket.connected = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the tab says which conversation the person is looking at', () => {
  it('says it on open, repeats it, and takes it back when hidden, blurred or closed', () => {
    vi.useFakeTimers();
    const view = render(<Chat id="S1" />);
    expect(emitted).toEqual([{ session_id: 'S1' }]);
    // The heartbeat keeps it alive on the hub (45 s there).
    act(() => void vi.advanceTimersByTime(VIEWING_HEARTBEAT_MS));
    expect(emitted).toEqual([{ session_id: 'S1' }, { session_id: 'S1' }]);

    // Another window in front: no longer looking.
    focused = false;
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(emitted.at(-1)).toEqual({ session_id: null });
    // Hidden and blurred stays `null`, said once, and the heartbeat says nothing.
    visible = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    act(() => void vi.advanceTimersByTime(VIEWING_HEARTBEAT_MS));
    expect(emitted.filter((each) => each.session_id === null)).toHaveLength(1);

    // Back in front.
    visible = 'visible';
    focused = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(emitted.at(-1)).toEqual({ session_id: 'S1' });

    // After a reconnect the hub knows nothing: said again.
    const before = emitted.length;
    act(() => handlers.get('connect')?.());
    expect(emitted.length).toBe(before + 1);

    // Another conversation, then none.
    view.rerender(<Chat id="S2" />);
    expect(emitted.slice(-2)).toEqual([{ session_id: null }, { session_id: 'S2' }]);
    view.unmount();
    expect(emitted.at(-1)).toEqual({ session_id: null });
  });

  it('says nothing while the page is not in front, or the socket is down', () => {
    visible = 'hidden';
    render(<Chat id="S1" />);
    expect(emitted).toEqual([]);
    cleanup();
    visible = 'visible';
    fakeSocket.connected = false;
    render(<Chat id="S1" />);
    expect(emitted).toEqual([]);
  });
});
