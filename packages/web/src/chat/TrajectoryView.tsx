/**
 * The Trajectory tab of a conversation (contract decision §43; owner, 2026-09-25): the
 * conversation as a timeline of three lanes — the person's inputs, the model's turns and
 * the tools — over one shared time axis, the steps as a list that filters and searches,
 * and the metrics the hub actually has. Specified in `docs/inspirations/trajectory.md`.
 *
 * The data is `sessions.getTrajectory`; the pure rules (filters, the axis, folding idle
 * time, packing parallel calls) are `trajectory.ts`. This file only draws.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, EmptyState, Input, Notice, SkeletonText, Tooltip } from '../ui/index.js';
import { IconDownload, IconSearch, IconSpark, IconTool } from '../ui/icons.js';
import { ToolCallBody } from './ToolCallCard.js';
import {
  LANES,
  NO_FILTER,
  axisOf,
  durationOf,
  filterSteps,
  formatMs,
  packRows,
  resultOf,
  spanOf,
  summaryOf,
  type StepFilter,
  type Trajectory,
  type TrajectoryMetrics,
  type TrajectoryStep,
} from './trajectory.js';
import { useDownloadTrajectory, useTrajectory } from './useTrajectory.js';

/** How often running bars grow while the tab is open. */
const TICK_MS = 500;

export function TrajectoryView({ sessionId, revision }: { sessionId: string; revision: string }) {
  const { t } = useI18n();
  const query = useTrajectory(sessionId, true, revision);
  const data = query.data;

  if (query.isPending) {
    return (
      <div className="trajectory" data-testid="trajectory" data-state="loading">
        <SkeletonText lines={3} label={t('common.loading')} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="trajectory" data-testid="trajectory" data-state="error">
        <Notice tone="danger" role="alert">
          {describeError(query.error, t)}{' '}
          <button type="button" className="link underline" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </button>
        </Notice>
      </div>
    );
  }
  return <TrajectoryBody sessionId={sessionId} data={data} />;
}

function TrajectoryBody({ sessionId, data }: { sessionId: string; data: Trajectory }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<StepFilter>(NO_FILTER);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const download = useDownloadTrajectory(sessionId);

  // Running bars grow with the clock; nothing ticks once every step has ended.
  const running = data.steps.some((step) => step.status === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running, data]);

  const shown = useMemo(() => filterSteps(data.steps, filter, now), [data.steps, filter, now]);
  const numbers = useMemo(() => new Map(data.steps.map((step, i) => [step.id, i + 1])), [data]);

  // A bar clicked on the timeline brings its step into view — clearing the filters when
  // they hide it — and flashes it.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!focus) return;
    const node = list.current?.querySelector<HTMLElement>(`[data-step-id="${focus.id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.focus({ preventScroll: true });
  }, [focus, shown]);
  const focusStep = (id: string) => {
    if (!shown.some((step) => step.id === id)) setFilter(NO_FILTER);
    setFocus({ id, at: Date.now() });
  };

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () => {
    setSaving(true);
    setDownloadError(null);
    download()
      .catch(setDownloadError)
      .finally(() => setSaving(false));
  };

  const units = {
    ms: t('trajectory.unit.ms'),
    s: t('trajectory.unit.s'),
    min: t('trajectory.unit.min'),
  };
  const drawable = data.timing !== 'none' && data.steps.some((step) => spanOf(step, now));

  return (
    <section
      className="trajectory"
      data-testid="trajectory"
      data-state="ready"
      data-live={data.live ? 'true' : 'false'}
      aria-label={t('trajectory.tab')}
    >
      {data.steps.length === 0 ? (
        <EmptyState
          icon={<IconSpark size={20} />}
          title={t('trajectory.empty_title')}
          body={t('trajectory.empty_body')}
          testId="trajectory-empty"
        />
      ) : (
        <>
          {data.timing === 'none' && (
            <Notice tone="info" className="mb-3">
              <span data-testid="trajectory-untimed">{t('trajectory.untimed')}</span>
            </Notice>
          )}
          {data.timing === 'partial' && (
            <Notice tone="info" className="mb-3">
              <span data-testid="trajectory-partial">{t('trajectory.partial')}</span>
            </Notice>
          )}
          {drawable && (
            <Timeline steps={data.steps} now={now} numbers={numbers} onPick={focusStep} />
          )}
          <div className="trajectory-toolbar" data-testid="trajectory-filters">
            <div className="trajectory-chips" role="group" aria-label={t('trajectory.filters')}>
              {(
                [
                  ['byDuration', 'trajectory.filter.duration'],
                  ['turns', 'trajectory.filter.turns'],
                  ['calls', 'trajectory.filter.calls'],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  variant={filter[key] ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={filter[key]}
                  data-testid={`trajectory-filter-${key}`}
                  onClick={() => setFilter((current) => ({ ...current, [key]: !current[key] }))}
                >
                  {t(label)}
                </Button>
              ))}
            </div>
            <div className="trajectory-search">
              <Input
                inputSize="sm"
                type="search"
                icon={<IconSearch size={14} />}
                placeholder={t('trajectory.search')}
                aria-label={t('trajectory.search')}
                value={filter.query}
                onChange={(event) =>
                  setFilter((current) => ({ ...current, query: event.target.value }))
                }
                data-testid="trajectory-search"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconDownload size={14} />}
              loading={saving}
              onClick={save}
              data-testid="trajectory-download"
            >
              {t('trajectory.download')}
            </Button>
          </div>
          {downloadError !== null && (
            <Notice tone="danger" className="mb-2" role="alert">
              {describeError(downloadError, t)}
            </Notice>
          )}
          {shown.length === 0 ? (
            <p className="trajectory-none" data-testid="trajectory-no-match">
              {t('trajectory.no_match')}
            </p>
          ) : (
            <ol className="trajectory-steps" ref={list} data-testid="trajectory-steps">
              {shown.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  number={numbers.get(step.id) ?? 0}
                  now={now}
                  units={units}
                  expanded={open.has(step.id)}
                  flash={focus?.id === step.id ? focus.at : null}
                  onToggle={() => toggle(step.id)}
                />
              ))}
            </ol>
          )}
        </>
      )}
      <Metrics metrics={data.metrics} units={units} />
    </section>
  );
}

// ------------------------------------------------------------------ timeline

function Timeline({
  steps,
  now,
  numbers,
  onPick,
}: {
  steps: readonly TrajectoryStep[];
  now: number;
  numbers: ReadonlyMap<string, number>;
  onPick(id: string): void;
}) {
  const { t } = useI18n();
  const units = {
    ms: t('trajectory.unit.ms'),
    s: t('trajectory.unit.s'),
    min: t('trajectory.unit.min'),
  };
  const placed = steps.flatMap((step) => {
    const span = spanOf(step, now);
    return span ? [{ step, span }] : [];
  });
  const axis = axisOf(placed.map((entry) => entry.span));
  return (
    <div
      className="trajectory-timeline"
      role="group"
      aria-label={t('trajectory.timeline')}
      data-testid="trajectory-timeline"
    >
      {LANES.map((lane) => {
        const inLane = placed.filter((entry) => entry.step.lane === lane);
        const rows = packRows(inLane.map((entry) => entry.span));
        const depth = Math.max(1, ...rows.map((row) => row + 1));
        return (
          <div
            key={lane}
            className="trajectory-lane"
            data-lane={lane}
            data-testid={`trajectory-lane-${lane}`}
          >
            <span className="trajectory-lane-label">{t(`trajectory.lane.${lane}`)}</span>
            <div className="trajectory-track" style={{ '--rows': depth } as CSSProperties}>
              {axis.folds.map((at, index) => (
                <span
                  key={`fold-${index}`}
                  className="trajectory-fold"
                  style={{ insetInlineStart: `${at * 100}%` }}
                  aria-hidden
                />
              ))}
              {inLane.map(({ step, span }, index) => {
                const start = axis.at(span[0]);
                const width = Math.max(0, axis.at(span[1]) - start);
                const ms = durationOf(step, now);
                const what = stepTitle(step, t);
                const label = `${numbers.get(step.id) ?? ''}. ${what}${
                  ms === null ? '' : ` · ${formatMs(ms, units)}`
                }`;
                return (
                  <Tooltip key={step.id} label={<BarTip step={step} title={label} />}>
                    <button
                      type="button"
                      className="trajectory-bar"
                      data-kind={step.kind}
                      data-status={step.status}
                      data-testid="trajectory-bar"
                      data-step-id={step.id}
                      aria-label={label}
                      style={
                        {
                          insetInlineStart: `${start * 100}%`,
                          inlineSize: `${width * 100}%`,
                          '--row': rows[index] ?? 0,
                        } as CSSProperties
                      }
                      onClick={() => onPick(step.id)}
                    />
                  </Tooltip>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BarTip({ step, title }: { step: TrajectoryStep; title: string }) {
  const summary = summaryOf(step, 80);
  return (
    <span className="trajectory-tip">
      <span className="font-medium">{title}</span>
      {summary && (
        <span className="trajectory-tip-text" dir="auto">
          {summary}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------- list

function stepTitle(step: TrajectoryStep, t: ReturnType<typeof useI18n>['t']): string {
  if (step.kind === 'tool') return step.tool_call?.name ?? t('trajectory.kind.tool');
  return t(`trajectory.kind.${step.kind}`);
}

const STATUS_TONE = { running: 'info', failed: 'danger', cancelled: 'warning' } as const;

function StepRow({
  step,
  number,
  now,
  units,
  expanded,
  flash,
  onToggle,
}: {
  step: TrajectoryStep;
  number: number;
  now: number;
  units: { ms: string; s: string; min: string };
  expanded: boolean;
  flash: number | null;
  onToggle(): void;
}) {
  const { t } = useI18n();
  const ms = durationOf(step, now);
  const summary = summaryOf(step);
  const result = resultOf(step);
  const bodyId = `trajectory-step-${step.id}`;
  return (
    <li
      className="trajectory-step"
      data-kind={step.kind}
      data-status={step.status}
      data-step-id={step.id}
      data-flash={flash ?? undefined}
      data-testid="trajectory-step"
      tabIndex={-1}
    >
      <button
        type="button"
        className="trajectory-step-head"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        data-testid="trajectory-step-toggle"
      >
        <span className="trajectory-step-number">{number}</span>
        <span
          className="trajectory-dot"
          data-kind={step.kind}
          data-status={step.status}
          aria-hidden
        />
        <span className="trajectory-step-kind">
          {step.kind === 'tool' && <IconTool size={12} />}
          <span dir={step.kind === 'tool' ? 'ltr' : undefined}>{stepTitle(step, t)}</span>
        </span>
        <span className="trajectory-step-summary" dir="auto">
          {step.kind === 'turn' && summary === '' ? (
            <span className="text-faint">
              {step.tool_call_only ? t('trajectory.tool_call_only') : t('trajectory.no_text')}
            </span>
          ) : (
            summary
          )}
          {result && (
            <span className="trajectory-step-result" dir="auto">
              {' → '}
              {result}
            </span>
          )}
        </span>
        {step.status !== 'succeeded' && (
          <Badge tone={STATUS_TONE[step.status]} dot={step.status === 'running'}>
            {t(`trajectory.status.${step.status}`)}
          </Badge>
        )}
        <span className="trajectory-step-time">{ms === null ? '—' : formatMs(ms, units)}</span>
      </button>
      {expanded && (
        <div className="trajectory-step-body" id={bodyId} data-testid="trajectory-step-body">
          {step.first_token_ms !== null && (
            <p className="trajectory-step-meta">
              {t('trajectory.first_token_here', { time: formatMs(step.first_token_ms, units) })}
            </p>
          )}
          {step.kind === 'tool' && step.tool_call ? (
            <ToolCallBody call={step.tool_call} />
          ) : step.text ? (
            <p className="trajectory-step-text" dir="auto">
              {step.text}
            </p>
          ) : (
            <p className="text-faint">{t('trajectory.no_details')}</p>
          )}
          {step.kind === 'tool' && step.tool_call && !hasDetails(step) && (
            <p className="text-faint">{t('trajectory.no_details')}</p>
          )}
        </div>
      )}
    </li>
  );
}

function hasDetails(step: TrajectoryStep): boolean {
  const call = step.tool_call;
  if (!call) return false;
  return Boolean(call.output) || Boolean(call.arguments && Object.keys(call.arguments).length);
}

// ------------------------------------------------------------------- metrics

function Metrics({
  metrics,
  units,
}: {
  metrics: TrajectoryMetrics;
  units: { ms: string; s: string; min: string };
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en', {
    maximumFractionDigits: 1,
  });
  // Only what the hub has: a metric with no data behind it is left out, never shown as 0.
  const items: Array<[key: string, value: string | null]> = [
    ['turns', number.format(metrics.turns)],
    ['steps', number.format(metrics.steps)],
    ['model_time', metrics.model_ms === null ? null : formatMs(metrics.model_ms, units)],
    ['tool_time', metrics.tool_ms === null ? null : formatMs(metrics.tool_ms, units)],
    [
      'first_token',
      metrics.avg_first_token_ms === null ? null : formatMs(metrics.avg_first_token_ms, units),
    ],
    [
      'tokens_per_second',
      metrics.output_tokens_per_second === null
        ? null
        : number.format(metrics.output_tokens_per_second),
    ],
    [
      'cache_hit',
      metrics.cache_hit_pct === null ? null : `${number.format(metrics.cache_hit_pct)}%`,
    ],
    ['input_tokens', metrics.input_tokens === null ? null : number.format(metrics.input_tokens)],
    ['output_tokens', metrics.output_tokens === null ? null : number.format(metrics.output_tokens)],
  ];
  return (
    <footer className="trajectory-metrics" data-testid="trajectory-metrics">
      <dl>
        {items
          .filter((item): item is [string, string] => item[1] !== null)
          .map(([key, value]) => (
            <div key={key} className="trajectory-metric" data-metric={key}>
              <dt>{t(`trajectory.metric.${key}`)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </footer>
  );
}
