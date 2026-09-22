/**
 * The messaging platforms an agent answers on.
 *
 * **The form is not ours.** Hermes's platform list grows and each one takes its own keys,
 * so a page with a hand-written form per platform would be wrong for the next one and
 * would drop the fields it had not heard of when somebody pressed save. The fields here
 * are whatever is in the agent's config, typed by what they look like.
 *
 * **Exclusive platforms are marked.** Telegram will not let two things poll one bot
 * token, so one identity belongs in one place — said on the row rather than discovered
 * by two agents fighting over it.
 *
 * **Nothing claims the channel is online.** The hub writes the file; whether Telegram is
 * answering is something only the running gateway knows.
 */
import { useState } from 'react';
import { useParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Skeleton,
  SkeletonGroup,
  Switch,
  useConfirm,
} from '../ui/index.js';
import { IconGlobe } from '../ui/icons.js';
import {
  useChannels,
  useClearChannel,
  useUpdateChannel,
  type Channel,
  type ChannelField,
} from './skills.js';

export function AgentChannelsScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const channels = useChannels(agentId);
  const [editing, setEditing] = useState<Channel | null>(null);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('channels.title_of', { name: agent.name }) : t('nav.agent_channels');
  const items = channels.data?.items ?? [];

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        <Notice>{t('channels.restart_note')}</Notice>

        {channels.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {channels.isError && <Notice tone="danger">{describeError(channels.error, t)}</Notice>}
        {channels.data &&
          (items.length === 0 ? (
            <EmptyState
              icon={<IconGlobe size={20} />}
              title={t('channels.none')}
              body={t('channels.none_body')}
            />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="channel-list">
              {items.map((channel) => (
                <li key={channel.platform}>
                  <ChannelRow
                    agentId={agentId}
                    channel={channel}
                    onEdit={() => setEditing(channel)}
                  />
                </li>
              ))}
            </ul>
          ))}
      </div>
      {editing && (
        <ChannelEditor agentId={agentId} channel={editing} onClose={() => setEditing(null)} />
      )}
    </AppShell>
  );
}

function ChannelRow({
  agentId,
  channel,
  onEdit,
}: {
  agentId: string | undefined;
  channel: Channel;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateChannel(agentId);
  const clear = useClearChannel(agentId);
  const { ask, dialog } = useConfirm();

  return (
    <div className="skill-row" data-enabled={channel.enabled || undefined}>
      <Switch
        checked={channel.enabled}
        label={t('channels.enabled')}
        labelHidden
        testId={`channel-toggle-${channel.platform}`}
        onChange={(next) => update.mutate({ platform: channel.platform, enabled: next })}
      />
      <button type="button" className="skill-open" onClick={onEdit}>
        <span className="flex items-center gap-2">
          <span className="font-medium" dir="ltr">
            {channel.label}
          </span>
          {channel.exclusive && <Badge tone="warning">{t('channels.exclusive')}</Badge>}
          {!channel.configured && <Badge>{t('channels.not_configured')}</Badge>}
        </span>
        <span className="skill-description">
          {t('channels.fields_n', { count: String(channel.fields.length) })}
        </span>
      </button>
      {channel.configured && (
        <Button
          size="sm"
          variant="ghost"
          data-testid={`channel-clear-${channel.platform}`}
          onClick={() => {
            void ask({
              title: t('channels.clear_title', { name: channel.label }),
              // Not a delete: the settings the person tuned are not what they asked to
              // clear, only the identity.
              body: t('channels.clear_body'),
              confirmLabel: t('channels.clear'),
            }).then((yes) => {
              if (yes) clear.mutate(channel.platform);
            });
          }}
        >
          {t('channels.clear')}
        </Button>
      )}
      {dialog}
    </div>
  );
}

function ChannelEditor({
  agentId,
  channel,
  onClose,
}: {
  agentId: string | undefined;
  channel: Channel;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateChannel(agentId);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const valueOf = (field: ChannelField): unknown =>
    Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.value;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={channel.label}
      description={t('channels.editor_note')}
      closeLabel={t('common.cancel')}
      testId="channel-editor"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={update.isPending}
            data-testid="save-channel"
            onClick={() => {
              // Split the way the contract asks, from what each field declared itself to
              // be — the screen does not decide which keys are secret.
              const credentials: Record<string, string> = {};
              const configuration: Record<string, unknown> = {};
              for (const field of channel.fields) {
                const value = valueOf(field);
                if (field.target === 'credentials') {
                  if (typeof value === 'string') credentials[field.key] = value;
                } else {
                  configuration[field.key] = value;
                }
              }
              update.mutate(
                { platform: channel.platform, credentials, configuration },
                { onSuccess: onClose },
              );
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {channel.fields.length === 0 && (
          <p className="text-sm text-muted">{t('channels.no_fields')}</p>
        )}
        {channel.fields.map((field) => {
          const value = valueOf(field);
          if (field.kind === 'toggle') {
            return (
              <Switch
                key={field.key}
                checked={value === true}
                label={field.key}
                testId={`channel-field-${field.key}`}
                onChange={(next) => setDraft({ ...draft, [field.key]: next })}
              />
            );
          }
          return (
            <Field
              key={field.key}
              label={field.key}
              {...(field.kind === 'secret' ? { hint: t('channels.secret_hint') } : {})}
            >
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  type={field.kind === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  value={typeof value === 'string' ? value : ''}
                  data-testid={`channel-field-${field.key}`}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              )}
            </Field>
          );
        })}
        {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
