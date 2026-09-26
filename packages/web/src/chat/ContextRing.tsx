/**
 * How full the model's window is, as a ring beside the mic — and, pressed, the details and
 * a way to compress (decision §57).
 *
 * Owner decision, 2026-09-22: «جنب المايك يكون فيه دائره مثل حقة الكلود يكون فيها عدد
 * الكونتكست». The number is never invented, and it always says where it came from:
 *
 * - `reported`: the agent's own count of the window it uses and how much of it the last
 *   request took (Hermes reports both with every turn; the hub keeps it on the session).
 * - `agent_estimate`: the same, when the agent itself says it counted roughly.
 * - `estimate`: nothing reported, so the hub's own reading — the tokens the provider counted
 *   for the last finished turn against the catalogue's `context_window` for the model.
 *
 * When neither the window nor a count is known the ring is not drawn at all — an invented
 * percentage about a limit is worse than silence. It says how full the window is, not how
 * much has been spent: a conversation that was compacted goes *down*, which is the point.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import type { Run, Schemas, Session } from '../types.js';
import { Button } from '../ui/Button.js';
import { Popover } from '../ui/Popover.js';
import type { Compression } from './transcript.js';
import { intlLocale } from '../i18n/index.js';

export type ContextSource = 'reported' | 'agent_estimate' | 'estimate';

/** `sessions.getContextBreakdown`'s answer (decision §102). */
export type ContextBreakdown = Schemas['SessionContextBreakdown'];

export interface ContextUse {
  used: number;
  window: number;
  /** 0..1 */
  ratio: number;
  source: ContextSource;
}

/**
 * The window as the agent reported it (`Session.context`), or else the last turn the
 * provider reported input tokens for. A running turn has not reported yet, so the ring keeps
 * the previous answer instead of flickering to nothing.
 */
export function contextUse(
  runs: Record<string, Run>,
  contextWindow: number | null | undefined,
  reported?: Session['context'] | null,
): ContextUse | null {
  const reportedWindow = reported?.window_tokens ?? contextWindow ?? null;
  if (reported && reportedWindow && reportedWindow > 0) {
    return {
      used: reported.used_tokens,
      window: reportedWindow,
      ratio: Math.min(1, reported.used_tokens / reportedWindow),
      source: reported.estimated ? 'agent_estimate' : 'reported',
    };
  }
  if (!contextWindow || contextWindow <= 0) return null;
  const finished = Object.values(runs)
    .filter((run) => run.usage && run.usage.input_tokens > 0)
    .sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
  const last = finished.at(-1);
  if (!last?.usage) return null;
  const used = last.usage.input_tokens + last.usage.output_tokens;
  return {
    used,
    window: contextWindow,
    ratio: Math.min(1, used / contextWindow),
    source: 'estimate',
  };
}

/** A whole percentage, floored: 99.6 % of a window is not "100 %". */
export function percentOf(use: ContextUse): number {
  return Math.floor(use.ratio * 100);
}

/** Three bands, because a number alone does not say whether to act. */
export function toneOf(use: ContextUse): 'normal' | 'warning' | 'danger' {
  return use.ratio >= 0.9 ? 'danger' : use.ratio >= 0.7 ? 'warning' : 'normal';
}

/** Categories the client names in the person's language (Hermes's today, decision §102). */
export const KNOWN_CATEGORIES = [
  'system_prompt',
  'tool_definitions',
  'rules',
  'skills',
  'mcp',
  'subagent_definitions',
  'memory',
  'conversation',
] as const;

export function ContextRing({
  use,
  compression = null,
  onCompress,
  compressBlocked = null,
  breakdown,
  onOpenChange,
}: {
  use: ContextUse;
  compression?: Compression | null;
  /** Absent when the agent cannot compress: the details show, the button does not. */
  onCompress?: (() => Promise<void>) | undefined;
  /** Why compressing is not possible right now (a run in flight); shown, never implied. */
  compressBlocked?: string | null;
  /**
   * What fills the window, by category (decision §102): `undefined` while it is read, `null`
   * when the agent cannot tell — then the details simply have no breakdown.
   */
  breakdown?: ContextBreakdown | null | undefined;
  /** Told when the details open, so the breakdown is read only when someone looks. */
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const { t, language } = useI18n();
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [error, setError] = useState<string | null>(null);
  const format = (value: number) => new Intl.NumberFormat(intlLocale(language)).format(value);
  const percent = percentOf(use);
  const circumference = 2 * Math.PI * 7;
  const label = t(
    use.source === 'reported' ? 'composer.context_ring' : 'context_meter.ring_estimate',
    {
      percent: String(percent),
      used: format(use.used),
      window: format(use.window),
    },
  );
  const running = compression?.phase === 'running';

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="top"
      tooltip={label}
      testId="context-meter"
      trigger={
        <button
          type="button"
          className="context-ring"
          data-tone={toneOf(use)}
          data-source={use.source}
          data-busy={running ? 'true' : undefined}
          aria-label={label}
          data-testid="context-ring"
          data-percent={percent}
        >
          <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
            <circle
              className="context-ring-track"
              cx="9"
              cy="9"
              r="7"
              fill="none"
              strokeWidth="2"
            />
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
        </button>
      }
    >
      <div className="context-meter" data-testid="context-details">
        <p className="context-meter-title">{t('context_meter.title')}</p>
        <p className="context-meter-figure" data-testid="context-percent">
          {t('context_meter.percent', { percent: String(percent) })}
        </p>
        <div className="context-meter-bar" data-tone={toneOf(use)} aria-hidden>
          <span style={{ inlineSize: `${Math.max(2, use.ratio * 100)}%` }} />
        </div>
        <p className="context-meter-line">
          {t('context_meter.used', { used: format(use.used), window: format(use.window) })}
        </p>
        <p className="context-meter-source" data-testid="context-source">
          {t(`context_meter.source.${use.source}`)}
        </p>
        {breakdown?.available && breakdown.categories.length > 0 && (
          <Breakdown breakdown={breakdown} window={use.window} format={format} />
        )}
        {compression && compression.phase !== 'running' && (
          <p
            className="context-meter-result"
            data-testid="context-last-compression"
            data-phase={compression.phase}
          >
            {compression.phase === 'failed'
              ? t('context_meter.last_failed')
              : compression.beforeTokens !== null && compression.afterTokens !== null
                ? t('context_meter.last_compressed', {
                    before: format(compression.beforeTokens),
                    after: format(compression.afterTokens),
                  })
                : t('context_meter.last_done')}
            {compression.message && (
              <span className="context-meter-agent-words" dir="auto">
                {compression.message}
              </span>
            )}
          </p>
        )}
        {error && (
          <p className="context-meter-error" role="alert">
            {error}
          </p>
        )}
        {onCompress && (
          <div className="context-meter-actions">
            <Button
              size="sm"
              variant="secondary"
              loading={running}
              disabledReason={running ? null : compressBlocked}
              onClick={() => {
                setError(null);
                onCompress().catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                );
              }}
              data-testid="context-compress"
            >
              {running ? t('context_meter.compressing') : t('context_meter.compress')}
            </Button>
          </div>
        )}
      </div>
    </Popover>
  );
}

/**
 * The window split by what fills it (decision §102): one bar of segments over the whole window
 * — the free part is the track showing through — and a line per category with its count. The
 * agent's per-category counts are rough and need not sum to the figure above, so the note says
 * they are its estimate.
 */
function Breakdown({
  breakdown,
  window,
  format,
}: {
  breakdown: ContextBreakdown;
  window: number;
  format: (value: number) => string;
}) {
  const { t } = useI18n();
  const whole = Math.max(
    window,
    breakdown.categories.reduce((sum, category) => sum + category.tokens, 0),
  );
  const nameOf = (category: ContextBreakdown['categories'][number]) =>
    (KNOWN_CATEGORIES as readonly string[]).includes(category.id)
      ? t(`context_meter.category.${category.id}`)
      : category.label;
  return (
    <div className="context-breakdown" data-testid="context-breakdown">
      <p className="context-meter-title">{t('context_meter.breakdown_title')}</p>
      <div className="context-breakdown-bar" aria-hidden>
        {breakdown.categories.map((category) => (
          <span
            key={category.id}
            data-category={category.id}
            style={{ inlineSize: `${(category.tokens / whole) * 100}%` }}
          />
        ))}
      </div>
      <ul className="context-breakdown-list">
        {breakdown.categories.map((category) => (
          <li key={category.id} data-testid="context-category" data-category={category.id}>
            <span className="context-breakdown-swatch" data-category={category.id} aria-hidden />
            <span className="context-breakdown-name" dir="auto">
              {nameOf(category)}
            </span>
            <span className="context-breakdown-tokens" dir="ltr">
              {format(category.tokens)}
            </span>
          </li>
        ))}
      </ul>
      <p className="context-meter-source">{t('context_meter.breakdown_note')}</p>
    </div>
  );
}

/**
 * «يضغط السياق…» in the chat while the agent compresses, whoever asked: the person, or the
 * agent itself because the window was filling up. It sits with the live indicator above the
 * composer so it is seen however far back the person has scrolled.
 */
export function CompressionStatus({ compression }: { compression: Compression | null }) {
  const { t } = useI18n();
  if (compression?.phase !== 'running') return null;
  return (
    <div className="compression-status" role="status" data-testid="compression-status">
      <span className="compression-status-spin" aria-hidden />
      <span>
        {compression.trigger === 'auto'
          ? t('context_meter.compressing_auto')
          : t('context_meter.compressing_manual')}
      </span>
    </div>
  );
}
