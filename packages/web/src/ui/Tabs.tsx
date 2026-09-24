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
      <RadixTabs.List className="mj-tabs" aria-label={label}>
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            className="mj-tab"
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

/**
 * A panel. `keepMounted` keeps an inactive panel on the page, hidden (`data-state=inactive`
 * in kit.css), for a panel whose state must survive a switch — the chat's transcript, its
 * scroll position and its composer draft while the person looks at the Trajectory tab.
 * `flow` makes the panel box itself disappear from layout, so its children lay out as
 * children of the page around it.
 */
export function TabPanel({
  value,
  children,
  keepMounted = false,
  flow = false,
  testId,
}: {
  value: string;
  children: ReactNode;
  keepMounted?: boolean;
  flow?: boolean;
  testId?: string;
}) {
  return (
    <RadixTabs.Content
      className={`mj-tab-panel${flow ? ' mj-tab-panel-flow' : ''}`}
      value={value}
      {...(keepMounted ? { forceMount: true as const } : {})}
      data-testid={testId}
    >
      {children}
    </RadixTabs.Content>
  );
}

/**
 * Tabs whose list and panels are apart on the page — the chat's tab row sits in its header
 * row, its panels below. `TabsFrame` holds the state and renders as the element it is given
 * (`asChild`), `TabList` is the row.
 */
export function TabsFrame({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange(next: string): void;
  /** One element, which becomes the frame. */
  children: ReactNode;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} asChild>
      {children}
    </RadixTabs.Root>
  );
}

export function TabList({
  items,
  label,
  testId,
  compact = false,
}: {
  items: readonly TabItem[];
  label: string;
  testId?: string;
  /** No rule under the row and no margin: for a row that sits among other controls. */
  compact?: boolean;
}) {
  return (
    <RadixTabs.List
      className={`mj-tabs${compact ? ' mj-tabs-compact' : ''}`}
      aria-label={label}
      data-testid={testId}
    >
      {items.map((item) => (
        <RadixTabs.Trigger
          key={item.value}
          className="mj-tab"
          value={item.value}
          disabled={item.disabled ?? false}
          data-testid={testId ? `${testId}-${item.value}` : undefined}
        >
          {item.label}
        </RadixTabs.Trigger>
      ))}
    </RadixTabs.List>
  );
}
