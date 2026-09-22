/**
 * The sidebar as a kit, not as a drawing.
 *
 * `shell/Sidebar.tsx` decides *what* is in the sidebar (NAVIGATION §1); these pieces decide
 * what a sidebar *is* — the glass rail, the brand row, the groups, the rows with their
 * icon-and-label geometry, the scrolling middle and the footer. A second sidebar (the
 * phone drawer, a future room rail) is then assembled, not redrawn.
 *
 * `SidebarRow` renders whatever element the caller needs — a router `NavLink`, a button —
 * through `render`, so navigation stays the router's job and the paint stays here.
 */
import type { ReactNode } from 'react';

export function SidebarFrame({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <nav className="mj-sidebar glass" aria-label={label} data-testid={testId}>
      {children}
    </nav>
  );
}

export function SidebarBrand({ mark, name }: { mark: ReactNode; name: ReactNode }) {
  return (
    <div className="mj-sidebar-brand">
      <span className="mj-sidebar-mark" aria-hidden>
        {mark}
      </span>
      <span className="mj-sidebar-name">{name}</span>
    </div>
  );
}

export function SidebarGroup({
  children,
  label,
  testId,
}: {
  children: ReactNode;
  /** A visible heading for the group; omit for a group that needs none. */
  label?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="mj-sidebar-group" data-testid={testId}>
      {label !== undefined && <p className="mj-sidebar-group-label">{label}</p>}
      {children}
    </div>
  );
}

/** The scrolling middle: the only part of the sidebar that grows. */
export function SidebarBody({ children }: { children: ReactNode }) {
  return <div className="mj-sidebar-body">{children}</div>;
}

export function SidebarFooter({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <footer className="mj-sidebar-foot" data-testid={testId}>
      {children}
    </footer>
  );
}

export function SidebarRow({
  icon,
  label,
  emphasis = 'normal',
  trailing,
  render,
}: {
  icon?: ReactNode;
  label: ReactNode;
  /** `primary` is the one filled row at the top; `normal` is everything else. */
  emphasis?: 'primary' | 'normal';
  /**
   * What sits at the row's end: a count, a state dot. It follows the label and so lands
   * on the left in Arabic and the right in English without a rule of its own.
   */
  trailing?: ReactNode;
  /** Renders the row as whatever element it must be: a link, a button. */
  render(props: { className: string; children: ReactNode }): ReactNode;
}) {
  const children = (
    <>
      {icon}
      <span className="mj-sidebar-row-label">{label}</span>
      {trailing}
    </>
  );
  return render({ className: `mj-sidebar-row mj-sidebar-row-${emphasis}`, children });
}
