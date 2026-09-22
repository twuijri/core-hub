/**
 * Our popover, over Radix `Popover`: the anchored sheet used by the working-folder picker
 * and anything else that hangs off a chip. Radix owns the focus trap, the return of focus
 * to the trigger, Escape and outside-click; we own the surface. Screens import this wrapper,
 * never `radix-ui` (owner decision, 2026-09-22).
 */
import { Popover as RadixPopover } from 'radix-ui';
import type { ReactNode } from 'react';

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  testId,
}: {
  trigger: ReactNode;
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
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
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
