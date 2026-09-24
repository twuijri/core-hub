/**
 * Our switch, over Radix `Switch`: a setting that takes effect the moment it is flipped.
 *
 * A checkbox is a choice you confirm; a switch is a state you change. The thumb travels on
 * the inline axis, so it slides the correct way in Arabic without a second rule, and the
 * travel is `--ch-motion-fast`, which is 0 ms when the person asked the OS for less motion.
 */
import { Switch as RadixSwitch } from 'radix-ui';
import { useId, type ReactNode } from 'react';

export function Switch({
  checked,
  onChange,
  label,
  hint,
  labelHidden = false,
  disabled = false,
  testId,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: ReactNode;
  hint?: ReactNode;
  labelHidden?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="ch-switch-row">
      <label className={labelHidden ? 'sr-only' : 'ch-switch-label'} htmlFor={id}>
        <span>{label}</span>
        {hint !== undefined && <span className="ch-switch-hint">{hint}</span>}
      </label>
      <RadixSwitch.Root
        id={id}
        className="ch-switch"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        data-testid={testId}
      >
        <RadixSwitch.Thumb className="ch-switch-thumb" />
      </RadixSwitch.Root>
    </div>
  );
}
