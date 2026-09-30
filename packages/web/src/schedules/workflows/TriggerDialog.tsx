/**
 * A trigger node opened from the canvas (owner, 2026-09-29): the same kind of dialog a step
 * opens. "Run by hand" holds the input a run starts with and a Run button; a webhook holds
 * its address, secret, events, test event and delivery log (`WorkflowTriggers.tsx`); a
 * schedule holds when it runs and whether it is on. A trigger added before the workflow's
 * first save waits for that save, and says so.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { describeError } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import { intlLocale } from '../../i18n/index.js';
import { routeOf } from '../../navigation/manifest.js';
import {
  Button,
  Dialog,
  Field,
  Input,
  Notice,
  Select,
  Switch,
  useConfirm,
} from '../../ui/index.js';
import { IconPlay } from '../../ui/icons.js';
import { TriggerCard } from './WorkflowTriggers.js';
import type { PendingTrigger, ScheduleDraft } from './model.js';
import {
  useWorkflowScheduleWrites,
  workflowScheduleBody,
  type WorkflowScheduleRow,
  type WorkflowTriggerRow,
} from './queries.js';
import type { CanvasTrigger } from './trigger-nodes.js';

type Translate = ReturnType<typeof useI18n>['t'];

/** When a schedule runs, in a few words. */
export function scheduleWhen(
  trigger: WorkflowScheduleRow['trigger'],
  t: Translate,
  format: (at: string) => string,
): string {
  if (trigger.kind === 'interval')
    return t('schedules.every', { minutes: trigger.every_minutes ?? 1 });
  if (trigger.kind === 'once') return trigger.run_at ? format(trigger.run_at) : '';
  return trigger.expression ?? '';
}

/** A saved schedule's time as the form edits it. */
export function draftOfSchedule(row: WorkflowScheduleRow): ScheduleDraft {
  const { trigger } = row;
  if (trigger.kind === 'interval')
    return { mode: 'interval', value: String(trigger.every_minutes ?? 60) };
  if (trigger.kind === 'once') {
    const at = trigger.run_at ? new Date(trigger.run_at) : null;
    // `datetime-local` wants the local time, without a zone.
    const local = at
      ? new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      : '';
    return { mode: 'once', value: local };
  }
  return { mode: 'cron', value: trigger.expression ?? '0 9 * * *' };
}

/** The schedule a new schedule trigger starts from: every day at nine. */
export const DEFAULT_SCHEDULE: ScheduleDraft = { mode: 'cron', value: '0 9 * * *' };

export function TriggerDialog({
  trigger,
  onClose,
  profile,
  workflowId,
  workflowName,
  webhook,
  schedule,
  pending,
  onPendingChange,
  onPendingRemove,
  runInput,
  onRunInput,
  onRun,
  runBusy,
  runDisabledReason,
  onHideManual,
  onShowRun,
}: {
  trigger: CanvasTrigger | null;
  onClose: () => void;
  profile: string;
  workflowId: string | null;
  workflowName: string;
  webhook: WorkflowTriggerRow | null;
  schedule: WorkflowScheduleRow | null;
  pending: PendingTrigger | null;
  onPendingChange: (trigger: PendingTrigger) => void;
  onPendingRemove: (id: string) => void;
  runInput: string;
  onRunInput: (value: string) => void;
  onRun: () => void;
  runBusy: boolean;
  /** Why Run is off, or `null` when it can run. */
  runDisabledReason: string | null;
  /** "Run by hand" is always possible; hiding it only takes it off an empty drawing. */
  onHideManual: (() => void) | null;
  onShowRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const open = trigger !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        trigger ? (
          <span dir="auto">
            {t('workflows.nodes.trigger')} · {trigger.title}
          </span>
        ) : (
          ''
        )
      }
      size="lg"
      closeLabel={t('ui.close')}
      testId="workflow-trigger-dialog"
      footer={
        <Button variant="secondary" onClick={onClose} data-testid="workflow-dialog-done">
          {t('workflows.nodes.back_to_canvas')}
        </Button>
      }
    >
      {trigger && (
        <div className="flex flex-col gap-3" data-trigger-kind={trigger.kind}>
          {trigger.kind === 'manual' && (
            <>
              <p className="text-sm text-muted">
                {t('workflows.nodes.manual_about', { input: '{{input}}' })}
              </p>
              <Field
                label={t('workflows.editor.run_input')}
                hint={t('workflows.editor.run_input_hint', { input: '{{input}}' })}
              >
                {(props) => (
                  <Input
                    {...props}
                    value={runInput}
                    onChange={(event) => onRunInput(event.target.value)}
                    dir="auto"
                    data-testid="workflow-run-input"
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  icon={<IconPlay size={14} />}
                  loading={runBusy}
                  disabled={runDisabledReason !== null}
                  tooltip={runDisabledReason ?? undefined}
                  onClick={onRun}
                  data-testid="workflow-manual-run"
                >
                  {t('workflows.run')}
                </Button>
                {onHideManual && (
                  <Button variant="ghost" size="sm" onClick={onHideManual}>
                    {t('workflows.nodes.remove_trigger')}
                  </Button>
                )}
              </div>
            </>
          )}
          {trigger.kind === 'webhook' && webhook && workflowId && (
            <TriggerCard
              trigger={webhook}
              profile={profile}
              workflowId={workflowId}
              onShowRun={(runId) => {
                onClose();
                onShowRun(runId);
              }}
            />
          )}
          {pending && (
            <PendingForm pending={pending} onChange={onPendingChange} onRemove={onPendingRemove} />
          )}
          {trigger.kind === 'schedule' && schedule && (
            <ScheduleForm
              key={schedule.id}
              schedule={schedule}
              profile={profile}
              workflowName={workflowName}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}

/** A trigger that waits for the workflow's first save: what it will be, and a way to drop it. */
function PendingForm({
  pending,
  onChange,
  onRemove,
}: {
  pending: PendingTrigger;
  onChange: (trigger: PendingTrigger) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-pending-trigger">
      <Notice tone="info">
        {pending.kind === 'webhook'
          ? t('workflows.nodes.pending_webhook')
          : t('workflows.nodes.pending_schedule')}
      </Notice>
      {pending.kind === 'schedule' && (
        <ScheduleFields
          value={pending.schedule}
          onChange={(schedule) => onChange({ ...pending, schedule })}
        />
      )}
      <Button
        size="sm"
        variant="danger-quiet"
        className="self-start"
        onClick={() => onRemove(pending.id)}
        data-testid="workflow-pending-remove"
      >
        {t('workflows.nodes.remove_trigger')}
      </Button>
    </div>
  );
}

/** When a schedule runs: a cron expression, every so many minutes, or once. */
function ScheduleFields({
  value,
  onChange,
}: {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-44">
        <Field label={t('schedules.kind')}>
          {() => (
            <Select
              value={value.mode}
              onValueChange={(mode) => {
                const next = (mode ?? 'cron') as ScheduleDraft['mode'];
                onChange({
                  mode: next,
                  value: next === 'interval' ? '60' : next === 'cron' ? '0 9 * * *' : '',
                });
              }}
              options={(['cron', 'interval', 'once'] as const).map((mode) => ({
                value: mode,
                label: t(`schedules.kinds.${mode}`),
              }))}
              label={t('schedules.kind')}
              testId="workflow-schedule-kind"
            />
          )}
        </Field>
      </div>
      <Field
        label={t(`schedules.value.${value.mode}`)}
        hint={value.mode === 'cron' ? t('schedules.cron_hint') : undefined}
        className="min-w-48 flex-1"
      >
        {(props) => (
          <Input
            {...props}
            type={
              value.mode === 'once'
                ? 'datetime-local'
                : value.mode === 'interval'
                  ? 'number'
                  : 'text'
            }
            min={value.mode === 'interval' ? 1 : undefined}
            value={value.value}
            onChange={(event) => onChange({ ...value, value: event.target.value })}
            dir="ltr"
            data-testid="workflow-schedule-value"
          />
        )}
      </Field>
    </div>
  );
}

/** A saved schedule that runs this workflow: when, on or off, and a way to delete it. */
function ScheduleForm({
  schedule,
  profile,
  workflowName,
}: {
  schedule: WorkflowScheduleRow;
  profile: string;
  workflowName: string;
}) {
  const { t, language } = useI18n();
  const writes = useWorkflowScheduleWrites(profile);
  const confirm = useConfirm();
  const [value, setValue] = useState<ScheduleDraft>(() => draftOfSchedule(schedule));
  const format = (at: string) =>
    new Intl.DateTimeFormat(intlLocale(language), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(Date.parse(at));
  const changed =
    JSON.stringify(value) !== JSON.stringify(draftOfSchedule(schedule)) &&
    value.value.trim() !== '';
  const error = writes.update.error ?? writes.remove.error;
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="workflow-schedule-trigger"
      data-schedule-id={schedule.id}
    >
      <Switch
        checked={schedule.enabled}
        onChange={(next) => writes.update.mutate({ id: schedule.id, patch: { enabled: next } })}
        label={t('schedules.enabled')}
        testId="workflow-schedule-enabled"
      />
      <p className="text-sm" data-testid="workflow-schedule-when">
        <span dir="ltr">{scheduleWhen(schedule.trigger, t, format)}</span>
        {' · '}
        <span className="text-muted">
          {schedule.next_run_at
            ? t('schedules.next', { at: format(schedule.next_run_at) })
            : t('schedules.never')}
        </span>
      </p>
      <ScheduleFields value={value} onChange={setValue} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!changed}
          loading={writes.update.isPending}
          onClick={() =>
            writes.update.mutate({
              id: schedule.id,
              patch: {
                trigger: workflowScheduleBody(workflowName, '', value, schedule.trigger.timezone)
                  .trigger,
              },
            })
          }
          data-testid="workflow-schedule-save"
        >
          {t('workflows.nodes.schedule_save')}
        </Button>
        <Link
          to={routeOf('schedules')}
          className="text-xs text-accent underline-offset-2 hover:underline"
          data-testid="workflow-schedule-open"
        >
          {t('workflows.nodes.schedule_open')}
        </Link>
        <Button
          size="sm"
          variant="danger-quiet"
          className="ms-auto"
          onClick={() =>
            void confirm
              .ask({
                title: t('schedules.confirm_delete', { name: schedule.name }),
                tone: 'danger',
              })
              .then((yes) => yes && writes.remove.mutate(schedule.id))
          }
          data-testid="workflow-schedule-delete"
        >
          {t('workflows.nodes.remove_trigger')}
        </Button>
      </div>
      {error && <Notice tone="danger">{describeError(error, t)}</Notice>}
      {confirm.dialog}
    </div>
  );
}
