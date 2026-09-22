/**
 * The waiting shape. A skeleton stands where content will be, at the size it will be, so
 * nothing jumps when the answer arrives.
 *
 * It is never silent: the group carries `role="status"` and a real label, because a
 * screen-reader user must hear "loading" rather than meet a soundless gap
 * (TEAM-RULES §4 — no silent empty state). The shimmer is a token-timed animation and
 * stops entirely under `prefers-reduced-motion`; the shape stays.
 */
import type { ReactNode } from 'react';

export function Skeleton({
  width,
  height,
  radius = 'sm',
  className = '',
}: {
  /** Any CSS length. Defaults to the full inline size of the parent. */
  width?: string;
  height?: string;
  radius?: 'sm' | 'md' | 'full';
  className?: string;
}) {
  return (
    <span
      className={`mj-skeleton mj-skeleton-${radius} ${className}`}
      style={{
        ...(width === undefined ? {} : { inlineSize: width }),
        ...(height === undefined ? {} : { blockSize: height }),
      }}
      aria-hidden
    />
  );
}

/** Several skeletons that mean one thing, announced once. */
export function SkeletonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mj-skeleton-group" role="status" aria-label={label} data-testid="skeleton">
      {children}
    </div>
  );
}

/** The usual case: n lines of text, the last one short, the way a paragraph ends. */
export function SkeletonText({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <SkeletonGroup label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height="0.75rem" width={i === lines - 1 ? '55%' : '100%'} />
      ))}
    </SkeletonGroup>
  );
}
