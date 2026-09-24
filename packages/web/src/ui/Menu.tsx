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
import type { ReactElement, ReactNode } from 'react';
import { IconCheck } from './icons.js';
import { Tooltip } from './Tooltip.js';

export function Menu({
  trigger,
  tooltip,
  children,
  align = 'start',
  testId,
}: {
  /** The button, already styled by the caller; Radix only adds behaviour to it. */
  trigger: ReactElement;
  /** Words for our tooltip. It wraps the trigger here so the two behaviours compose. */
  tooltip?: string | undefined;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  testId?: string | undefined;
}) {
  return (
    <DropdownMenu.Root>
      <Tooltip label={tooltip}>
        <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ch-menu glass"
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
  tone,
  children,
}: {
  icon?: ReactNode;
  onSelect(): void;
  /** An item that destroys something says so in its colour, as `ContextMenuItem` does. */
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item className="ch-menu-item" data-tone={tone} onSelect={() => onSelect()}>
      {icon}
      <span>{children}</span>
    </DropdownMenu.Item>
  );
}

/** The hairline between two groups of items; decorative, skipped by the keyboard. */
export function MenuSeparator() {
  return <DropdownMenu.Separator className="ch-menu-sep" />;
}

/** A line of explanation inside a menu; not an item, so it is skipped by the keyboard. */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="ch-menu-note">{children}</p>;
}

/**
 * A menu row that is one of a set — the overflow of a segmented control, say. It carries
 * the same check mark as the select's chosen row, so "this is the current one" looks the
 * same wherever it is said.
 */
export function MenuChoice({
  checked,
  icon,
  disabled,
  onSelect,
  children,
}: {
  checked: boolean;
  icon?: ReactNode;
  disabled?: boolean | undefined;
  onSelect(): void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.CheckboxItem
      className="ch-menu-item ch-menu-choice"
      checked={checked}
      disabled={disabled ?? false}
      onSelect={() => onSelect()}
    >
      {icon}
      <span className="ch-menu-choice-label">{children}</span>
      <DropdownMenu.ItemIndicator className="ch-menu-check">
        <IconCheck size={14} />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>
  );
}
