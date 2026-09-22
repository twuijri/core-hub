/**
 * Our select, over Radix `Select` — the one dropdown shape in the client.
 *
 * A native `<select>` cannot be styled to match the composer on every platform and paints
 * its own popup; Radix gives us the listbox behaviour (typeahead, Home/End, Escape,
 * RTL arrows, scroll locking) and leaves the paint to our tokens. Screens import this,
 * never `radix-ui` (owner decision, 2026-09-22).
 */
import { Select as RadixSelect } from 'radix-ui';
import type { ReactNode } from 'react';
import { IconCheck, IconChevron } from './icons.js';

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value: given,
  onValueChange,
  options,
  label,
  placeholder,
  icon,
  disabled = false,
  title,
  testId,
}: {
  /** `null` means "nothing chosen"; Radix wants a string, so it maps to the empty option. */
  value: string | null;
  onValueChange(value: string | null): void;
  options: readonly SelectOption[];
  /** Accessible name; never rendered as visible text inside the trigger. */
  label: string;
  /** The option that means "no choice". Omit for a select where one must be chosen. */
  placeholder?: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string | undefined;
  testId?: string;
}) {
  // An empty string is "nothing chosen", not a nameless option.
  const value = given === '' ? null : given;
  const EMPTY = '__default__';
  // A value the list does not know (a session running a model the catalogue no longer has)
  // must still be readable and re-selectable, not silently blank.
  const known = options.some((option) => option.value === value);
  const shown: readonly SelectOption[] =
    value !== null && !known ? [{ value, label: value }, ...options] : options;
  const chosen = shown.find((option) => option.value === value);
  return (
    <RadixSelect.Root
      value={value ?? EMPTY}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next === EMPTY ? null : next)}
    >
      <RadixSelect.Trigger
        className="mj-select"
        aria-label={label}
        title={title ?? label}
        data-testid={testId}
      >
        {icon}
        <RadixSelect.Value>
          <span className="truncate">{chosen?.label ?? placeholder ?? label}</span>
        </RadixSelect.Value>
        <RadixSelect.Icon>
          <IconChevron size={12} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="mj-select-menu glass" position="popper" sideOffset={6}>
          <RadixSelect.Viewport>
            {placeholder !== undefined && <Item value={EMPTY} label={placeholder} />}
            {shown.map((option) => (
              <Item key={option.value} value={option.value} label={option.label} />
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

function Item({ value, label }: { value: string; label: string }) {
  return (
    <RadixSelect.Item className="mj-select-item" value={value}>
      <RadixSelect.ItemText>{label}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator>
        <IconCheck size={14} />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}
