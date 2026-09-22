/**
 * The one badge. Six tones, all from the soft token pairs, so every state in the client —
 * a run's status, an agent's health, a tool's outcome — is said with the same vocabulary of
 * colour. A screen never picks the hex; it picks the meaning.
 *
 * `dot` adds the small disc a status badge wants; `Badge` with no tone is the neutral chip.
 */
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  className = '',
  testId,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span className={`mj-badge mj-badge-${tone} ${className}`} data-testid={testId}>
      {dot && <span className="mj-badge-dot" aria-hidden />}
      <span className="mj-badge-label" dir="auto">
        {children}
      </span>
    </span>
  );
}
