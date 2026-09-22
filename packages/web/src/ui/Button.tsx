/**
 * The one button.
 *
 * Five intents and three heights, every value a token (`--mj-control-height-*`,
 * `--mj-control-pad-*`, the one shadow scale, the one focus ring from `@layer base`).
 * Nothing else in the client draws a button: a screen that wants one imports this, and a
 * link that should look like one takes `buttonClass()` — same paint, same heights, one
 * definition (docs/clients/DESIGN.md §UI policy).
 *
 * A disabled button takes no pointer events, so its reason can never be read from a
 * tooltip hung on itself: pass `disabledReason` and the wrapper that carries the tooltip
 * is built here, focusable, once.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './Tooltip.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return `mj-btn mj-btn-${variant} mj-btn-${size} ${extra}`.trim();
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  /** An icon with no words: the control becomes square and `aria-label` is required. */
  iconOnly?: boolean;
  /** Shown instead of the icon while an action is in flight; the button stays disabled. */
  loading?: boolean;
  /** Words for our tooltip — and the only way a *disabled* button can explain itself. */
  tooltip?: ReactNode;
  disabledReason?: string | null;
  /** Leading glyph. Under `iconOnly` it is the whole content. */
  icon?: ReactNode;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    type = 'button',
    iconOnly = false,
    loading = false,
    tooltip,
    disabledReason = null,
    icon,
    className = '',
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || disabledReason !== null || loading;
  const node = (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      data-icon-only={iconOnly ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
      disabled={isDisabled}
      {...rest}
    >
      {loading ? <span className="mj-btn-spin" aria-hidden /> : icon}
      {!iconOnly && children !== undefined && <span className="mj-btn-label">{children}</span>}
    </button>
  );
  const label = disabledReason ?? tooltip;
  if (label === null || label === undefined || label === '') return node;
  // A disabled control receives no pointer events; the tooltip hangs off a focusable
  // wrapper so the reason is reachable by mouse and by keyboard alike.
  return (
    <Tooltip label={label}>
      {isDisabled ? (
        <span tabIndex={0} className="mj-btn-wrap">
          {node}
        </span>
      ) : (
        node
      )}
    </Tooltip>
  );
});
