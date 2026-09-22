/**
 * How full the model's window is, as a ring beside the mic.
 *
 * Owner decision, 2026-09-22: «جنب المايك يكون فيه دائره مثل حقة الكلود يكون فيها عدد
 * الكونتكست». The number is not a guess: it is the **input tokens the provider counted
 * for the last finished turn**, which is the prompt the model actually received, against
 * the `context_window` the catalogue carries for that model. When either is unknown the
 * ring is not drawn at all — an invented percentage about a limit is worse than silence.
 *
 * It says how full the window is, not how much has been spent: a conversation that was
 * compacted goes *down*, which is the whole point of reading it.
 */
import { useI18n } from '../i18n/context.js';
import type { Run } from '../types.js';
import { Tooltip } from '../ui/Tooltip.js';

export interface ContextUse {
  used: number;
  window: number;
  /** 0..1 */
  ratio: number;
}

/**
 * The last turn the provider reported input tokens for. A running turn has not reported
 * yet, so the ring keeps the previous answer instead of flickering to nothing.
 */
export function contextUse(
  runs: Record<string, Run>,
  contextWindow: number | null | undefined,
): ContextUse | null {
  if (!contextWindow || contextWindow <= 0) return null;
  const finished = Object.values(runs)
    .filter((run) => run.usage && run.usage.input_tokens > 0)
    .sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
  const last = finished.at(-1);
  if (!last?.usage) return null;
  const used = last.usage.input_tokens + last.usage.output_tokens;
  return { used, window: contextWindow, ratio: Math.min(1, used / contextWindow) };
}

/** A whole percentage, floored: 99.6 % of a window is not "100 %". */
export function percentOf(use: ContextUse): number {
  return Math.floor(use.ratio * 100);
}

export function ContextRing({ use }: { use: ContextUse }) {
  const { t, language } = useI18n();
  const percent = percentOf(use);
  const circumference = 2 * Math.PI * 7;
  const label = t('composer.context_ring', {
    percent: String(percent),
    used: new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en').format(use.used),
    window: new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en').format(use.window),
  });
  // Three bands, because a number alone does not say whether to act: comfortable, getting
  // full, nearly full. The colours are tokens, so both themes get them.
  const tone = use.ratio >= 0.9 ? 'danger' : use.ratio >= 0.7 ? 'warning' : 'normal';
  return (
    <Tooltip label={label}>
      <span
        className="context-ring"
        data-tone={tone}
        role="img"
        aria-label={label}
        tabIndex={0}
        data-testid="context-ring"
      >
        <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
          <circle className="context-ring-track" cx="9" cy="9" r="7" fill="none" strokeWidth="2" />
          <circle
            className="context-ring-fill"
            cx="9"
            cy="9"
            r="7"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${circumference * use.ratio} ${circumference}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </span>
    </Tooltip>
  );
}
