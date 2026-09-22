/**
 * The one card: a solid content surface (DESIGN §Glass — glass is for floating chrome, a
 * card holds content and stays opaque so Arabic on it stays legible).
 *
 * Three levels of insistence — `flat` (a hairline), `raised` (the small shadow) and
 * `accent` (a tinted band at the inline start, for the one card on a page that matters
 * more than the rest). `interactive` adds the hover and the pointer, and is only for a
 * card that really is a button or a link.
 */
import type { ReactNode } from 'react';

export type CardTone = 'flat' | 'raised' | 'accent';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * The card's classes on their own, for the case the card *is* a link: a router `NavLink`
 * cannot be wrapped in `display:contents` without losing its focus ring, so it wears the
 * card instead. Same paint, one definition — the shape `buttonClass()` uses.
 */
export function cardClass(
  tone: CardTone = 'flat',
  padding: CardPadding = 'md',
  interactive = false,
  extra = '',
): string {
  return `mj-card mj-card-${tone} mj-card-pad-${padding} ${interactive ? 'mj-card-interactive' : ''} ${extra}`
    .replace(/\s+/g, ' ')
    .trim();
}

export function Card({
  children,
  tone = 'flat',
  interactive = false,
  padding = 'md',
  className = '',
  as: As = 'div',
  testId,
  ...rest
}: {
  children: ReactNode;
  tone?: CardTone;
  interactive?: boolean;
  padding?: CardPadding;
  className?: string;
  as?: 'div' | 'article' | 'section' | 'li';
  testId?: string;
} & Record<string, unknown>) {
  return (
    <As className={cardClass(tone, padding, interactive, className)} data-testid={testId} {...rest}>
      {children}
    </As>
  );
}

export function CardHeader({
  title,
  subtitle,
  media,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** An avatar, an icon tile, a status dot — whatever leads the row. */
  media?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mj-card-head">
      {media}
      <div className="mj-card-headings">
        <h3 className="mj-card-title" dir="auto">
          {title}
        </h3>
        {subtitle !== undefined && (
          <p className="mj-card-subtitle" dir="auto">
            {subtitle}
          </p>
        )}
      </div>
      {actions !== undefined && <div className="mj-card-actions">{actions}</div>}
    </header>
  );
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <footer className="mj-card-foot">{children}</footer>;
}
