/**
 * Our alert dialog, over Radix `AlertDialog`: the modal that interrupts to ask one
 * question whose answer cannot be undone.
 *
 * It differs from `Dialog` on purpose: no ✕, Escape means "no", and the default focus sits
 * on the safe answer. `useConfirm()` in ConfirmDialog.tsx is the imperative shape built on
 * this one — a screen that wants `if (await ask(…))` uses that; a screen that already has
 * the open state uses this.
 */
import { AlertDialog as RadixAlertDialog } from 'radix-ui';
import type { ReactNode } from 'react';

export function AlertDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'danger' | 'default';
  onConfirm(): void;
  testId?: string;
}) {
  return (
    <RadixAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className="mj-overlay" />
        <RadixAlertDialog.Content className="mj-dialog mj-dialog-sm" data-testid={testId}>
          <RadixAlertDialog.Title className="mj-dialog-title">{title}</RadixAlertDialog.Title>
          {body !== undefined && (
            <RadixAlertDialog.Description className="mj-dialog-body">
              {body}
            </RadixAlertDialog.Description>
          )}
          <div className="mj-dialog-actions">
            <RadixAlertDialog.Cancel asChild>
              <button
                type="button"
                className="mj-btn mj-btn-secondary mj-btn-md"
                data-testid="confirm-no"
              >
                <span className="mj-btn-label">{cancelLabel}</span>
              </button>
            </RadixAlertDialog.Cancel>
            <RadixAlertDialog.Action asChild>
              <button
                type="button"
                className={`mj-btn mj-btn-${tone === 'default' ? 'primary' : 'danger'} mj-btn-md`}
                onClick={onConfirm}
                data-testid="confirm-yes"
              >
                <span className="mj-btn-label">{confirmLabel}</span>
              </button>
            </RadixAlertDialog.Action>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
