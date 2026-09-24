/**
 * Our select, over Radix `Select` — the one dropdown shape in the client.
 *
 * A native `<select>` cannot be styled to match the composer on every platform and paints
 * its own popup; Radix gives us the listbox behaviour (typeahead, Home/End, Escape,
 * RTL arrows, scroll locking) and leaves the paint to our tokens. Screens import this,
 * never `radix-ui` (owner decision, 2026-09-22).
 */
import { Select as RadixSelect } from 'radix-ui';
import { Fragment, type ReactNode } from 'react';
import { IconCheck, IconChevron } from './icons.js';
import { Tooltip } from './Tooltip.js';

export interface SelectOption {
  value: string;
  label: string;
  /**
   * One line saying what choosing this actually does. A list of near-synonyms ("ask",
   * "always ask", "no approvals") is a list of guesses until each one says what it
   * changes, so any option set where the labels alone are not self-evident carries these
   * (owner, 2026-09-22).
   */
  description?: string;
  /** Drawn before the label, in the list and — for the chosen one — in the trigger. */
  icon?: ReactNode;
  /** Paints the option, and the trigger while it is the chosen one. */
  tone?: 'danger' | 'warning';
  /** Options that share a group name are listed under it, with a heading. */
  group?: string;
  disabled?: boolean;
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
  const triggerNode = (
    <RadixSelect.Trigger
      className="ch-select"
      aria-label={label}
      data-tone={chosen?.tone}
      data-testid={testId}
    >
      {chosen?.icon ?? icon}
      <RadixSelect.Value>
        <span className="truncate">{chosen?.label ?? placeholder ?? label}</span>
      </RadixSelect.Value>
      <RadixSelect.Icon className="ch-select-chevron">
        <IconChevron size={12} />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );

  return (
    <RadixSelect.Root
      value={value ?? EMPTY}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next === EMPTY ? null : next)}
    >
      <Tooltip label={title ?? label}>
        {/* A disabled trigger receives no pointer events, so when it is disabled the
            tooltip — which is where the reason lives — hangs off a focusable wrapper. */}
        {disabled ? (
          <span tabIndex={0} className="ch-select-wrap" data-testid={`${testId ?? 'select'}-wrap`}>
            {triggerNode}
          </span>
        ) : (
          triggerNode
        )}
      </Tooltip>
      <RadixSelect.Portal>
        <RadixSelect.Content className="ch-select-menu glass" position="popper" sideOffset={6}>
          <RadixSelect.Viewport>
            {placeholder !== undefined && <Item option={{ value: EMPTY, label: placeholder }} />}
            {groupsOf(shown).map(([group, items]) => (
              <Fragment key={group ?? '__ungrouped__'}>
                {group === null ? (
                  items.map((option) => <Item key={option.value} option={option} />)
                ) : (
                  <RadixSelect.Group>
                    <RadixSelect.Label className="ch-select-group">{group}</RadixSelect.Label>
                    {items.map((option) => (
                      <Item key={option.value} option={option} />
                    ))}
                  </RadixSelect.Group>
                )}
              </Fragment>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

/** Keep the caller's order, but put the options of one group together under its heading. */
function groupsOf(
  options: readonly SelectOption[],
): Array<[string | null, readonly SelectOption[]]> {
  const out: Array<[string | null, SelectOption[]]> = [];
  for (const option of options) {
    const key = option.group ?? null;
    const last = out[out.length - 1];
    if (last && last[0] === key) last[1].push(option);
    else out.push([key, [option]]);
  }
  return out;
}

function Item({ option }: { option: SelectOption }) {
  return (
    <RadixSelect.Item
      className="ch-select-item"
      data-tone={option.tone}
      data-described={option.description ? 'true' : undefined}
      value={option.value}
      {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
    >
      {option.icon !== undefined && (
        <span className="ch-select-item-icon" aria-hidden>
          {option.icon}
        </span>
      )}
      <span className="ch-select-item-body">
        <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
        {/* Outside `ItemText`, so the trigger keeps the label alone (Radix renders
            `ItemText` there) and the explanation stays in the list where it belongs. */}
        {option.description !== undefined && (
          <span className="ch-select-item-hint">{option.description}</span>
        )}
      </span>
      <RadixSelect.ItemIndicator className="ch-select-item-check">
        <IconCheck size={14} />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}
