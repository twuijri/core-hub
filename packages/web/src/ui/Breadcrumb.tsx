/**
 * The trail back up. A `<nav>` of links ending in the current page, which is text and not
 * a link — a link to where you already are is a lie.
 *
 * The chevron between crumbs is drawn by CSS and mirrored by the reading direction, so the
 * trail points the right way in Arabic without a second component.
 */
import type { ReactNode } from 'react';

export interface Crumb {
  label: ReactNode;
  /** Omitted on the last crumb: the page you are on. */
  href?: string;
  /** How to render a link. The router owns navigation; this owns the paint. */
  render?(props: { href: string; children: ReactNode; className: string }): ReactNode;
}

export function Breadcrumb({
  label,
  items,
  testId,
}: {
  /** The nav's accessible name ("Breadcrumb"). */
  label: string;
  items: readonly Crumb[];
  testId?: string;
}) {
  return (
    <nav className="mj-crumbs" aria-label={label} data-testid={testId}>
      <ol>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={index} className="mj-crumb" data-current={last ? 'true' : undefined}>
              {last || !item.href ? (
                <span aria-current={last ? 'page' : undefined} dir="auto">
                  {item.label}
                </span>
              ) : item.render ? (
                item.render({ href: item.href, children: item.label, className: 'mj-crumb-link' })
              ) : (
                <a className="mj-crumb-link" href={item.href} dir="auto">
                  {item.label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
