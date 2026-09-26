/**
 * Our tooltip, over Radix `Tooltip` — and the reason the native `title` attribute is
 * banned from screens (docs/clients/DESIGN.md §UI policy).
 *
 * `title=` is the browser's tooltip: it appears after a delay nobody chose, in the OS's
 * own box, ignores our tokens, never shows in dark mode the way the rest of the page does,
 * and is invisible to touch and to the keyboard. This shows the same words in our surface,
 * on hover *and* on keyboard focus, and disappears on Escape.
 *
 * A tooltip is never the only place a label lives: the trigger keeps its `aria-label`, so
 * a screen reader hears it whether or not the tooltip opens.
 */
import { Direction, Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

export function Tooltip({
  label,
  children,
  side = 'top',
}: {
  /** The words. Nothing renders when it is empty — an empty tooltip is noise. */
  label: ReactNode;
  /** The trigger. One element: Radix clones it rather than wrapping it in a box. */
  children: ReactElement;
  side?: 'top' | 'bottom' | 'inline-start' | 'inline-end';
}) {
  // `inline-start`/`inline-end` follow the reading direction: the end is the left in Arabic.
  const rtl = Direction.useDirection() === 'rtl';
  if (label === null || label === undefined || label === '') return children;
  const physical =
    side === 'inline-start'
      ? rtl
        ? 'right'
        : 'left'
      : side === 'inline-end'
        ? rtl
          ? 'left'
          : 'right'
        : side;
  return (
    // The provider lives here so a tooltip works wherever it is rendered, including in a
    // unit test that mounts one component. Nesting providers is allowed by Radix.
    <RadixTooltip.Provider delayDuration={350} skipDelayDuration={200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="ch-tooltip"
            side={physical}
            sideOffset={6}
            collisionPadding={8}
          >
            {label}
            <RadixTooltip.Arrow className="ch-tooltip-arrow" width={10} height={5} />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
