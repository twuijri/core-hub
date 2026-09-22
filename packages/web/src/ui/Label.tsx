/**
 * A label, and the `Field` that binds one to its control.
 *
 * The label is Radix's, so clicking it focuses the control even when the control is one of
 * our button-based fakes (the checkbox, the switch). `Field` owns the ids: the hint is
 * `aria-describedby`, never part of the accessible name, and the error replaces the hint
 * rather than sitting beside it, so a screen reader hears one explanation, not two.
 *
 * There is no required asterisk. A glyph that is hidden from the accessibility tree still
 * lands in the label's text, which then no longer matches the words on the screen; the
 * control's own `required` already carries the meaning, and the label stays exactly what
 * it says.
 */
import { Label as RadixLabel } from 'radix-ui';
import { useId, type ReactNode } from 'react';

export function Label({
  htmlFor,
  children,
  className = '',
}: {
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <RadixLabel.Root
      className={`mj-label ${className}`}
      {...(htmlFor === undefined ? {} : { htmlFor })}
    >
      {children}
    </RadixLabel.Root>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Receives the id to put on the control and the ids to describe it with. */
  children: (props: { id: string; 'aria-describedby': string | undefined }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className={`mj-field-row ${className}`} data-invalid={error ? 'true' : undefined}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': describedBy })}
      {error ? (
        <p id={errorId} className="mj-field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mj-field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
