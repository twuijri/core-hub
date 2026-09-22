/**
 * Our separator, over Radix `Separator`: a hairline that is decorative unless it really
 * divides two groups, in which case Radix gives it `role="separator"` so the division is
 * announced and not merely drawn.
 *
 * With `label`, the line carries a word in its middle — the "or" between two ways to do
 * the same thing.
 */
import { Separator as RadixSeparator } from 'radix-ui';
import type { ReactNode } from 'react';

export function Separator({
  orientation = 'horizontal',
  decorative = true,
  label,
  className = '',
}: {
  orientation?: 'horizontal' | 'vertical';
  /** `false` when the line is the only thing saying two groups are different. */
  decorative?: boolean;
  label?: ReactNode;
  className?: string;
}) {
  if (label !== undefined) {
    return (
      <div className={`mj-sep-labelled ${className}`}>
        <RadixSeparator.Root className="mj-sep" decorative />
        <span className="mj-sep-label">{label}</span>
        <RadixSeparator.Root className="mj-sep" decorative />
      </div>
    );
  }
  return (
    <RadixSeparator.Root
      className={`mj-sep mj-sep-${orientation} ${className}`}
      orientation={orientation}
      decorative={decorative}
    />
  );
}
