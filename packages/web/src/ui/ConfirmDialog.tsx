/**
 * "Are you sure", in the imperative shape a list row wants — and the reason
 * `window.confirm` is banned from screens (docs/clients/DESIGN.md §UI policy).
 *
 * `confirm()` is the browser's own modal: it says the page's hostname, it cannot say what
 * is being deleted in the person's language beside our own type, it freezes the tab, and
 * it looks like a phishing warning.
 *
 * The surface is `AlertDialog.tsx` — one alert dialog in the client, not two. This adds
 * only the promise, so a call site keeps `if (await ask(…))` instead of growing its own
 * open state.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';
import { AlertDialog } from './AlertDialog.js';

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
    <AlertDialog
      open
      // Escape, the overlay, or the browser back button: all of them mean "no".
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
      title={pending.title}
      {...(pending.body === undefined ? {} : { body: pending.body })}
      confirmLabel={pending.confirmLabel ?? t('common.delete')}
      cancelLabel={t('common.cancel')}
      tone={pending.tone ?? 'danger'}
      onConfirm={() => close(true)}
      testId="confirm-dialog"
    />
  );

  return { ask, dialog };
}
