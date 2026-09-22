/**
 * Our context menu, over Radix `ContextMenu`: the right-click menu of a row.
 *
 * It wears the same surface, the same rows and the same check mark as the dropdown in
 * Menu.tsx — a person should not be able to tell from the paint which one they opened.
 * It is never the only way to reach an action: every item here also exists as a visible
 * control, because a right-click is invisible to touch and to the keyboard.
 */
import { ContextMenu as RadixContextMenu } from 'radix-ui';
import type { ReactNode } from 'react';

export function ContextMenu({
  trigger,
  children,
  testId,
}: {
  /** The region that answers the right-click. */
  trigger: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <RadixContextMenu.Root>
      <RadixContextMenu.Trigger asChild>{trigger}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className="mj-menu glass"
          collisionPadding={8}
          data-testid={testId}
        >
          {children}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}

export function ContextMenuItem({
  icon,
  onSelect,
  tone = 'default',
  disabled = false,
  children,
}: {
  icon?: ReactNode;
  onSelect(): void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <RadixContextMenu.Item
      className="mj-menu-item"
      data-tone={tone === 'danger' ? 'danger' : undefined}
      disabled={disabled}
      onSelect={() => onSelect()}
    >
      {icon}
      <span>{children}</span>
    </RadixContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <RadixContextMenu.Separator className="mj-menu-sep" />;
}
