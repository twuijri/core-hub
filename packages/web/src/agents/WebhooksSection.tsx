/**
 * «ويب هوك» on the agent's Channels page (decision §96): Hermes's incoming webhooks. A route is a
 * name, a prompt and a secret; an outside service — GitHub, a form, a script — POSTs to the route's
 * address signed with the secret, and the agent runs with the prompt, the posted values filled in.
 *
 * The address is this hub's own (`agents.receiveWebhook`): the hub passes what
 * it receives there to the profile's listener. So the page says plainly that the hub's address must
 * be reachable from the internet for an outside service — louder when the page itself was opened on
 * a private or local address. The address and the secret each have a copy button; the secret is
 * hidden until shown. «اختبار» sends a signed test POST from the hub itself, which proves the route
 * and the listener, not the public address.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
  useConfirm,
} from '../ui/index.js';
import { IconCopy, IconEye, IconEyeOff, IconPlus, IconTrash } from '../ui/icons.js';
import { describeToolError, platformName } from './toolErrors.js';
import type { Channel } from './skills.js';
import {
  WEBHOOK_NAME,
  eventsOf,
  isPrivateOrigin,
  useCreateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useWebhooks,
  webhookUrl,
  type HermesWebhook,
  type HermesWebhookList,
} from './webhooks.js';

export function WebhooksSection({
  agentId,
  channels,
  origin = window.location.origin,
}: {
  agentId: string;
  /** The profile's channels, for where an answer may be sent. */
  channels: readonly Channel[];
  origin?: string;
}) {
  const { t } = useI18n();
  const webhooks = useWebhooks(agentId);
  const [creating, setCreating] = useState(false);
  const items = webhooks.data?.items ?? [];
  const privateAddress = isPrivateOrigin(origin);

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="webhooks-heading"
      data-testid="webhooks"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="webhooks-heading" className="text-base font-semibold">
          {t('channels.webhooks.title')}
        </h2>
        {webhooks.data?.listener && <ListenerBadge listener={webhooks.data.listener} />}
        <Button
          size="sm"
          className="ms-auto"
          icon={<IconPlus size={14} />}
          onClick={() => setCreating(true)}
          data-testid="webhook-new"
        >
          {t('channels.webhooks.new')}
        </Button>
      </div>
      <p className="text-sm text-muted">{t('channels.webhooks.intro')}</p>
      <Notice tone={privateAddress ? 'warning' : 'info'}>
        <span data-testid="webhook-public-note" data-private={privateAddress ? 'true' : 'false'}>
          {privateAddress
            ? t('channels.webhooks.public_private', { origin })
            : t('channels.webhooks.public_note', { origin })}
        </span>
      </Notice>
      {webhooks.isError && <Notice tone="danger">{describeToolError(webhooks.error, t)}</Notice>}
      {webhooks.data &&
        (items.length === 0 ? (
          <p className="text-sm text-muted" data-testid="webhooks-empty">
            {t('channels.webhooks.none')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="webhook-list">
            {items.map((route) => (
              <li key={route.name}>
                <WebhookRow agentId={agentId} route={route} origin={origin} />
              </li>
            ))}
          </ul>
        ))}
      {creating && (
        <CreateWebhookDialog
          agentId={agentId}
          channels={channels}
          taken={new Set(items.map((route) => route.name))}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}

function ListenerBadge({ listener }: { listener: HermesWebhookList['listener'] }) {
  const { t } = useI18n();
  const state = !listener.enabled ? 'off' : listener.status;
  return (
    <span data-testid="webhook-listener" data-state={state}>
      <Badge
        tone={
          state === 'online'
            ? 'success'
            : state === 'error'
              ? 'danger'
              : state === 'off'
                ? 'neutral'
                : 'warning'
        }
      >
        {t(`channels.webhooks.listener_${state}`)}
      </Badge>
    </span>
  );
}

/** A copy button that says it copied. */
function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconCopy size={14} />}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
      data-testid={testId}
    >
      {copied ? t('channels.webhooks.copied') : t('channels.webhooks.copy')}
    </Button>
  );
}

function WebhookRow({
  agentId,
  route,
  origin,
}: {
  agentId: string;
  route: HermesWebhook;
  origin: string;
}) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [showSecret, setShowSecret] = useState(false);
  const remove = useDeleteWebhook(agentId);
  const test = useTestWebhook(agentId);
  const url = webhookUrl(origin, route);
  const accepted = test.data && test.data.status >= 200 && test.data.status < 300;
  const said =
    test.data?.body && typeof test.data.body.error === 'string' ? test.data.body.error : '';

  return (
    <div className="channel-card gap-2 p-3" data-enabled data-testid={`webhook-${route.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong dir="ltr">{route.name}</strong>
        {route.static && <Badge>{t('channels.webhooks.static')}</Badge>}
        {route.events.length > 0 && (
          <span className="text-xs text-muted" dir="ltr">
            {route.events.join(', ')}
          </span>
        )}
        <span className="ms-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={test.isPending}
            onClick={() => test.mutate(route.name)}
            data-testid={`webhook-test-${route.name}`}
          >
            {test.isPending ? t('channels.webhooks.testing') : t('channels.webhooks.test')}
          </Button>
          {!route.static && (
            <Button
              size="sm"
              variant="danger"
              icon={<IconTrash size={14} />}
              disabled={remove.isPending}
              onClick={() => {
                void ask({
                  title: t('channels.webhooks.delete_title', { name: route.name }),
                  body: t('channels.webhooks.delete_body'),
                  confirmLabel: t('channels.webhooks.delete'),
                }).then((yes) => {
                  if (yes) remove.mutate(route.name);
                });
              }}
              data-testid={`webhook-delete-${route.name}`}
            >
              {t('channels.webhooks.delete')}
            </Button>
          )}
        </span>
      </div>
      {route.description && (
        <p className="text-sm" dir="auto">
          {route.description}
        </p>
      )}
      <p className="text-xs text-muted">
        {t('channels.webhooks.prompt_label')}{' '}
        <span dir="auto" data-testid={`webhook-prompt-${route.name}`}>
          {route.prompt || t('channels.webhooks.prompt_empty')}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{t('channels.webhooks.url')}</span>
        <code
          className="min-w-0 flex-1 truncate text-xs"
          dir="ltr"
          data-testid={`webhook-url-${route.name}`}
        >
          {url}
        </code>
        <CopyButton
          value={url}
          label={t('channels.webhooks.copy_url', { name: route.name })}
          testId={`webhook-copy-url-${route.name}`}
        />
      </div>
      {route.secret !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">{t('channels.webhooks.secret')}</span>
          <code
            className="min-w-0 flex-1 truncate text-xs"
            dir="ltr"
            data-testid={`webhook-secret-${route.name}`}
          >
            {showSecret ? route.secret : '•'.repeat(24)}
          </code>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={showSecret ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            aria-label={
              showSecret ? t('channels.webhooks.hide_secret') : t('channels.webhooks.show_secret')
            }
            aria-pressed={showSecret}
            onClick={() => setShowSecret((on) => !on)}
            data-testid={`webhook-show-secret-${route.name}`}
          />
          <CopyButton
            value={route.secret}
            label={t('channels.webhooks.copy_secret', { name: route.name })}
            testId={`webhook-copy-secret-${route.name}`}
          />
        </div>
      ) : (
        <p className="text-xs text-muted">{t('channels.webhooks.secret_global')}</p>
      )}
      {test.isError && <Notice tone="danger">{describeToolError(test.error, t)}</Notice>}
      {test.data && (
        <Notice tone={accepted ? 'success' : 'warning'}>
          <span data-testid={`webhook-test-result-${route.name}`} data-status={test.data.status}>
            {accepted
              ? t('channels.webhooks.test_accepted')
              : t('channels.webhooks.test_refused', {
                  status: String(test.data.status),
                  reason: said,
                })}
          </span>
        </Notice>
      )}
      {remove.isError && <Notice tone="danger">{describeToolError(remove.error, t)}</Notice>}
      {dialog}
    </div>
  );
}

function CreateWebhookDialog({
  agentId,
  channels,
  taken,
  onClose,
}: {
  agentId: string;
  channels: readonly Channel[];
  taken: ReadonlySet<string>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const create = useCreateWebhook(agentId);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState('');
  const [deliver, setDeliver] = useState('log');
  const trimmed = name.trim().toLowerCase();
  const nameError =
    trimmed === ''
      ? null
      : !WEBHOOK_NAME.test(trimmed)
        ? t('channels.webhooks.name_invalid')
        : taken.has(trimmed)
          ? t('channels.webhooks.name_taken')
          : null;
  const targets = channels.filter(
    (channel) => channel.platform !== 'webhook' && channel.enabled && channel.configured,
  );
  const ready = trimmed !== '' && nameError === null && prompt.trim() !== '' && !create.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('channels.webhooks.new_title')}
      description={t('channels.webhooks.new_intro')}
      closeLabel={t('common.cancel')}
      testId="webhook-create-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() =>
              create.mutate(
                {
                  name: trimmed,
                  prompt,
                  description: description.trim() || null,
                  events: eventsOf(events),
                  deliver,
                },
                { onSuccess: onClose },
              )
            }
            data-testid="webhook-create"
          >
            {create.isPending ? t('channels.webhooks.creating') : t('channels.webhooks.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t('channels.webhooks.name')}
          hint={t('channels.webhooks.name_hint')}
          error={nameError}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="github-issues"
              data-testid="webhook-name"
            />
          )}
        </Field>
        <Field label={t('channels.webhooks.prompt')} hint={t('channels.webhooks.prompt_hint')}>
          {(props) => (
            <Textarea
              {...props}
              dir="auto"
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('channels.webhooks.prompt_placeholder')}
              data-testid="webhook-prompt"
            />
          )}
        </Field>
        <Field label={t('channels.webhooks.description')}>
          {(props) => (
            <Input
              {...props}
              dir="auto"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="webhook-description"
            />
          )}
        </Field>
        <Field label={t('channels.webhooks.events')} hint={t('channels.webhooks.events_hint')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={events}
              onChange={(event) => setEvents(event.target.value)}
              placeholder="issues, push"
              data-testid="webhook-events"
            />
          )}
        </Field>
        <Select
          label={t('channels.webhooks.deliver')}
          value={deliver}
          onValueChange={(value) => setDeliver(value ?? 'log')}
          options={[
            { value: 'log', label: t('channels.webhooks.deliver_log') },
            ...targets.map((channel) => ({
              value: channel.platform,
              label: t('channels.webhooks.deliver_to', {
                name: platformName(channel.platform, t, channel.label),
              }),
            })),
          ]}
        />
        {create.isError && <Notice tone="danger">{describeToolError(create.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
