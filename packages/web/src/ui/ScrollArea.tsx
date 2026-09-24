/**
 * Our scroll area, over Radix `ScrollArea`: one scrollbar for the whole client instead of
 * a different one on every platform.
 *
 * Radix keeps the native scrolling (wheel, trackpad momentum, keyboard, and the browser's
 * own scroll anchoring) and only replaces the *bar*, so nothing about the behaviour is
 * re-implemented. The bar is on the inline axis, so it sits on the correct edge in Arabic.
 */
import { ScrollArea as RadixScrollArea } from 'radix-ui';
import type { ReactNode } from 'react';

export function ScrollArea({
  children,
  maxHeight,
  className = '',
  testId,
}: {
  children: ReactNode;
  /** Any CSS length; without it the area takes the height its parent gives it. */
  maxHeight?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <RadixScrollArea.Root className={`ch-scroll ${className}`} type="hover" data-testid={testId}>
      <RadixScrollArea.Viewport
        className="ch-scroll-view"
        style={maxHeight === undefined ? undefined : { maxBlockSize: maxHeight }}
      >
        {children}
      </RadixScrollArea.Viewport>
      <RadixScrollArea.Scrollbar className="ch-scroll-bar" orientation="vertical">
        <RadixScrollArea.Thumb className="ch-scroll-thumb" />
      </RadixScrollArea.Scrollbar>
      <RadixScrollArea.Scrollbar className="ch-scroll-bar" orientation="horizontal">
        <RadixScrollArea.Thumb className="ch-scroll-thumb" />
      </RadixScrollArea.Scrollbar>
      <RadixScrollArea.Corner />
    </RadixScrollArea.Root>
  );
}
