/**
 * Our checkbox, over Radix `Checkbox`.
 *
 * A native `<input type="checkbox">` is painted by the OS: it ignores our accent, keeps its
 * own focus ring, and in dark mode stays a bright light box in a dark row. This is a real
 * button with `role="checkbox"`, so it takes our tokens, our one focus ring, and the same
 * check mark the select and the menus use.
 */
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { IconCheck } from './icons.js';

export function Checkbox({
  checked,
  onChange,
  label,
  labelHidden = false,
  hint,
  disabled = false,
  testId,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  /** Rendered beside the box and wired as its label; pass a string for the plain case. */
  label: ReactNode;
  /** Keep the label as the accessible name but off the screen (a cell in a table). */
  labelHidden?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="mj-check-row">
      <RadixCheckbox.Root
        id={id}
        className="mj-check"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        data-testid={testId}
      >
        <RadixCheckbox.Indicator className="mj-check-mark">
          <IconCheck size={12} />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <label className={labelHidden ? 'sr-only' : 'mj-check-label'} htmlFor={id}>
        <span>{label}</span>
        {hint !== undefined && <span className="mj-check-hint">{hint}</span>}
      </label>
    </div>
  );
}
