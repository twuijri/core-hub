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
 *
 * **WhatsApp pairs by QR.** "Link WhatsApp" starts Hermes's own pairing in this profile as a
 * job; the code Hermes hands out is drawn here and replaced whenever Hermes replaces it, until
 * a phone scans it, the code expires, or the person closes the dialog (which stops the pairing
 * in Hermes too).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
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
import { QrCode } from '../screens/DeviceConnectionsScreen.js';
import type { Job } from '../types.js';
import {
  channelKeys,
  useCancelJob,
  useChannels,
  useClearChannel,
  useJob,
  useLoginChannel,
  useUpdateChannel,
  type Channel,
  type ChannelField,
  type PairingState,
} from './skills.js';
import { describeToolError } from './toolErrors.js';
import { useJobs } from './useJobs.js';

export function AgentChannelsScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const channels = useChannels(agentId);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('channels.title_of', { name: agent.name }) : t('nav.agent_channels');
  const items = channels.data?.items ?? [];

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          <Button
            className="ms-auto"
            size="sm"
            onClick={() => setPairing('whatsapp')}
            data-testid="channel-pair-whatsapp"
          >
            {t('channels.login.whatsapp')}
          </Button>
        </div>
        <Notice>{t('channels.restart_note')}</Notice>

        {channels.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {channels.isError && <Notice tone="danger">{describeToolError(channels.error, t)}</Notice>}
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
                    onPair={() => setPairing(channel.platform)}
                  />
                </li>
              ))}
            </ul>
          ))}
      </div>
      {editing && (
        <ChannelEditor agentId={agentId} channel={editing} onClose={() => setEditing(null)} />
      )}
      {pairing && (
        <PairDialog agentId={agentId} platform={pairing} onClose={() => setPairing(null)} />
      )}
    </AppShell>
  );
}

function ChannelRow({
  agentId,
  channel,
  onEdit,
  onPair,
}: {
  agentId: string | undefined;
  channel: Channel;
  onEdit: () => void;
  onPair: () => void;
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
      {channel.login === 'qr' && (
        <Button size="sm" data-testid={`channel-login-${channel.platform}`} onClick={onPair}>
          {t('channels.login.button')}
        </Button>
      )}
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

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** The newer of what the socket said and what the last read said. */
function latest(a: Job | undefined, b: Job | undefined): Job | undefined {
  if (!a) return b;
  if (!b) return a;
  if (TERMINAL.has(a.status) !== TERMINAL.has(b.status)) return TERMINAL.has(a.status) ? a : b;
  return a.updated_at >= b.updated_at ? a : b;
}

/**
 * Pairing by QR: one `channel_login` job, started when the dialog opens. Closing it before
 * the phone is linked cancels the job, and the hub tells Hermes to forget the pairing.
 */
function PairDialog({
  agentId,
  platform,
  onClose,
}: {
  agentId: string | undefined;
  platform: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const jobs = useJobs();
  const login = useLoginChannel(agentId);
  const cancel = useCancelJob();
  const [jobId, setJobId] = useState<string | null>(null);
  const polled = useJob(jobId);
  const started = useRef(false);

  const start = () => {
    setJobId(null);
    login.mutate(platform, { onSuccess: (data) => setJobId(data.job_id) });
  };
  useEffect(() => {
    // Once, even under React's development double effects.
    if (started.current) return;
    started.current = true;
    start();
  }, []);

  const job = jobId ? latest(jobs[jobId], polled.data) : undefined;
  const state = (job?.result ?? {}) as PairingState;
  const done = job ? TERMINAL.has(job.status) : false;
  useEffect(() => {
    if (job?.status === 'succeeded') {
      void queryClient.invalidateQueries({
        queryKey: channelKeys.list(profile, agentId ?? ''),
      });
    }
  }, [job?.status, queryClient, profile, agentId]);

  const close = () => {
    if (jobId && !done) cancel.mutate(jobId);
    onClose();
  };
  const account = [state.account_name, state.account_phone].filter(Boolean).join(' · ');

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={t('channels.login.title', { name: platform })}
      description={t('channels.login.note')}
      closeLabel={t('common.cancel')}
      testId="channel-pair"
      footer={
        <>
          {job && (job.status === 'failed' || job.status === 'cancelled') && (
            <Button onClick={start} data-testid="channel-pair-again">
              {t('channels.login.again')}
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            {done ? t('channels.login.close') : t('common.cancel')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3" data-status={job?.status ?? 'starting'}>
        {login.isError && <Notice tone="danger">{describeToolError(login.error, t)}</Notice>}
        {!login.isError && !done && !state.qr && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="14rem" radius="md" />
          </SkeletonGroup>
        )}
        {!done && state.qr && (
          <div data-testid="channel-pair-qr" data-qr={state.qr}>
            <QrCode text={state.qr} />
          </div>
        )}
        {!done && job?.progress.message && (
          <p className="text-center text-sm" data-testid="channel-pair-message">
            {job.progress.message}
          </p>
        )}
        {!done && state.expires_at && (
          <p className="text-xs text-muted">
            {t('channels.login.expires', {
              time: new Date(state.expires_at).toLocaleTimeString(),
            })}
          </p>
        )}
        {job?.status === 'succeeded' && (
          <Notice tone="success">
            <span data-testid="channel-pair-done">
              {account ? t('channels.login.done_as', { account }) : t('channels.login.done')}
            </span>
          </Notice>
        )}
        {job?.status === 'failed' && (
          <Notice tone="danger">
            <span data-testid="channel-pair-failed" dir="auto">
              {job.error?.error ?? t('channels.login.failed')}
            </span>
          </Notice>
        )}
        {job?.status === 'cancelled' && <Notice>{t('channels.login.cancelled')}</Notice>}
      </div>
    </Dialog>
  );
}
