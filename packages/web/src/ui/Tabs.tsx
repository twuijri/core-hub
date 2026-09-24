/**
 * Our tabs, over Radix `Tabs`: sections of one page, switched in place.
 *
 * `Segmented` is the row of *choices* that changes what a control will do; this is the row
 * of *sections* that changes what the page shows, and it carries the tab semantics
 * (`role="tablist"`, arrow keys, `aria-controls`) that a segmented control must not claim.
 *
 */
import { Tabs as RadixTabs } from 'radix-ui';
import type { ReactNode } from 'react';

export interface TabItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export function Tabs({
  value,
  onValueChange,
  items,
  label,
  children,
  testId,
}: {
  value: string;
  onValueChange(next: string): void;
  items: readonly TabItem[];
  /** The tablist's accessible name. */
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} data-testid={testId}>
      <RadixTabs.List className="ch-tabs" aria-label={label}>
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            className="ch-tab"
            value={item.value}
            disabled={item.disabled ?? false}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RadixTabs.Content className="ch-tab-panel" value={value}>
      {children}
    </RadixTabs.Content>
  );
}
