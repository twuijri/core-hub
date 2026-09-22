/**
 * The shape of "there is nothing here".
 *
 * TEAM-RULES §4 forbids a silent empty state, and a `Notice` is the wrong size for a whole
 * page: a notice is a sentence beside something, this is what stands *instead* of the
 * thing. It always says three things — what is missing, why, and the one action that would
 * fix it — so no screen can end in a blank rectangle.
 */
import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  body,
  action,
  size = 'md',
  testId,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** One sentence: why it is empty, or what would put something here. */
  body?: ReactNode;
  /** The way out. A page with nothing on it and no way forward is a dead end. */
  action?: ReactNode;
  size?: 'sm' | 'md';
  testId?: string;
}) {
  return (
    <div className={`mj-empty mj-empty-${size}`} role="status" data-testid={testId}>
      {icon !== undefined && (
        <span className="mj-empty-icon" aria-hidden>
          {icon}
        </span>
      )}
      <p className="mj-empty-title" dir="auto">
        {title}
      </p>
      {body !== undefined && (
        <p className="mj-empty-body" dir="auto">
          {body}
        </p>
      )}
      {action !== undefined && <div className="mj-empty-action">{action}</div>}
    </div>
  );
}
