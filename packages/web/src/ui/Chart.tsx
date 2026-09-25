/**
 * The kit's two charts: a daily stacked bar chart and a list of share bars (decision §47).
 *
 * No charting library: the Usage and Skills usage pages need two plain forms, and both are a
 * few flex boxes. Built from boxes rather than an SVG on purpose — a row of boxes follows the
 * page's direction by itself, so in Arabic the oldest day is at the right and time reads the
 * way the text does, with no mirrored coordinates to keep in step.
 *
 * Colours are the `chart-1…6` tokens, a categorical palette checked for colour-blind
 * separation in both themes; three light-theme slots sit under 3:1 against the surface, so a
 * chart is never the only place a number lives: it always has a legend, a readout of the day
 * under the pointer (or the keyboard), and the page puts a table beside it.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';

/** A categorical slot (`--ch-color-chart-N`), or the neutral "everything else". */
export type ChartTone = 1 | 2 | 3 | 4 | 5 | 6 | 'other';

export interface ChartSeries {
  key: string;
  label: string;
  tone: ChartTone;
}

export interface ChartBar {
  key: string;
  /** What the readout and the axis call this bar (a formatted day). */
  label: string;
  values: Readonly<Record<string, number>>;
}

const toneClass = (tone: ChartTone) => `ch-chart-tone-${tone}`;

export function StackedBarChart({
  label,
  series,
  bars,
  format,
  testId,
}: {
  /** The chart's accessible name. */
  label: string;
  series: readonly ChartSeries[];
  bars: readonly ChartBar[];
  format(value: number): string;
  testId?: string;
}) {
  const totals = bars.map((bar) => series.reduce((sum, s) => sum + (bar.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  // The day shown in the readout: the one under the pointer, else the last one with anything.
  const lastWithData = totals.reduce((found, total, i) => (total > 0 ? i : found), -1);
  const [active, setActive] = useState<number | null>(null);
  const shown = active ?? (lastWithData >= 0 ? lastWithData : bars.length - 1);
  const current = bars[shown];

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    // "Forward" is the reading direction: to the left in Arabic, to the right in English.
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = (event.key === 'ArrowRight') !== rtl;
    setActive(Math.min(bars.length - 1, Math.max(0, shown + (forward ? 1 : -1))));
  };

  const axis = [0, Math.floor((bars.length - 1) / 2), bars.length - 1].filter(
    (value, i, all) => all.indexOf(value) === i,
  );

  return (
    <div className="ch-chart" role="group" aria-label={label} data-testid={testId}>
      <ul className="ch-chart-legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className={`ch-chart-swatch ${toneClass(s.tone)}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <p
        className="ch-chart-readout"
        aria-live="polite"
        data-testid={testId && `${testId}-readout`}
      >
        {current && (
          <>
            <span className="font-medium">{current.label}</span>
            {series.map((s) => (
              <span key={s.key} className="ch-chart-readout-item">
                <span className={`ch-chart-swatch ${toneClass(s.tone)}`} aria-hidden="true" />
                {s.label} {format(current.values[s.key] ?? 0)}
              </span>
            ))}
          </>
        )}
      </p>
      <div
        className="ch-chart-plot"
        tabIndex={0}
        aria-label={label}
        onKeyDown={onKey}
        onMouseLeave={() => setActive(null)}
      >
        {bars.map((bar, i) => (
          <div
            key={bar.key}
            className="ch-chart-col"
            data-active={i === shown ? 'true' : undefined}
            data-testid={testId && `${testId}-bar`}
            onMouseEnter={() => setActive(i)}
          >
            <div
              className="ch-chart-stack"
              style={{ blockSize: `${((totals[i] ?? 0) / max) * 100}%` }}
            >
              {series.map((s) => {
                const value = bar.values[s.key] ?? 0;
                if (value <= 0) return null;
                return (
                  <span
                    key={s.key}
                    className={`ch-chart-seg ${toneClass(s.tone)}`}
                    style={{ flexGrow: value }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="ch-chart-axis" aria-hidden="true">
        {axis.map((i) => (
          <span key={i}>{bars[i]?.label}</span>
        ))}
      </div>
    </div>
  );
}

export interface ShareRow {
  key: string;
  label: ReactNode;
  /** 0…1, or `null` when there is nothing to measure a share of — then `note` says why. */
  share: number | null;
  value: ReactNode;
  note?: ReactNode;
}

/** One horizontal bar per row: a name, its part of the whole, and the number behind it. */
export function ShareBars({
  label,
  rows,
  percent,
  testId,
}: {
  label: string;
  rows: readonly ShareRow[];
  percent(share: number): string;
  testId?: string;
}) {
  return (
    <ul className="ch-share" aria-label={label} data-testid={testId}>
      {rows.map((row) => (
        <li key={row.key} className="ch-share-row">
          <span className="ch-share-label truncate" dir="auto">
            {row.label}
          </span>
          <span className="ch-share-track" aria-hidden="true">
            {row.share !== null && (
              <span
                className="ch-share-fill ch-chart-tone-1"
                style={{ inlineSize: `${Math.max(row.share * 100, row.share > 0 ? 1 : 0)}%` }}
              />
            )}
          </span>
          <span className="ch-share-value">
            {row.share === null ? row.note : `${percent(row.share)} · `}
            {row.share !== null && row.value}
          </span>
        </li>
      ))}
    </ul>
  );
}
