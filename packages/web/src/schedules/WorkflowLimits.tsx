/**
 * A workflow's limits (DECISIONS §53): a time budget, a cost budget and a per-step timeout.
 *
 * - `RunLimits`: on a run's view, the limits it ran under, what it has cost so far by the
 *   hub's estimate, and — when a limit ended it — which one, in the person's language.
 * - `WorkflowLimitsForm`: the workflow's own limits, edited and saved as a whole — in the
 *   editor's side panel when no step is selected (decision §102), and from a run of it.
 * - `RunLimitsDialog`: one run's own limits, set on the editor's Run (the contract's
 *   `WorkflowRunRequest.limits`): the workflow's limits are the starting point, a field
 *   changed replaces it for this run only, and a field emptied lifts it.
 *
 * Times are written in minutes (a fraction is allowed: 0.5 is thirty seconds) and sent in
 * seconds; money is in US dollars, the currency of the hub's per-turn estimate.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HubApiError } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, Dialog, Field, Input, Notice, Skeleton } from '../ui/index.js';
import { intlLocale } from '../i18n/index.js';

export interface Money {
  amount: string;
  currency: string;
}

export interface Limits {
  max_duration_seconds: number | null;
  max_cost: Money | null;
  step_timeout_seconds: number | null;
}

export type StoppedBy = 'max_duration' | 'max_cost' | 'step_timeout';

export const NO_LIMITS: Limits = {
  max_duration_seconds: null,
  max_cost: null,
  step_timeout_seconds: null,
};

type Translate = (key: string, p?: Record<string, string | number>) => string;

/** `5400` → "1 h 30 min" / «1 س 30 د», in the person's language. */
export function formatSeconds(seconds: number, t: Translate): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(t('schedules.limits.units.hours', { n: hours }));
  if (minutes) parts.push(t('schedules.limits.units.minutes', { n: minutes }));
  if (rest && !hours) parts.push(t('schedules.limits.units.seconds', { n: rest }));
  return parts.join(' ') || t('schedules.limits.units.seconds', { n: 0 });
}

/** `{amount: "2.500000"}` → "$2.50" (more places only for an amount under a cent). */
export function formatMoney(money: Money, language: string): string {
  const value = Number(money.amount);
  return new Intl.NumberFormat(intlLocale(language), {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

/** The limits a run worked under, what it cost, and which limit stopped it. */
export function RunLimits({
  limits,
  cost,
  stoppedBy,
}: {
  limits: Limits | undefined;
  cost: Money | null | undefined;
  stoppedBy: StoppedBy | null | undefined;
}) {
  const { t, language } = useI18n();
  const shown = limits ?? NO_LIMITS;
  const none = t('schedules.limits.none');
  return (
    <div className="flex flex-col gap-2" data-testid="workflow-run-limits">
      {stoppedBy && (
        <Notice tone="danger">
          <span data-testid="workflow-run-stopped" data-stopped-by={stoppedBy}>
            {t(`schedules.limits.stopped.${stoppedBy}`)}
          </span>
        </Notice>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">{t('schedules.limits.time')}</dt>
        <dd data-testid="workflow-run-limit-time">
          {shown.max_duration_seconds === null
            ? none
            : formatSeconds(shown.max_duration_seconds, t)}
        </dd>
        <dt className="text-muted">{t('schedules.limits.cost')}</dt>
        <dd data-testid="workflow-run-limit-cost">
          {shown.max_cost === null ? none : formatMoney(shown.max_cost, language)}
        </dd>
        <dt className="text-muted">{t('schedules.limits.step')}</dt>
        <dd data-testid="workflow-run-limit-step">
          {shown.step_timeout_seconds === null
            ? none
            : formatSeconds(shown.step_timeout_seconds, t)}
        </dd>
        <dt className="text-muted">{t('schedules.limits.spent')}</dt>
        <dd data-testid="workflow-run-cost">
          {cost ? (
            formatMoney(cost, language)
          ) : (
            <Badge tone="neutral">{t('schedules.limits.not_priced')}</Badge>
          )}
        </dd>
      </dl>
    </div>
  );
}

/** Minutes as the person typed them → whole seconds, or `null` for blank. `NaN` if unreadable. */
export function secondsOf(minutes: string): number | null {
  const text = minutes.trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  return Math.max(1, Math.round(value * 60));
}

/** Dollars as typed → the contract's `Money`, or `null` for blank. `undefined` if unreadable. */
export function moneyOf(dollars: string): Money | null | undefined {
  const text = dollars.trim();
  if (text === '') return null;
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) return undefined;
  return { amount: text, currency: 'USD' };
}

const minutesText = (seconds: number | null) =>
  seconds === null ? '' : String(Math.round((seconds / 60) * 100) / 100);

const dollarsText = (money: Money | null) =>
  money?.amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') ?? '';

/** The three fields as typed, read into limits; `null` when any is unreadable or too large. */
function limitsOf(time: string, cost: string, step: string): Limits | null {
  const timeSeconds = secondsOf(time);
  const stepSeconds = secondsOf(step);
  const money = moneyOf(cost);
  if (
    Number.isNaN(timeSeconds) ||
    Number.isNaN(stepSeconds) ||
    money === undefined ||
    (timeSeconds ?? 0) > 7 * 24 * 3600 ||
    (stepSeconds ?? 0) > 24 * 3600
  ) {
    return null;
  }
  return { max_duration_seconds: timeSeconds, max_cost: money, step_timeout_seconds: stepSeconds };
}

/**
 * «شغّل بحدود»: one run with its own limits. Opens on the workflow's, so a person changes only
 * what differs; sends each field as it stands (the contract's override replaces a given field
 * and lifts one sent as `null`), and the workflow itself is left as it was.
 */
export function RunLimitsDialog({
  open,
  limits,
  busy,
  onRun,
  onClose,
}: {
  open: boolean;
  /** The workflow's own limits, the starting point. */
  limits: Limits | undefined;
  busy: boolean;
  onRun(limits: Limits): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const start = limits ?? NO_LIMITS;
  const [time, setTime] = useState(minutesText(start.max_duration_seconds));
  const [cost, setCost] = useState(dollarsText(start.max_cost));
  const [step, setStep] = useState(minutesText(start.step_timeout_seconds));
  const read = limitsOf(time, cost, step);
  return (
    <Dialog
      open={open}
      size="sm"
      onOpenChange={(next) => !next && onClose()}
      title={t('schedules.limits.run_title')}
      description={t('schedules.limits.run_hint')}
      closeLabel={t('common.cancel')}
      testId="workflow-run-limits-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!read}
            loading={busy}
            onClick={() => read && onRun(read)}
            data-testid="workflow-run-limited"
          >
            {t('workflows.run')}
          </Button>
        </>
      }
    >
      <LimitFields
        time={time}
        cost={cost}
        step={step}
        onTime={setTime}
        onCost={setCost}
        onStep={setStep}
        prefix="workflow-run-limit"
      />
    </Dialog>
  );
}

/** The three fields and their errors, shared by the workflow's form and one run's dialog. */
function LimitFields({
  time,
  cost,
  step,
  onTime,
  onCost,
  onStep,
  prefix,
}: {
  time: string;
  cost: string;
  step: string;
  onTime(value: string): void;
  onCost(value: string): void;
  onStep(value: string): void;
  prefix: string;
}) {
  const { t } = useI18n();
  const timeSeconds = secondsOf(time);
  const stepSeconds = secondsOf(step);
  const money = moneyOf(cost);
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('schedules.limits.time_minutes')}
        error={
          Number.isNaN(timeSeconds) || (timeSeconds ?? 0) > 7 * 24 * 3600
            ? t('schedules.limits.invalid_time')
            : undefined
        }
      >
        {(props) => (
          <Input
            {...props}
            inputMode="decimal"
            dir="ltr"
            value={time}
            placeholder={t('schedules.limits.none')}
            onChange={(event) => onTime(event.target.value)}
            data-testid={`${prefix}-time`}
          />
        )}
      </Field>
      <Field
        label={t('schedules.limits.cost_usd')}
        error={money === undefined ? t('schedules.limits.invalid_cost') : undefined}
      >
        {(props) => (
          <Input
            {...props}
            inputMode="decimal"
            dir="ltr"
            value={cost}
            placeholder={t('schedules.limits.none')}
            onChange={(event) => onCost(event.target.value)}
            data-testid={`${prefix}-cost`}
          />
        )}
      </Field>
      <Field
        label={t('schedules.limits.step_minutes')}
        error={
          Number.isNaN(stepSeconds) || (stepSeconds ?? 0) > 24 * 3600
            ? t('schedules.limits.invalid_step')
            : undefined
        }
      >
        {(props) => (
          <Input
            {...props}
            inputMode="decimal"
            dir="ltr"
            value={step}
            placeholder={t('schedules.limits.none')}
            onChange={(event) => onStep(event.target.value)}
            data-testid={`${prefix}-step`}
          />
        )}
      </Field>
    </div>
  );
}

/** A workflow's own limits, edited and saved as a whole (`schedules.updateWorkflow`). */
export function WorkflowLimitsForm({
  workflowId,
  profile,
}: {
  workflowId: string;
  profile: string;
}) {
  const { t } = useI18n();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const inProfile = { headers: { 'X-Hub-Profile': profile } };
  const workflow = useQuery({
    queryKey: ['schedules', 'workflow', workflowId],
    queryFn: async () =>
      (
        await client.request('get', '/workflows/{workflow_id}', {
          params: { workflow_id: workflowId },
          ...inProfile,
        })
      ).data as unknown as { name: string; limits?: Limits },
  });
  const [time, setTime] = useState('');
  const [cost, setCost] = useState('');
  const [step, setStep] = useState('');
  useEffect(() => {
    const limits = workflow.data?.limits ?? NO_LIMITS;
    setTime(minutesText(limits.max_duration_seconds));
    setCost(dollarsText(limits.max_cost));
    setStep(minutesText(limits.step_timeout_seconds));
  }, [workflow.data]);

  const save = useMutation({
    mutationFn: async (limits: Limits) =>
      (
        await client.request('patch', '/workflows/{workflow_id}', {
          params: { workflow_id: workflowId },
          body: { limits } as never,
          ...inProfile,
        })
      ).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });

  const read = limitsOf(time, cost, step);

  if (workflow.isPending) return <Skeleton height="6rem" radius="md" />;
  if (workflow.isError) return <Notice tone="danger">{describeError(workflow.error, t)}</Notice>;

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="workflow-limits-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (read) save.mutate(read);
      }}
    >
      <p className="text-xs text-muted">{t('schedules.limits.form_hint')}</p>
      <LimitFields
        time={time}
        cost={cost}
        step={step}
        onTime={setTime}
        onCost={setCost}
        onStep={setStep}
        prefix="workflow-limit"
      />
      {save.isError && (
        <Notice tone="danger">
          {save.error instanceof HubApiError &&
          (save.error.body as { details?: { reason?: string } } | undefined)?.details?.reason ===
            'limit_invalid'
            ? t('schedules.limits.invalid_cost')
            : describeError(save.error, t)}
        </Notice>
      )}
      {save.isSuccess && (
        <Notice tone="success">
          <span data-testid="workflow-limits-saved">{t('schedules.limits.saved')}</span>
        </Notice>
      )}
      <Button
        type="submit"
        className="self-start"
        size="sm"
        disabled={!read}
        loading={save.isPending}
        data-testid="workflow-limits-save"
      >
        {t('common.save')}
      </Button>
    </form>
  );
}
