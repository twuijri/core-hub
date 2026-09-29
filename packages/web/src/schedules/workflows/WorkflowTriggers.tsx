/**
 * A workflow's inbound triggers (DECISIONS §123), each opened from its node on the canvas
 * (2026-09-29): an address on this hub an outside system — ClickUp first — posts events to.
 * The dialog gives
 * the address to copy, takes the secret the sender made (never shown again: "[stored]"),
 * the events the trigger takes, a "Send test event" that goes through the whole receiving
 * path without contacting anyone, and the delivery log with a link to each run.
 */
import { useState } from 'react';
import { describeError } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import { intlLocale } from '../../i18n/index.js';
import { Badge, Button, Checkbox, Field, Input, Notice, Select, Switch } from '../../ui/index.js';
import { useConfirm } from '../../ui/ConfirmDialog.js';
import type { BadgeTone } from '../../ui/index.js';
import {
  useTriggerDeliveries,
  useTriggerWrites,
  type DeliveryStatus,
  type TriggerDeliveryRow,
  type TriggerPreset,
  type WorkflowTriggerRow,
} from './queries.js';

export const PRESETS: TriggerPreset[] = ['clickup', 'github', 'generic_hmac', 'token'];

/** The task events ClickUp sends, offered as the trigger's filter (anything else is typed). */
export const CLICKUP_EVENTS = [
  'taskCreated',
  'taskUpdated',
  'taskDeleted',
  'taskStatusUpdated',
  'taskAssigneeUpdated',
  'taskPriorityUpdated',
  'taskDueDateUpdated',
  'taskTagUpdated',
  'taskMoved',
  'taskCommentPosted',
  'taskCommentUpdated',
];

const DELIVERY_TONE: Record<DeliveryStatus, BadgeTone> = {
  received: 'info',
  duplicate: 'neutral',
  signature_rejected: 'danger',
  filtered_out: 'neutral',
  run_started: 'info',
  run_succeeded: 'success',
  run_failed: 'danger',
};

/** The address to give the sender: this hub's own origin and the trigger's path. */
export function triggerUrl(path: string, origin: string = window.location.origin): string {
  return `${origin.replace(/\/$/, '')}${path}`;
}

/** What a new trigger of this preset is made with: its name, and ClickUp's usual task events. */
export function newTriggerBody(preset: TriggerPreset, name: string) {
  return {
    preset,
    name,
    ...(preset === 'clickup' ? { events: ['taskCreated', 'taskStatusUpdated'] } : {}),
  };
}

/**
 * One webhook trigger's settings — in the dialog its node on the canvas opens (2026-09-29):
 * whether it is on, the address to copy, the secret, the events, a test event and the
 * delivery log.
 */
export function TriggerCard({
  trigger,
  profile,
  workflowId,
  onShowRun,
}: {
  trigger: WorkflowTriggerRow;
  profile: string;
  workflowId: string;
  onShowRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const writes = useTriggerWrites(profile, workflowId);
  const confirm = useConfirm();
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [testEvent, setTestEvent] = useState('');
  const [eventsText, setEventsText] = useState(trigger.events.join(', '));
  const [header, setHeader] = useState(trigger.signature_header ?? '');
  const [prefix, setPrefix] = useState(trigger.signature_prefix ?? '');
  const url = triggerUrl(trigger.path);
  const patch = (body: Record<string, unknown>) =>
    writes.update.mutate({ id: trigger.id, patch: body });
  const error = writes.update.error ?? writes.remove.error ?? writes.test.error;
  const tested = writes.test.data;

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="workflow-trigger"
      data-trigger-id={trigger.id}
      data-preset={trigger.preset}
    >
      <Switch
        checked={trigger.enabled}
        onChange={(next) => patch({ enabled: next })}
        label={t('workflows.triggers.enabled')}
        testId="workflow-trigger-enabled"
      />
      <Field label={t('workflows.triggers.url')} hint={t('workflows.triggers.url_hint')}>
        {(props) => (
          <span className="flex gap-1">
            <Input
              {...props}
              value={url}
              readOnly
              dir="ltr"
              onFocus={(event) => event.currentTarget.select()}
              data-testid="workflow-trigger-url"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(url)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
              data-testid="workflow-trigger-copy"
            >
              {copied ? t('workflows.triggers.copied') : t('workflows.triggers.copy')}
            </Button>
          </span>
        )}
      </Field>
      <Field
        label={t('workflows.triggers.secret')}
        hint={t(`workflows.triggers.secret_hint.${trigger.preset}`)}
      >
        {(props) => (
          <span className="flex gap-1">
            <Input
              {...props}
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={trigger.secret_stored ? '[stored]' : ''}
              onChange={(event) => setSecret(event.target.value)}
              dir="ltr"
              data-testid="workflow-trigger-secret"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={secret.trim() === ''}
              loading={writes.update.isPending}
              onClick={() => {
                patch({ secret: secret.trim() });
                setSecret('');
              }}
              data-testid="workflow-trigger-secret-save"
            >
              {t('common.save')}
            </Button>
          </span>
        )}
      </Field>
      <p className="text-xs text-muted" data-testid="workflow-trigger-secret-state">
        {trigger.secret_stored
          ? t('workflows.triggers.secret_stored')
          : t('workflows.triggers.secret_missing')}
      </p>
      {(trigger.preset === 'generic_hmac' || trigger.preset === 'token') && (
        <div className="flex flex-col gap-1">
          <Input
            value={header}
            onChange={(event) => setHeader(event.target.value)}
            onBlur={() => patch({ signature_header: header.trim() || null })}
            placeholder={trigger.preset === 'token' ? 'X-Webhook-Token' : 'X-Signature'}
            aria-label={t('workflows.triggers.header')}
            dir="ltr"
            data-testid="workflow-trigger-header"
          />
          {trigger.preset === 'generic_hmac' && (
            <span className="flex gap-1">
              <Input
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                onBlur={() => patch({ signature_prefix: prefix.trim() || null })}
                placeholder="sha256="
                aria-label={t('workflows.triggers.prefix')}
                dir="ltr"
                data-testid="workflow-trigger-prefix"
              />
              <Select
                value={trigger.signature_encoding ?? 'hex'}
                onValueChange={(value) => patch({ signature_encoding: value ?? 'hex' })}
                options={[
                  { value: 'hex', label: 'hex' },
                  { value: 'base64', label: 'base64' },
                ]}
                label={t('workflows.triggers.encoding')}
                testId="workflow-trigger-encoding"
              />
            </span>
          )}
        </div>
      )}
      <fieldset className="flex flex-col gap-1" data-testid="workflow-trigger-events">
        <legend className="text-xs font-medium">{t('workflows.triggers.events')}</legend>
        {trigger.preset === 'clickup' ? (
          <div className="grid grid-cols-1 gap-0.5">
            {CLICKUP_EVENTS.map((event) => (
              <Checkbox
                key={event}
                checked={trigger.events.includes(event)}
                onChange={(next) =>
                  patch({
                    events: next
                      ? [...trigger.events, event]
                      : trigger.events.filter((each) => each !== event),
                  })
                }
                label={<code dir="ltr">{event}</code>}
                testId={`workflow-trigger-event-${event}`}
              />
            ))}
          </div>
        ) : (
          <Input
            value={eventsText}
            onChange={(event) => setEventsText(event.target.value)}
            onBlur={() =>
              patch({
                events: eventsText
                  .split(',')
                  .map((each) => each.trim())
                  .filter(Boolean),
              })
            }
            placeholder="issues, pull_request"
            aria-label={t('workflows.triggers.events')}
            dir="ltr"
            data-testid="workflow-trigger-events-text"
          />
        )}
        <p className="text-xs text-muted">{t('workflows.triggers.events_hint')}</p>
      </fieldset>
      <div className="flex items-end gap-1">
        <Input
          value={testEvent}
          onChange={(event) => setTestEvent(event.target.value)}
          placeholder={trigger.events[0] ?? ''}
          aria-label={t('workflows.triggers.test_event')}
          dir="ltr"
          data-testid="workflow-trigger-test-event"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!trigger.secret_stored || !trigger.enabled}
          tooltip={!trigger.secret_stored ? t('workflows.triggers.secret_missing') : undefined}
          loading={writes.test.isPending}
          onClick={() => writes.test.mutate({ id: trigger.id, event: testEvent.trim() || null })}
          data-testid="workflow-trigger-test"
        >
          {t('workflows.triggers.test')}
        </Button>
      </div>
      {tested && tested.trigger_id === trigger.id && (
        <p className="text-xs" data-testid="workflow-trigger-test-result">
          {t(`workflows.triggers.status.${tested.status}`)}
        </p>
      )}
      {error && <Notice tone="danger">{describeError(error, t)}</Notice>}
      <Deliveries profile={profile} triggerId={trigger.id} onShowRun={onShowRun} />
      <Button
        size="sm"
        variant="danger-quiet"
        onClick={() =>
          void confirm
            .ask({
              title: t('workflows.triggers.delete_title'),
              body: t('workflows.triggers.delete_body'),
              tone: 'danger',
            })
            .then((yes) => yes && writes.remove.mutate(trigger.id))
        }
        data-testid="workflow-trigger-delete"
      >
        {t('workflows.triggers.delete')}
      </Button>
      {confirm.dialog}
    </div>
  );
}

function Deliveries({
  profile,
  triggerId,
  onShowRun,
}: {
  profile: string;
  triggerId: string;
  onShowRun: (runId: string) => void;
}) {
  const { t, language } = useI18n();
  const deliveries = useTriggerDeliveries(profile, triggerId, true);
  const when = (at: string) =>
    new Intl.DateTimeFormat(intlLocale(language), {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(Date.parse(at));
  const rows = deliveries.data ?? [];
  return (
    <div className="flex flex-col gap-1" data-testid="workflow-trigger-deliveries">
      <h4 className="text-xs font-medium">{t('workflows.triggers.deliveries')}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">{t('workflows.triggers.no_deliveries')}</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1">
          {rows.map((row) => (
            <DeliveryLine key={row.id} row={row} when={when} onShowRun={onShowRun} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliveryLine({
  row,
  when,
  onShowRun,
}: {
  row: TriggerDeliveryRow;
  when: (at: string) => string;
  onShowRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <li
      className="flex min-w-0 flex-col gap-0.5 overflow-hidden rounded-md bg-sunken px-2 py-1 text-xs"
      data-testid="workflow-trigger-delivery"
      data-status={row.status}
      data-filtered={String(row.filtered)}
    >
      <span className="flex flex-wrap items-center gap-1">
        <Badge tone={DELIVERY_TONE[row.status] ?? 'neutral'}>
          {t(`workflows.triggers.status.${row.status}`)}
        </Badge>
        {row.filtered && <Badge>{t('workflows.triggers.filtered')}</Badge>}
        {row.test && <Badge tone="info">{t('workflows.triggers.test_badge')}</Badge>}
        <span className="text-muted">{when(row.received_at)}</span>
      </span>
      {(row.event || row.task_id) && (
        // Ids from the sender (ClickUp's history items, a task id) are long and unbroken: they
        // wrap anywhere rather than run out of the panel.
        <span dir="ltr" className="font-mono break-all">
          {[row.event, row.task_id && `task ${row.task_id}`, row.event_id && `#${row.event_id}`]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {row.error && (
        <span dir="auto" className="[overflow-wrap:anywhere]">
          {row.error}
        </span>
      )}
      {row.workflow_run_id && (
        <button
          type="button"
          className="self-start text-accent underline-offset-2 hover:underline"
          onClick={() => onShowRun(row.workflow_run_id!)}
          data-testid="workflow-delivery-run"
        >
          {t('workflows.triggers.open_run')}
        </button>
      )}
    </li>
  );
}
