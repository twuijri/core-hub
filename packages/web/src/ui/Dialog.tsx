/**
 * Our modal, over Radix `Dialog` — and the reason the native `<dialog>` is banned.
 *
 * Radix owns the focus trap, the scroll lock, Escape, and returning focus to whatever
 * opened it; this owns the surface, the sizes and the footer shape. Every dialog in the
 * client is this one, so the shadow, the radius and the spacing cannot drift apart.
 *
 * `Sheet` is the same primitive anchored to an edge instead of the middle — a drawer. It
 * slides along the inline axis, so in Arabic it comes from the correct side with no second
 * rule.
 */
import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { IconClose } from './icons.js';
import { Button } from './Button.js';

export type DialogSize = 'sm' | 'md' | 'lg' | 'full';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeLabel,
  testId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  /** One sentence under the title. It is the dialog's description, not a paragraph of body. */
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** Accessible name of the ✕. Required, because an unlabelled close is a mystery. */
  closeLabel: string;
  testId?: string;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ch-overlay" />
        <RadixDialog.Content className={`ch-dialog ch-dialog-${size}`} data-testid={testId}>
          <div className="ch-dialog-head">
            <RadixDialog.Title className="ch-dialog-title">{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={closeLabel}
                icon={<IconClose size={16} />}
              />
            </RadixDialog.Close>
          </div>
          {description !== undefined && (
            <RadixDialog.Description className="ch-dialog-body">
              {description}
            </RadixDialog.Description>
          )}
          {children !== undefined && <div className="ch-dialog-content">{children}</div>}
          {footer !== undefined && <div className="ch-dialog-actions">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  footer,
  side = 'inline-end',
  closeLabel,
  testId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Which edge it comes from. The inline sides follow the reading direction. */
  side?: 'inline-start' | 'inline-end' | 'block-end';
  closeLabel: string;
  testId?: string;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ch-overlay" />
        <RadixDialog.Content className="ch-sheet" data-side={side} data-testid={testId}>
          <div className="ch-dialog-head">
            <RadixDialog.Title className="ch-dialog-title">{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={closeLabel}
                icon={<IconClose size={16} />}
              />
            </RadixDialog.Close>
          </div>
          <div className="ch-sheet-body">{children}</div>
          {footer !== undefined && <div className="ch-dialog-actions">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
