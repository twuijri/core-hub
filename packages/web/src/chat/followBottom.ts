/**
 * The transcript follows what the agent writes, while the person is at the bottom.
 *
 * Owner, 2026-09-23: after scrolling up and back down, a reply kept growing under the edge
 * of the screen. The page scrolled only when a *message* arrived, not while one grew. Now
 * the scroller is pinned to the bottom whenever the transcript changes size and the person
 * was already there; scrolling up unpins it, and coming back to the bottom pins it again.
 * Sending a message pins it too: what one just said is where one wants to be.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** How close to the bottom still counts as "at the bottom", in pixels. */
const NEAR = 80;

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let at = node?.parentElement ?? null; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

export function useFollowBottom(content: RefObject<HTMLElement | null>): () => void {
  const pinned = useRef(true);
  const scroller = useRef<HTMLElement | null>(null);

  const toBottom = useCallback(() => {
    const at = scroller.current;
    if (at) at.scrollTop = at.scrollHeight;
  }, []);

  useEffect(() => {
    const node = content.current;
    const at = scrollParent(node);
    scroller.current = at;
    if (!node || !at) return;
    // A window scroll reports on `window`, an element's on the element.
    const target: HTMLElement | Window = at === document.scrollingElement ? window : at;
    const onScroll = () => {
      pinned.current = at.scrollHeight - at.scrollTop - at.clientHeight < NEAR;
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (pinned.current) toBottom();
          });
    observer?.observe(node);
    toBottom();
    return () => {
      target.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [content, toBottom]);

  return useCallback(() => {
    pinned.current = true;
    toBottom();
  }, [toBottom]);
}
