/**
 * Our dropdown menu, over Radix `DropdownMenu` (owner decision, 2026-09-22: stand on a
 * proven headless layer, keep our own skin).
 *
 * The rule this file exists to enforce: **a screen never imports a Radix primitive.** It
 * imports this wrapper, which is the only place the tokens are applied, so restyling every
 * menu in the client is one edit here. Radix brings the focus trap, the roving tabindex,
 * the typeahead, Escape/outside-click and the RTL arrow keys — all of which we would
 * otherwise get wrong by hand.
 */
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

export function Menu({
  trigger,
  children,
  align = 'start',
  testId,
}: {
  /** The button, already styled by the caller; Radix only adds behaviour to it. */
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  testId?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="mj-menu glass"
          align={align}
          side="top"
          sideOffset={8}
          collisionPadding={8}
          data-testid={testId}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  icon,
  onSelect,
  children,
}: {
  icon?: ReactNode;
  onSelect(): void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item className="mj-menu-item" onSelect={() => onSelect()}>
      {icon}
      <span>{children}</span>
    </DropdownMenu.Item>
  );
}

/** A line of explanation inside a menu; not an item, so it is skipped by the keyboard. */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="mj-menu-note">{children}</p>;
}
