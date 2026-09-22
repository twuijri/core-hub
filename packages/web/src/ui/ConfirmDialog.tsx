/**
 * Our "are you sure", over Radix `AlertDialog` — and the reason `window.confirm` is banned
 * from screens (docs/clients/DESIGN.md §UI policy).
 *
 * `confirm()` is the browser's own modal: it says the page's hostname, it cannot say what
 * is being deleted in the person's language beside our own type, it freezes the tab, and
 * it looks like a phishing warning. This is a dialog of ours, with the focus trapped, the
 * destructive action styled as destructive, Escape to cancel, and focus returned to
 * whatever opened it.
 *
 * `useConfirm()` keeps the imperative shape the old call sites had — `if (await ask(…))` —
 * so a list row does not have to grow its own dialog state.
 */
import { AlertDialog } from 'radix-ui';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  /** The destructive button's words; defaults to the shared "delete". */
  confirmLabel?: string;
  tone?: 'danger' | 'default';
}

interface Pending extends ConfirmRequest {
  resolve(answer: boolean): void;
}

export function useConfirm(): {
  ask(request: ConfirmRequest): Promise<boolean>;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);
  const settled = useRef<((answer: boolean) => void) | null>(null);

  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        settled.current = resolve;
        setPending({ ...request, resolve });
      }),
    [],
  );

  const close = (answer: boolean) => {
    settled.current?.(answer);
    settled.current = null;
    setPending(null);
  };

  const dialog = pending && (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        // Escape, the overlay, or the browser back button: all of them mean "no".
        if (!open) close(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="mj-overlay" />
        <AlertDialog.Content className="mj-dialog" data-testid="confirm-dialog">
          <AlertDialog.Title className="mj-dialog-title">{pending.title}</AlertDialog.Title>
          {pending.body !== undefined && (
            <AlertDialog.Description className="mj-dialog-body">
              {pending.body}
            </AlertDialog.Description>
          )}
          <div className="mj-dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button" className="btn" data-testid="confirm-no">
                {t('common.cancel')}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className={pending.tone === 'default' ? 'btn btn-primary' : 'btn btn-danger'}
                onClick={() => close(true)}
                data-testid="confirm-yes"
              >
                {pending.confirmLabel ?? t('common.delete')}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );

  return { ask, dialog };
}
