/**
 * Scrolling back through a long conversation (owner, 2026-09-24).
 *
 * The chat opens with the newest page of messages. When the person scrolls near the top,
 * the page before it is fetched (`sessions.listMessages` with `before` = the oldest message
 * held) and joins the transcript above — without moving what the person is reading: the
 * message at the top of the screen stays exactly where it was (`keepPlace`). Nothing here
 * touches the bottom, so a reply streaming there never pulls a reader out of history
 * (followBottom.ts only follows a person who is at the bottom).
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { scrollParent } from './followBottom.js';

/** How far above the screen the top of the transcript may still be when the next page is asked for. */
export const PREFETCH_PX = 600;

/** One page of older messages when scrolling back (the newest page is 100 as well). */
export const SCROLL_PAGE = 100;

/** Where the scroller's visible area begins, in viewport coordinates. */
function viewTop(scroller: HTMLElement): number {
  return scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
}

/**
 * Run `apply` (which adds messages above) and keep the message that was at the top of the
 * screen at the same place on it. The change is flushed synchronously, so nothing is painted
 * in between; measuring before and after makes it idempotent with the browser's own scroll
 * anchoring, which may already have done part of the work.
 */
export function keepPlace(content: HTMLElement, scroller: HTMLElement, apply: () => void): void {
  const top = viewTop(scroller);
  let marker: HTMLElement | null = null;
  for (const node of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.getBoundingClientRect().bottom > top) {
      marker = node;
      break;
    }
  }
  const id = marker?.dataset.messageId;
  const before = marker?.getBoundingClientRect().top;
  flushSync(apply);
  if (!id || before === undefined) return;
  const again = content.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!again) return;
  const moved = again.getBoundingClientRect().top - before;
  if (Math.abs(moved) >= 0.5) scroller.scrollTop += moved;
}

/** Fetch the page before the oldest message held; `wrap` commits it (keepPlace). */
export type LoadOlder = (wrap: (apply: () => void) => void) => Promise<boolean>;

/**
 * Ask for older messages whenever the top row (`edge`) comes within `PREFETCH_PX` of the
 * screen while `enabled`. Scrolling is the only trigger — the transcript opening at the
 * bottom does not load anything — except for a transcript too short to scroll, which asks
 * at once. After a page lands the check runs again, so a fast fling to the top keeps
 * loading; a failed page does not retry by itself: the row's button calls what this
 * returns, which loads the next page at once, keeping the reader's place the same way.
 */
export function useLoadOlderOnScroll(
  content: RefObject<HTMLElement | null>,
  edge: RefObject<HTMLElement | null>,
  enabled: boolean,
  load: LoadOlder,
): () => void {
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const node = content.current;
    const scroller = scrollParent(node);
    if (!enabled || !node || !scroller) return;
    const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
    let busy = false;
    let disposed = false;
    const check = () => {
      const row = edge.current;
      if (busy || disposed || !enabledRef.current || !row) return;
      if (row.getBoundingClientRect().bottom < viewTop(scroller) - PREFETCH_PX) return;
      busy = true;
      void loadRef
        .current((apply) => keepPlace(node, scroller, apply))
        .then((loaded) => {
          busy = false;
          if (loaded) check();
        });
    };
    target.addEventListener('scroll', check, { passive: true });
    if (scroller.scrollHeight <= scroller.clientHeight + 1) check();
    return () => {
      disposed = true;
      target.removeEventListener('scroll', check);
    };
  }, [content, edge, enabled]);

  return useCallback(() => {
    const node = content.current;
    const scroller = scrollParent(node);
    if (!node || !scroller) return;
    void loadRef.current((apply) => keepPlace(node, scroller, apply));
  }, [content]);
}
