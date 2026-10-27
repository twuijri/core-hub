/**
 * The newest message, and the way back to it (owner, 2026-10-27): a transcript opens at its
 * newest message and follows new ones while the reader is there; one scrolled up into history
 * is never pulled down, and a small ↓ button floats above the composer until they are back.
 * The hooks are `useFollowBottom` / `useScrolledAway` (src/chat/followBottom.ts), the button
 * `JumpToLatest`; the channel conversation using them is covered in channel-send.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY, useFollowBottom, useScrolledAway } from '../src/chat/followBottom.js';
import { JumpToLatest } from '../src/chat/JumpToLatest.js';
import { I18nProvider } from '../src/i18n/context.js';

/** The page's resize observers, fired by the test as a growing transcript would. */
const observers: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    observers.push(() => this.callback());
  }
  observe() {}
  disconnect() {}
}
const grow = () => act(() => observers.forEach((fire) => fire()));

let height = 5000;
const VIEW = 600;

function Harness() {
  const content = useRef<HTMLDivElement>(null);
  const follow = useFollowBottom(content);
  const away = useScrolledAway(content);
  return (
    <I18nProvider language="en">
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <div ref={content} />
      </div>
      <JumpToLatest shown={away} onJump={follow} />
    </I18nProvider>
  );
}

function mount() {
  render(<Harness />);
  const scroller = screen.getByTestId('scroller');
  return {
    scroller,
    scrollTo(top: number) {
      scroller.scrollTop = top;
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
    },
  };
}

beforeEach(() => {
  observers.length = 0;
  height = 5000;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a transcript opens at its newest message', () => {
  it('is scrolled to the bottom on open, with no ↓ button', () => {
    const { scroller } = mount();
    expect(scroller.scrollTop).toBe(5000);
    expect(screen.queryByTestId('jump-latest')).toBeNull();
  });

  it('follows a message arriving while the reader is at the bottom', () => {
    const { scroller } = mount();
    height = 5600;
    grow();
    expect(scroller.scrollTop).toBe(5600);
  });

  it('never pulls down a reader who scrolled up into history', () => {
    const { scroller, scrollTo } = mount();
    scrollTo(1000);
    height = 5600;
    grow();
    expect(scroller.scrollTop).toBe(1000);
  });
});

describe('“Jump to latest”', () => {
  it('shows once the reader is well above the bottom, not a few pixels up', () => {
    const { scrollTo } = mount();
    scrollTo(5000 - VIEW - AWAY + 40);
    expect(screen.queryByTestId('jump-latest')).toBeNull();
    scrollTo(1000);
    expect(screen.getByTestId('jump-latest')).toHaveAccessibleName('Jump to the latest message');
  });

  it('brings the newest message back, hides, and the transcript follows again', () => {
    const { scroller, scrollTo } = mount();
    scrollTo(1000);
    fireEvent.click(screen.getByTestId('jump-latest'));
    expect(scroller.scrollTop).toBe(5000);
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(screen.queryByTestId('jump-latest')).toBeNull();
    height = 5600;
    grow();
    expect(scroller.scrollTop).toBe(5600);
  });

  it('disappears when the reader scrolls back down by themselves', () => {
    const { scrollTo } = mount();
    scrollTo(1000);
    expect(screen.getByTestId('jump-latest')).toBeInTheDocument();
    scrollTo(5000 - VIEW);
    expect(screen.queryByTestId('jump-latest')).toBeNull();
  });
});
