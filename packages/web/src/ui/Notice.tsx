import type { ReactNode } from 'react';

type Tone = 'info' | 'warning' | 'danger' | 'success';
const tones: Record<Tone, string> = {
  info: 'bg-info-soft text-info-soft-text',
  warning: 'bg-warning-soft text-warning-soft-text',
  danger: 'bg-danger-soft text-danger-soft-text',
  success: 'bg-success-soft text-success-soft-text',
};

/** An explicit message — errors, empty states and "not yet" notes are never silent. */
export function Notice({
  tone = 'info',
  children,
  role,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={`rounded-md px-3 py-2 text-sm ${tones[tone]} ${className}`}
    >
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-flex items-center gap-2 text-sm text-muted"
    >
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-line-strong border-t-transparent" />
      {label}
    </span>
  );
}
