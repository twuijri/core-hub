/**
 * "Type a new name", in the imperative shape a list row wants — and the reason
 * `window.prompt` is banned from screens (docs/clients/DESIGN.md §UI policy).
 *
 * `prompt()` is the browser's own modal: it says the page's hostname, it cannot label its
 * field in the person's language, it has no direction of its own (an Arabic title typed
 * into it reads backwards), and it freezes the tab.
 *
 * The surface is `Dialog.tsx` — one modal in the client, not two. This adds only the
 * promise and the one field, so a call site keeps `const name = await ask(…)` instead of
 * growing its own open state.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { Field } from './Label.js';
import { Input } from './Input.js';

export interface PromptRequest {
  title: string;
  /** The field's label. Never a placeholder standing in for one. */
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  /** One sentence under the title, when the act needs explaining. */
  description?: ReactNode;
}

interface Pending extends PromptRequest {
  value: string;
}

/** Resolves with the typed text, or `null` when the person backed out. */
export function usePrompt(): {
  ask(request: PromptRequest): Promise<string | null>;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);
  const settled = useRef<((answer: string | null) => void) | null>(null);

  const ask = useCallback(
    (request: PromptRequest) =>
      new Promise<string | null>((resolve) => {
        settled.current = resolve;
        setPending({ ...request, value: request.initialValue ?? '' });
      }),
    [],
  );

  const close = (answer: string | null) => {
    settled.current?.(answer);
    settled.current = null;
    setPending(null);
  };

  const submit = () => {
    const typed = pending?.value.trim() ?? '';
    // An empty field means "I changed my mind", not "name it nothing".
    close(typed === '' ? null : typed);
  };

  const dialog = pending && (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
      title={pending.title}
      {...(pending.description === undefined ? {} : { description: pending.description })}
      size="sm"
      closeLabel={t('common.cancel')}
      testId="prompt-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} data-testid="prompt-confirm">
            {pending.confirmLabel ?? t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={pending.label}>
        {(props) => (
          <Input
            {...props}
            autoFocus
            dir="auto"
            value={pending.value}
            data-testid="prompt-field"
            onChange={(event) =>
              setPending((current) => current && { ...current, value: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
      </Field>
    </Dialog>
  );

  return { ask, dialog };
}
