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
  narrow,
  children,
  className = '',
  testId,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  /**
   * `dot`: on a phone-width screen only the dot is drawn — «نقطة خضراء بدل كلمة أونلاين»
   * (owner, 2026-09-27). The words must then be the accessible name of what holds the badge.
   */
  narrow?: 'dot';
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={`ch-badge ch-badge-${tone} ${className}`}
      data-testid={testId}
      data-narrow={narrow}
    >
      {dot && <span className="ch-badge-dot" aria-hidden />}
      <span className="ch-badge-label" dir="auto">
        {children}
      </span>
    </span>
  );
}
