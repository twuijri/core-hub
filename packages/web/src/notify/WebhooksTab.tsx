/**
 * Webhooks: addresses the hub calls on its own (admin, `notify`).
 *
 * **What it says is what the hub does.** A webhook receives the events it subscribed to,
 * from the profiles it names, as they happen (contract decision §59): queued, signed, sent
 * in the background, retried with backoff and finally given up on. The deliveries table
 * shows each one's attempts, status, answer and next try, and sends a failed one again.
 * Message text is left out unless the webhook asks for it.
 *
 * **The secret is on screen once.** It is made here, sent with the save, shown in its own
 * dialog to copy, and never again: the hub answers `[stored]` from then on. Replacing it is
 * making a new one; there is no "show".
 *
 * **The address is checked by the hub before it is stored** (a private address is refused
 * unless the webhook says so on purpose), so that refusal is shown in words beside the
 * field that caused it rather than as a generic error.
 */
import { useMemo, useState } from 'react';
import { useProfiles } from '../hub/queries.js';
import { HubApiError } from '@corehub/contracts';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Radio,
  ScrollArea,
  Skeleton,
  SkeletonGroup,
  Switch,
  Table,
  useConfirm,
  type BadgeTone,
  type Column,
} from '../ui/index.js';
import { IconCopy, IconTrash } from '../ui/icons.js';
import {
  DEFAULT_MAX_RETRIES,
  MAX_RETRIES_LIMIT,
  canRedeliver,
  clampRetries,
  newSigningSecret,
  testOutcomeOf,
  useCreateWebhook,
  useDeleteWebhook,
  useRedeliver,
  useSendTest,
  useTestJob,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhookEvents,
  useWebhooks,
  type DeliveryStatus,
  type Webhook,
  type WebhookDelivery,
  type WebhookWrite,
} from './webhooks.js';
import { intlLocale } from '../i18n/index.js';

type Translate = (key: string, p?: Record<string, string | number>) => string;

/** The header a receiver verifies (`derived.webhookSignatureHeader` in the contract package). */
const SIGNATURE_HEADER = 'X-CoreHub-Signature';

export function WebhooksTab() {
  const { t } = useI18n();
  const hooks = useWebhooks();
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="webhooks-tab">
      <div className="flex flex-wrap items-start gap-2">
        <p className="max-w-prose text-sm text-muted">{t('webhooks.intro')}</p>
        <Button
          className="ms-auto"
          size="sm"
          variant="primary"
          onClick={() => setEditing('new')}
          data-testid="add-webhook"
        >
          {t('webhooks.add')}
        </Button>
      </div>
      <div data-testid="webhooks-forwarding-note">
        <Notice>{t('webhooks.forwarding_note')}</Notice>
      </div>
      {hooks.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="7rem" radius="md" />
        </SkeletonGroup>
      )}
      {hooks.isError && <Notice tone="danger">{describeError(hooks.error, t)}</Notice>}
      {hooks.data &&
        (hooks.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            title={t('webhooks.none')}
            body={t('webhooks.none_body')}
            testId="webhooks-empty"
          />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="webhook-list">
            {hooks.data.items.map((hook) => (
              <li key={hook.id}>
                <WebhookCard hook={hook} onEdit={() => setEditing(hook)} />
              </li>
            ))}
          </ul>
        ))}
      {editing && (
        <WebhookDialog
          hook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSecret={setSecret}
        />
      )}
      {secret && <SecretOnce secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ one webhook

function WebhookCard({ hook, onEdit }: { hook: Webhook; onEdit: () => void }) {
  const { t, language } = useI18n();
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const send = useSendTest();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useTestJob(jobId);
  const outcome = testOutcomeOf(job.data);
  const testing = send.isPending || (!!jobId && !outcome && !job.isError);
  const [open, setOpen] = useState(false);
  const { ask, dialog } = useConfirm();

  const confirmDelete = () => {
    void ask({
      title: t('webhooks.delete_title', { name: hook.name }),
      body: t('webhooks.delete_body'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    }).then((yes) => {
      if (yes) remove.mutate(hook.id);
    });
  };

  return (
    <Card as="article" tone="flat" padding="md" testId="webhook-card">
      <CardHeader
        title={<span dir="auto">{hook.name}</span>}
        subtitle={
          <span dir="ltr" className="break-all" data-testid="webhook-url">
            {hook.url}
          </span>
        }
        actions={
          <Switch
            checked={hook.enabled}
            label={t('webhooks.enabled')}
            labelHidden
            disabled={update.isPending}
            onChange={(enabled) => update.mutate({ id: hook.id, body: { enabled } })}
            testId="webhook-enabled"
          />
        }
      />
      <ul className="flex flex-wrap gap-1" aria-label={t('webhooks.facts')}>
        <li>
          <Badge tone={hook.enabled ? 'success' : 'neutral'} testId="webhook-state">
            {t(hook.enabled ? 'webhooks.on' : 'webhooks.off')}
          </Badge>
        </li>
        <li>
          <Badge tone={hook.secret ? 'info' : 'warning'} testId="webhook-signed">
            {t(hook.secret ? 'webhooks.signed' : 'webhooks.unsigned')}
          </Badge>
        </li>
        <li>
          <Badge>
            {hook.events.length === 0
              ? t('webhooks.no_events')
              : t('webhooks.event_count', { count: hook.events.length })}
          </Badge>
        </li>
        <li>
          <Badge testId="webhook-profiles">
            {hook.profiles.length === 0
              ? t('webhooks.all_profiles')
              : t('webhooks.profile_count', { count: hook.profiles.length })}
          </Badge>
        </li>
        {hook.include_content && (
          <li>
            <Badge tone="warning" testId="webhook-content">
              {t('webhooks.with_content')}
            </Badge>
          </li>
        )}
        {hook.allow_private_network && (
          <li>
            <Badge tone="warning">{t('webhooks.private_allowed')}</Badge>
          </li>
        )}
      </ul>
      <p className="text-xs text-muted" data-testid="webhook-stats">
        {t('webhooks.stats', { delivered: hook.stats.delivered, failed: hook.stats.failed })}
        {hook.stats.last_delivery_at &&
          ` · ${t('webhooks.last_delivery', { when: formatWhen(hook.stats.last_delivery_at, language) })}`}
      </p>
      {hook.stats.last_error && (
        <p className="text-xs text-danger-soft-text" dir="auto">
          {t('webhooks.last_error', { error: hook.stats.last_error })}
        </p>
      )}
      {testing && (
        <p className="text-xs text-muted" aria-live="polite" data-testid="webhook-testing">
          {t('webhooks.testing')}
        </p>
      )}
      {outcome && (
        <Notice tone={outcome.delivered ? 'success' : 'danger'} className="mt-1">
          <span data-testid="webhook-test-outcome">{describeOutcome(outcome, t)}</span>
        </Notice>
      )}
      {send.isError && <Notice tone="danger">{describeError(send.error, t)}</Notice>}
      {job.isError && <Notice tone="danger">{describeError(job.error, t)}</Notice>}
      {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}
      {remove.isError && <Notice tone="danger">{describeError(remove.error, t)}</Notice>}
      {open && <Deliveries hookId={hook.id} />}
      <CardFooter>
        <Button
          size="sm"
          disabled={testing}
          loading={testing}
          onClick={() =>
            send.mutate(hook.id, {
              onSuccess: (data) => setJobId(data.job_id),
            })
          }
          data-testid="webhook-test"
        >
          {t('webhooks.test')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="webhook-deliveries-toggle"
        >
          {t(open ? 'webhooks.hide_deliveries' : 'webhooks.show_deliveries')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} data-testid="webhook-edit">
          {t('common.edit')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconTrash size={14} />}
          disabled={remove.isPending}
          onClick={confirmDelete}
          data-testid="webhook-delete"
        >
          {t('common.delete')}
        </Button>
      </CardFooter>
      {dialog}
    </Card>
  );
}

function describeOutcome(
  outcome: { delivered: boolean; status: number; error: string | null },
  t: Translate,
): string {
  if (outcome.delivered) return t('webhooks.test_ok', { status: outcome.status });
  if (outcome.status > 0) return t('webhooks.test_status', { status: outcome.status });
  return t('webhooks.test_failed', { error: outcome.error ?? '—' });
}

function formatWhen(iso: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

const STATUS_TONE: Record<DeliveryStatus, BadgeTone> = {
  queued: 'neutral',
  delivered: 'success',
  failed: 'danger',
  dead: 'danger',
};

function Deliveries({ hookId }: { hookId: string }) {
  const { t, language } = useI18n();
  const deliveries = useWebhookDeliveries(hookId, true);
  const redeliver = useRedeliver();
  if (deliveries.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="4rem" radius="md" />
      </SkeletonGroup>
    );
  if (deliveries.isError)
    return <Notice tone="danger">{describeError(deliveries.error, t)}</Notice>;
  const columns: Array<Column<WebhookDelivery>> = [
    {
      key: 'when',
      header: t('webhooks.col_when'),
      cell: (row) => <time dateTime={row.created_at}>{formatWhen(row.created_at, language)}</time>,
    },
    {
      key: 'event',
      header: t('webhooks.col_event'),
      cell: (row) => <span dir="ltr">{row.event}</span>,
    },
    {
      key: 'status',
      header: t('webhooks.col_status'),
      cell: (row) => (
        <Badge tone={STATUS_TONE[row.status]} testId="delivery-status">
          {t(`webhooks.delivery.${row.status}`)}
        </Badge>
      ),
    },
    {
      key: 'attempts',
      header: t('webhooks.col_attempts'),
      numeric: true,
      cell: (row) => <span data-testid="delivery-attempts">{row.attempts}</span>,
    },
    {
      key: 'code',
      header: t('webhooks.col_code'),
      numeric: true,
      cell: (row) => (
        <span data-testid="delivery-code">
          {row.response_status === null ? '—' : String(row.response_status)}
        </span>
      ),
    },
    {
      key: 'next',
      header: t('webhooks.col_next'),
      cell: (row) =>
        row.next_attempt_at ? (
          <time dateTime={row.next_attempt_at} data-testid="delivery-next">
            {formatWhen(row.next_attempt_at, language)}
          </time>
        ) : (
          '—'
        ),
    },
    {
      key: 'error',
      header: t('webhooks.col_error'),
      secondary: true,
      cell: (row) => <span dir="auto">{row.error ?? '—'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('webhooks.col_actions')}</span>,
      cell: (row) =>
        canRedeliver(row) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={redeliver.isPending}
            onClick={() => redeliver.mutate({ webhookId: hookId, deliveryId: row.id })}
            data-testid="delivery-redeliver"
          >
            {t('webhooks.redeliver')}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <Table
        caption={t('webhooks.deliveries')}
        testId="webhook-deliveries"
        columns={columns}
        rows={deliveries.data.items}
        rowKey={(row) => row.id}
        empty={<p className="text-xs text-muted">{t('webhooks.no_deliveries')}</p>}
      />
      {redeliver.isSuccess && (
        <p className="text-xs text-muted" aria-live="polite" data-testid="delivery-requeued">
          {t('webhooks.redelivered')}
        </p>
      )}
      {redeliver.isError && <Notice tone="danger">{describeError(redeliver.error, t)}</Notice>}
    </>
  );
}

// ------------------------------------------------------------------ add / edit

type SecretChoice = 'keep' | 'new' | 'none';

/** The hub's reason for refusing an address, in words, or null for any other failure. */
export function urlRefusal(error: unknown, t: Translate): string | null {
  if (!(error instanceof HubApiError)) return null;
  const reason = (error.body as { details?: { reason?: string } } | undefined)?.details?.reason;
  switch (reason) {
    case 'url_scheme':
      return t('webhooks.url_scheme');
    case 'url_unresolvable':
      return t('webhooks.url_unresolvable');
    case 'url_private':
      return t('webhooks.url_private');
    default:
      return null;
  }
}

function WebhookDialog({
  hook,
  onClose,
  onSecret,
}: {
  hook: Webhook | null;
  onClose: () => void;
  onSecret: (secret: string) => void;
}) {
  const { t, language } = useI18n();
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const catalogue = useWebhookEvents();
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [events, setEvents] = useState<string[]>(hook?.events ?? []);
  const profiles = useProfiles();
  const [profileScope, setProfileScope] = useState<'all' | 'some'>(
    hook && hook.profiles.length > 0 ? 'some' : 'all',
  );
  const [chosenProfiles, setChosenProfiles] = useState<string[]>(hook?.profiles ?? []);
  const [includeContent, setIncludeContent] = useState(hook?.include_content ?? false);
  const [retries, setRetries] = useState(hook?.max_retries ?? DEFAULT_MAX_RETRIES);
  const [allowPrivate, setAllowPrivate] = useState(hook?.allow_private_network ?? false);
  const [enabled, setEnabled] = useState(hook?.enabled ?? true);
  // A new webhook is signed unless somebody says otherwise: unsigned means the receiver
  // has to trust whoever knows the URL.
  const [secretChoice, setSecretChoice] = useState<SecretChoice>(
    hook ? (hook.secret ? 'keep' : 'none') : 'new',
  );
  const [filter, setFilter] = useState('');
  const save = hook ? update : create;

  const badUrl = url.length > 0 && !/^https?:\/\/\S+$/i.test(url);
  const noProfile = profileScope === 'some' && chosenProfiles.length === 0;
  const ready =
    name.trim().length > 0 && url.length > 0 && !badUrl && !noProfile && !save.isPending;
  const refusal = urlRefusal(save.error, t);

  const names = useMemo(() => (catalogue.data?.items ?? []).map((e) => e.name), [catalogue.data]);
  const describe = (event: string) => {
    const found = catalogue.data?.items.find((e) => e.name === event);
    return found ? (language === 'ar' ? found.description.ar : found.description.en) : event;
  };
  const needle = filter.trim().toLowerCase();
  const shown = names.filter(
    (n) => n.toLowerCase().includes(needle) || describe(n).toLowerCase().includes(needle),
  );

  const submit = () => {
    const secret = secretChoice === 'new' ? newSigningSecret() : null;
    const body: WebhookWrite = {
      name: name.trim(),
      url,
      // A name the hub no longer sends (saved before the catalogue) is dropped: the hub
      // refuses a subscription to an event it does not have.
      events: catalogue.data ? events.filter((event) => names.includes(event)) : events,
      profiles: profileScope === 'all' ? [] : chosenProfiles,
      enabled,
      include_content: includeContent,
      max_retries: clampRetries(retries),
      allow_private_network: allowPrivate,
      ...(secretChoice === 'keep' ? {} : { secret }),
    };
    const done = () => {
      if (secret) onSecret(secret);
      onClose();
    };
    if (hook) update.mutate({ id: hook.id, body }, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };

  const secretOptions = hook?.secret
    ? [
        { value: 'keep', label: t('webhooks.secret_keep') },
        { value: 'new', label: t('webhooks.secret_new'), hint: t('webhooks.secret_new_hint') },
        { value: 'none', label: t('webhooks.secret_remove') },
      ]
    : [
        { value: 'new', label: t('webhooks.secret_make'), hint: t('webhooks.secret_new_hint') },
        { value: 'none', label: t('webhooks.secret_none') },
      ];

  return (
    <Dialog
      open
      onOpenChange={(value) => !value && onClose()}
      title={hook ? t('webhooks.edit_title', { name: hook.name }) : t('webhooks.add')}
      closeLabel={t('common.cancel')}
      size="md"
      testId="webhook-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={save.isPending}
            onClick={submit}
            data-testid="save-webhook"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) submit();
        }}
      >
        <Field label={t('webhooks.name')}>
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              data-testid="webhook-name"
            />
          )}
        </Field>
        <Field
          label={t('webhooks.url')}
          hint={t('webhooks.url_hint')}
          {...(badUrl ? { error: t('webhooks.url_scheme') } : refusal ? { error: refusal } : {})}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              type="url"
              inputMode="url"
              placeholder="https://"
              value={url}
              invalid={badUrl || !!refusal}
              onChange={(event) => setUrl(event.target.value)}
              data-testid="webhook-url-input"
            />
          )}
        </Field>
        <Switch
          checked={allowPrivate}
          onChange={setAllowPrivate}
          label={t('webhooks.allow_private')}
          hint={t('webhooks.allow_private_hint')}
          testId="webhook-allow-private"
        />
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label={t('webhooks.enabled')}
          testId="webhook-enabled-input"
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('webhooks.signing')}</legend>
          <p className="text-xs text-muted">{t('webhooks.signing_hint')}</p>
          {/* Latin and symbols in a line of their own, so an Arabic sentence never
              reorders them. */}
          <code className="self-start text-xs" dir="ltr">
            {SIGNATURE_HEADER}: sha256=&lt;hex&gt;
          </code>
          <Radio
            label={t('webhooks.signing')}
            value={secretChoice}
            onChange={(value) => setSecretChoice(value as SecretChoice)}
            options={secretOptions}
            testId="webhook-secret-choice"
          />
        </fieldset>
        <fieldset className="flex flex-col gap-2" data-testid="webhook-events">
          <legend className="text-sm font-medium">
            {t('webhooks.events')}
            {events.length > 0 && ` (${events.length})`}
          </legend>
          <p className="text-xs text-muted">{t('webhooks.events_hint')}</p>
          {catalogue.isError && <Notice tone="danger">{describeError(catalogue.error, t)}</Notice>}
          {catalogue.data && (
            <>
              <Input
                inputSize="sm"
                dir="ltr"
                aria-label={t('webhooks.events_filter')}
                placeholder={t('webhooks.events_filter')}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                data-testid="webhook-events-filter"
              />
              <ScrollArea maxHeight="12rem" className="rounded-md border border-line">
                <div className="flex flex-col gap-1 p-2">
                  {shown.map((event) => (
                    <Checkbox
                      key={event}
                      checked={events.includes(event)}
                      onChange={(on) =>
                        setEvents((current) =>
                          on ? [...current, event] : current.filter((e) => e !== event),
                        )
                      }
                      label={
                        <span className="inline-flex flex-wrap items-baseline gap-x-2">
                          <span dir="auto">{describe(event)}</span>
                          <code className="text-xs text-muted" dir="ltr">
                            {event}
                          </code>
                        </span>
                      }
                      testId={`webhook-event-${event}`}
                    />
                  ))}
                  {shown.length === 0 && (
                    <p className="text-xs text-muted">{t('webhooks.events_no_match')}</p>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2" data-testid="webhook-profiles-field">
          <legend className="text-sm font-medium">{t('webhooks.profiles')}</legend>
          <p className="text-xs text-muted">{t('webhooks.profiles_hint')}</p>
          <Radio
            label={t('webhooks.profiles')}
            value={profileScope}
            onChange={(value) => setProfileScope(value as 'all' | 'some')}
            options={[
              { value: 'all', label: t('webhooks.profiles_all') },
              { value: 'some', label: t('webhooks.profiles_some') },
            ]}
            testId="webhook-profile-scope"
          />
          {profileScope === 'some' && (
            <div className="flex flex-col gap-1 ps-6">
              {(profiles.data ?? []).map((profile) => (
                <Checkbox
                  key={profile.slug}
                  checked={chosenProfiles.includes(profile.slug)}
                  onChange={(on) =>
                    setChosenProfiles((current) =>
                      on
                        ? [...current, profile.slug]
                        : current.filter((slug) => slug !== profile.slug),
                    )
                  }
                  label={<span dir="auto">{profile.name}</span>}
                  testId={`webhook-profile-${profile.slug}`}
                />
              ))}
              {noProfile && (
                <p className="text-xs text-danger-soft-text">{t('webhooks.profiles_pick_one')}</p>
              )}
            </div>
          )}
        </fieldset>
        <Switch
          checked={includeContent}
          onChange={setIncludeContent}
          label={t('webhooks.include_content')}
          hint={t('webhooks.include_content_hint')}
          testId="webhook-include-content"
        />
        <Field label={t('webhooks.max_retries')} hint={t('webhooks.max_retries_hint')}>
          {(props) => (
            <Input
              {...props}
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={0}
              max={MAX_RETRIES_LIMIT}
              step={1}
              value={String(retries)}
              onChange={(event) => setRetries(clampRetries(Number(event.target.value)))}
              data-testid="webhook-max-retries"
            />
          )}
        </Field>
        {save.isError && !refusal && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ the secret, once

function SecretOnce({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(value) => !value && onClose()}
      title={t('webhooks.secret_title')}
      description={t('webhooks.secret_once')}
      closeLabel={t('webhooks.secret_done')}
      testId="webhook-secret-dialog"
      footer={
        <Button variant="primary" onClick={onClose} data-testid="webhook-secret-done">
          {t('webhooks.secret_done')}
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <Input
          readOnly
          dir="ltr"
          aria-label={t('webhooks.secret_title')}
          value={secret}
          onFocus={(event) => event.currentTarget.select()}
          data-testid="webhook-secret-value"
        />
        <Button
          icon={<IconCopy size={14} />}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(secret)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
          data-testid="webhook-secret-copy"
        >
          {t(copied ? 'webhooks.copied' : 'webhooks.copy')}
        </Button>
      </div>
    </Dialog>
  );
}
