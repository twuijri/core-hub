/**
 * The transcript follows what the agent writes, while the person is at the bottom.
 *
 * Owner, 2026-09-23: after scrolling up and back down, a reply kept growing under the edge
 * of the screen. The page scrolled only when a *message* arrived, not while one grew. Now
 * the scroller is pinned to the bottom whenever the transcript changes size and the person
 * was already there; scrolling up unpins it, and coming back to the bottom pins it again.
 * Sending a message pins it too: what one just said is where one wants to be.
 *
 * `hold`: while the chat is showing one message a search opened it at (anchor.ts), the
 * transcript is not pulled to the bottom — neither when it opens nor as it loads or grows.
 * The caller lets go (`hold` false) once the person sends, or scrolls to the bottom
 * themselves, which `onBottom` reports.
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

export function useFollowBottom(
  content: RefObject<HTMLElement | null>,
  { hold = false, onBottom }: { hold?: boolean; onBottom?: () => void } = {},
): () => void {
  const pinned = useRef(!hold);
  const scroller = useRef<HTMLElement | null>(null);
  const held = useRef(hold);
  held.current = hold;
  const reportBottom = useRef(onBottom);
  reportBottom.current = onBottom;

  // Where `toBottom` last left the scroller. The scroll event it causes is dispatched on the
  // next frame, and a message that arrived in between (the agent's reply starting right
  // after the person's own) has already made the page taller: that event must not read as
  // the person scrolling away. Only a scroll *above* this point does.
  const placed = useRef<number | null>(null);

  const toBottom = useCallback(() => {
    const at = scroller.current;
    if (!at) return;
    at.scrollTop = at.scrollHeight;
    placed.current = at.scrollTop;
  }, []);

  useEffect(() => {
    const node = content.current;
    const at = scrollParent(node);
    scroller.current = at;
    if (!node || !at) return;
    // A window scroll reports on `window`, an element's on the element.
    const target: HTMLElement | Window = at === document.scrollingElement ? window : at;
    const onScroll = () => {
      const near = at.scrollHeight - at.scrollTop - at.clientHeight < NEAR;
      const ours = placed.current !== null && at.scrollTop >= placed.current - 1;
      pinned.current = near || (pinned.current && ours);
      if (near && held.current) reportBottom.current?.();
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (pinned.current && !held.current) toBottom();
          });
    observer?.observe(node);
    if (!held.current) toBottom();
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
