/**
 * The one text field, and the one multi-line field beside it (`Textarea`).
 *
 * Both take the same three heights as every other control, the same border and radius
 * tokens, and the same one focus ring. `invalid` is a state of the field, never a colour a
 * screen paints by hand, and it wires `aria-invalid` so the state is announced and not only
 * seen.
 */
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { ReactNode } from 'react';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  inputSize?: InputSize;
  invalid?: boolean;
  /** A glyph inside the field, at its inline start (a magnifier on a search box). */
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { inputSize = 'md', invalid = false, icon, className = '', ...rest },
  ref,
) {
  const field = (
    <input
      ref={ref}
      className={`ch-field ch-field-${inputSize} ${icon ? 'ch-field-with-icon' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      data-invalid={invalid ? 'true' : undefined}
      {...rest}
    />
  );
  if (!icon) return field;
  return (
    <span className="ch-field-shell">
      <span className="ch-field-icon" aria-hidden>
        {icon}
      </span>
      {field}
    </span>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className = '', rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`ch-field ch-textarea ${className}`}
      aria-invalid={invalid || undefined}
      data-invalid={invalid ? 'true' : undefined}
      {...rest}
    />
  );
});
