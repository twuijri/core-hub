/**
 * Our radio group, over Radix `RadioGroup`.
 *
 * A native `<input type="radio">` is painted by the OS and keeps its own focus ring; this
 * is a real `role="radiogroup"` with our tokens, our one ring and Radix's roving tabindex
 * (arrows move the choice, which is what a radio group is for).
 *
 * `Segmented` is the one *row of choices*; this is the stacked form, for a set whose
 * options carry a sentence of explanation each.
 */
import { RadioGroup } from 'radix-ui';
import { useId, type ReactNode } from 'react';

export interface RadioOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Radio({
  label,
  value,
  onChange,
  options,
  disabled = false,
  testId,
}: {
  /** The group's accessible name. */
  label: string;
  value: string | null;
  onChange(next: string): void;
  options: readonly RadioOption[];
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <RadioGroup.Root
      className="ch-radio-group"
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onValueChange={onChange}
      data-testid={testId}
    >
      {options.map((option) => (
        <div className="ch-radio-row" key={option.value}>
          <RadioGroup.Item
            className="ch-radio"
            value={option.value}
            id={`${id}-${option.value}`}
            disabled={option.disabled ?? false}
          >
            <RadioGroup.Indicator className="ch-radio-dot" />
          </RadioGroup.Item>
          <label className="ch-radio-label" htmlFor={`${id}-${option.value}`}>
            <span>{option.label}</span>
            {option.hint !== undefined && <span className="ch-radio-hint">{option.hint}</span>}
          </label>
        </div>
      ))}
    </RadioGroup.Root>
  );
}
