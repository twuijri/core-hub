/**
 * Our popover, over Radix `Popover`: the anchored sheet used by the working-folder picker
 * and anything else that hangs off a chip. Radix owns the focus trap, the return of focus
 * to the trigger, Escape and outside-click; we own the surface. Screens import this wrapper,
 * never `radix-ui` (owner decision, 2026-09-22).
 */
import { Popover as RadixPopover } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { Tooltip } from './Tooltip.js';

export function Popover({
  trigger,
  tooltip,
  children,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  testId,
}: {
  /**
   * The button. One element: Radix clones it, so it must not be wrapped by the caller —
   * pass `tooltip` instead and the two behaviours compose here, in the right order.
   */
  trigger: ReactElement;
  tooltip?: string | undefined;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  testId?: string;
}) {
  return (
    <RadixPopover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <Tooltip label={tooltip}>
        <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      </Tooltip>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="mj-popover glass"
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={8}
          data-testid={testId}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
