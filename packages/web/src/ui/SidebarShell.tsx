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
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from './Tooltip.js';

/**
 * Whether the sidebar is folded into its rail of icons (`shell/sidebarFold.ts`). The rows
 * read it: folded, a row keeps its icon, its label stays its accessible name without taking
 * room, and the label comes back as a tooltip on hover and keyboard focus.
 */
const FoldedContext = createContext(false);

export function useSidebarFolded(): boolean {
  return useContext(FoldedContext);
}

export function SidebarFrame({
  label,
  children,
  testId,
  folded = false,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
  /** The rail of icons; the width change animates (instant under reduced motion). */
  folded?: boolean;
}) {
  return (
    <nav
      className="ch-sidebar glass"
      aria-label={label}
      data-testid={testId}
      data-folded={folded ? 'true' : undefined}
    >
      <FoldedContext.Provider value={folded}>{children}</FoldedContext.Provider>
    </nav>
  );
}

export function SidebarBrand({
  mark,
  name,
  action,
}: {
  mark: ReactNode;
  name: ReactNode;
  /** A control at the row's end — the fold toggle. Folded, it is all the row shows. */
  action?: ReactNode;
}) {
  const folded = useContext(FoldedContext);
  return (
    <div className="ch-sidebar-brand">
      {!folded && (
        <>
          <span className="ch-sidebar-mark" aria-hidden>
            {mark}
          </span>
          <span className="ch-sidebar-name">{name}</span>
        </>
      )}
      {action && <span className="ch-sidebar-brand-action">{action}</span>}
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
    <div className="ch-sidebar-group" data-testid={testId}>
      {label !== undefined && <p className="ch-sidebar-group-label">{label}</p>}
      {children}
    </div>
  );
}

/** The scrolling middle: the only part of the sidebar that grows. */
export function SidebarBody({ children }: { children: ReactNode }) {
  return <div className="ch-sidebar-body">{children}</div>;
}

export function SidebarFooter({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <footer className="ch-sidebar-foot" data-testid={testId}>
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
  const folded = useContext(FoldedContext);
  const children = (
    <>
      {icon}
      <span className="ch-sidebar-row-label">{label}</span>
      {trailing !== undefined && trailing !== null && trailing !== false && (
        <span className="ch-sidebar-row-trailing">{trailing}</span>
      )}
    </>
  );
  const row = render({ className: `ch-sidebar-row ch-sidebar-row-${emphasis}`, children });
  // Folded, the label is out of sight: it comes back beside the rail, toward the page.
  return folded ? (
    <Tooltip label={label} side="inline-end">
      {row as ReactElement}
    </Tooltip>
  ) : (
    row
  );
}
