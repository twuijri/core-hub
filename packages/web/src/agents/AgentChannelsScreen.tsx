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
 * in Hermes too). Linked, the row names the account and offers Unlink instead.
 *
 * **Who may message the agent.** A linked WhatsApp answers a new sender with a pairing code;
 * the request waits in "Waiting for approval" until someone approves or turns it down here.
 * The list is read again every ten seconds while the page is open.
 *
 * **Telegram links by a bot token.** "Link Telegram" explains @BotFather in plain words, takes the
 * token, and the hub asks Telegram who the bot is before storing it (in the profile's own `.env`,
 * never shown again). Linked, the row names the bot (@username) and the page says how to start:
 * open the bot, send a message, approve the request below. Hermes's outside bot-creation service
 * is not used.
 *
 * **When a change takes effect** is said by the gateway that serves the profile: at once in a
 * named profile (the hub restarts that profile's messaging gateway), after Hermes's Restart in
 * the default one.
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
  useApprovePairing,
  useCancelJob,
  useChannels,
  useClearChannel,
  useDenyPairing,
  useJob,
  useLinkChannel,
  useLoginChannel,
  usePairing,
  useRevokePairing,
  useUnlinkChannel,
  useUpdateChannel,
  type Channel,
  type ChannelField,
  type ChannelGateway,
  type ChannelLink,
  type PairingState,
} from './skills.js';
import { TelegramSettingsPanel } from './TelegramSettingsPanel.js';
import { describeToolError } from './toolErrors.js';
import { useJobs } from './useJobs.js';

export function AgentChannelsScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const channels = useChannels(agentId);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [linkingTelegram, setLinkingTelegram] = useState(false);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('channels.title_of', { name: agent.name }) : t('nav.agent_channels');
  const items = channels.data?.items ?? [];
  const gateway = channels.data?.gateway ?? null;
  const whatsapp = items.find((channel) => channel.platform === 'whatsapp');
  const linked = whatsapp?.link?.linked === true;
  const telegram = items.find((channel) => channel.platform === 'telegram');
  const telegramLinked = telegram?.link?.linked === true;

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          <span className="ms-auto flex flex-wrap gap-2">
            {channels.data && !telegramLinked && (
              <Button
                size="sm"
                variant={linked ? 'primary' : 'ghost'}
                onClick={() => setLinkingTelegram(true)}
                data-testid="telegram-link-open"
              >
                {t('channels.telegram.link')}
              </Button>
            )}
            {!linked && (
              <Button
                size="sm"
                onClick={() => setPairing('whatsapp')}
                data-testid="channel-pair-whatsapp"
              >
                {t('channels.login.whatsapp')}
              </Button>
            )}
          </span>
        </div>
        <GatewayNote gateway={gateway} />
        {linked && whatsapp?.link && <HowToUse link={whatsapp.link} gateway={gateway} />}
        {telegramLinked && telegram?.link && (
          <TelegramHowTo link={telegram.link} gateway={gateway} />
        )}

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
                    gateway={gateway}
                    onEdit={() => setEditing(channel)}
                    onPair={() =>
                      channel.login === 'token'
                        ? setLinkingTelegram(true)
                        : setPairing(channel.platform)
                    }
                  />
                </li>
              ))}
            </ul>
          ))}
        {channels.data && <PairingSection agentId={agentId} />}
      </div>
      {editing && (
        <ChannelEditor agentId={agentId} channel={editing} onClose={() => setEditing(null)} />
      )}
      {pairing && (
        <PairDialog agentId={agentId} platform={pairing} onClose={() => setPairing(null)} />
      )}
      {linkingTelegram && (
        <TelegramLinkDialog
          agentId={agentId}
          gateway={gateway}
          onClose={() => setLinkingTelegram(false)}
        />
      )}
    </AppShell>
  );
}

function ChannelRow({
  agentId,
  channel,
  gateway,
  onEdit,
  onPair,
}: {
  agentId: string | undefined;
  channel: Channel;
  gateway: ChannelGateway | null;
  onEdit: () => void;
  onPair: () => void;
}) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hasSettings = channel.platform === 'telegram' && channel.link?.linked === true;
  const update = useUpdateChannel(agentId);
  const clear = useClearChannel(agentId);
  const unlink = useUnlinkChannel(agentId);
  const { ask, dialog } = useConfirm();
  const link = channel.link;
  const account = link ? accountOf(link) : '';

  return (
    <div className="flex flex-col gap-2">
      <div className="skill-row" data-enabled={channel.enabled || undefined}>
        <Switch
          checked={channel.enabled}
          label={t('channels.enabled')}
          labelHidden
          testId={`channel-toggle-${channel.platform}`}
          onChange={(next) => update.mutate({ platform: channel.platform, enabled: next })}
        />
        <button type="button" className="skill-open" onClick={onEdit}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium" dir="ltr">
              {channel.label}
            </span>
            {channel.exclusive && <Badge tone="warning">{t('channels.exclusive')}</Badge>}
            {link ? (
              <Badge
                tone={link.linked ? 'success' : 'neutral'}
                testId={`channel-link-${channel.platform}`}
              >
                {t(link.linked ? 'channels.linked' : 'channels.not_linked')}
              </Badge>
            ) : (
              !channel.configured && <Badge>{t('channels.not_configured')}</Badge>
            )}
            {channel.status !== 'unknown' && (
              <Badge
                tone={STATUS_TONE[channel.status]}
                testId={`channel-status-${channel.platform}`}
              >
                {t(`channels.status.${channel.status}`)}
              </Badge>
            )}
          </span>
          <span className="skill-description" data-testid={`channel-account-${channel.platform}`}>
            {link?.linked && account ? (
              <span dir="auto">{t('channels.linked_as', { account })}</span>
            ) : (
              t('channels.fields_n', { count: String(channel.fields.length) })
            )}
          </span>
        </button>
        {channel.login === 'qr' && !link?.linked && (
          <Button size="sm" data-testid={`channel-login-${channel.platform}`} onClick={onPair}>
            {t('channels.login.button')}
          </Button>
        )}
        {channel.login === 'token' && !link?.linked && (
          <Button size="sm" data-testid={`channel-login-${channel.platform}`} onClick={onPair}>
            {t('channels.telegram.link_button')}
          </Button>
        )}
        {hasSettings && (
          <Button
            size="sm"
            variant={settingsOpen ? 'primary' : 'ghost'}
            aria-expanded={settingsOpen}
            data-testid={`channel-settings-${channel.platform}`}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            {t('channels.settings.open')}
          </Button>
        )}
        {link?.linked && (
          <Button
            size="sm"
            variant="danger"
            data-testid={`channel-unlink-${channel.platform}`}
            disabled={unlink.isPending}
            onClick={() => {
              void ask({
                title: t('channels.unlink_title', { name: channel.label }),
                body: t(
                  channel.platform === 'telegram'
                    ? 'channels.telegram.unlink_body'
                    : 'channels.unlink_body',
                ),
                confirmLabel: t('channels.unlink'),
              }).then((yes) => {
                if (yes) unlink.mutate(channel.platform);
              });
            }}
          >
            {t('channels.unlink')}
          </Button>
        )}
        {!link && channel.configured && (
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
      {hasSettings && settingsOpen && <TelegramSettingsPanel agentId={agentId} gateway={gateway} />}
      {channel.status === 'error' && channel.error && (
        <Notice tone="danger">
          <span dir="auto">{channel.error}</span>
        </Notice>
      )}
      {unlink.isError && <Notice tone="danger">{describeToolError(unlink.error, t)}</Notice>}
      {unlink.isSuccess && (
        <Notice>
          <span data-testid="channel-unlinked">
            {t(
              channel.platform === 'telegram'
                ? 'channels.telegram.unlinked_note'
                : 'channels.unlinked_note',
            )}
          </span>
        </Notice>
      )}
    </div>
  );
}

const STATUS_TONE: Record<Channel['status'], 'success' | 'danger' | 'neutral'> = {
  online: 'success',
  error: 'danger',
  offline: 'neutral',
  unknown: 'neutral',
};

/**
 * "Office · +966500000000" (WhatsApp) or "Office · @office_bot" (Telegram), whichever Hermes or
 * Telegram named. The number and the handle are isolated left to right (U+2066 … U+2069), or an
 * Arabic sentence moves the plus sign or the @ to the other end.
 */
function accountOf(link: ChannelLink): string {
  return [
    link.account_name,
    link.account_username ? `\u2066@${link.account_username}\u2069` : null,
    link.account_phone ? `\u2066+${link.account_phone}\u2069` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * When a change on this page takes effect, and how the profile's messaging gateway is.
 * `gateway` is null where the hub does not run Hermes: it cannot know, and says the rule.
 */
function GatewayNote({ gateway }: { gateway: ChannelGateway | null }) {
  const { t } = useI18n();
  if (!gateway || gateway.applies === 'on_restart') {
    return (
      <Notice>
        <span data-testid="channel-gateway-note">{t('channels.restart_note')}</span>
      </Notice>
    );
  }
  return (
    <Notice>
      <span className="flex flex-wrap items-center gap-2" data-testid="channel-gateway-note">
        <span>{t('channels.applies_now')}</span>
        <span data-testid="channel-gateway-state" data-state={gateway.state}>
          <Badge
            tone={
              gateway.state === 'running'
                ? 'success'
                : gateway.state === 'error'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {t(`channels.gateway.${gateway.state}`)}
          </Badge>
        </span>
      </span>
      {gateway.error && (
        <span className="mt-1 block text-xs" dir="auto">
          {gateway.error}
        </span>
      )}
    </Notice>
  );
}

/** What to do once WhatsApp is linked, in plain words, and what linking a personal number means. */
function HowToUse({ link, gateway }: { link: ChannelLink; gateway: ChannelGateway | null }) {
  const { t } = useI18n();
  const account = accountOf(link);
  return (
    <Notice tone="info">
      <span className="flex flex-col gap-1" data-testid="channel-how-to-use">
        <strong>{t('channels.how.title')}</strong>
        <span dir="auto">
          {account
            ? t('channels.how.step_message_as', { account })
            : t('channels.how.step_message')}
        </span>
        <span>{t('channels.how.step_approve')}</span>
        {gateway?.applies === 'on_restart' && <span>{t('channels.how.step_restart')}</span>}
        <span className="text-warning-soft-text" data-testid="channel-personal-warning">
          {t('channels.how.personal_warning')}
        </span>
      </span>
    </Notice>
  );
}

/**
 * What to do once Telegram is linked: open the bot, send it anything, approve the request here.
 * The bot's address is a link, so the step is one click.
 */
function TelegramHowTo({ link, gateway }: { link: ChannelLink; gateway: ChannelGateway | null }) {
  const { t } = useI18n();
  const username = link.account_username;
  const url = username ? `https://t.me/${username}` : null;
  return (
    <Notice tone="info">
      <span className="flex flex-col gap-1" data-testid="telegram-how-to-use">
        <strong>{t('channels.telegram.how_title')}</strong>
        {gateway?.applies === 'on_restart' && <span>{t('channels.how.step_restart')}</span>}
        <span>
          {url ? (
            <>
              {t('channels.telegram.how_open')}{' '}
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                dir="ltr"
                className="underline"
                data-testid="telegram-bot-link"
              >
                {`t.me/${username}`}
              </a>
            </>
          ) : (
            t('channels.telegram.how_open_unnamed')
          )}
        </span>
        <span>{t('channels.telegram.how_message')}</span>
        <span>{t('channels.telegram.how_approve')}</span>
      </span>
    </Notice>
  );
}

/** Telegram user ids typed as the person likes (commas, spaces, new lines): digits only. */
function idsOf(text: string): string[] {
  return text
    .split(/[\s,،]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * «ربط تيليجرام»: the steps with @BotFather in plain words, the token, and the optional people
 * who may skip pairing. The hub asks Telegram before it stores anything, so a wrong token is
 * said here in Telegram's words.
 */
function TelegramLinkDialog({
  agentId,
  gateway,
  onClose,
}: {
  agentId: string | undefined;
  gateway: ChannelGateway | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const link = useLinkChannel(agentId);
  const [token, setToken] = useState('');
  const [allowed, setAllowed] = useState('');
  const ids = idsOf(allowed);
  const badIds = ids.filter((id) => !/^[0-9]{1,20}$/.test(id));
  const done = link.data?.link?.linked ? link.data.link : null;
  const account = done ? accountOf(done) : '';

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('channels.telegram.title')}
      description={t('channels.telegram.intro')}
      closeLabel={t('common.cancel')}
      testId="telegram-link"
      footer={
        done ? (
          <Button onClick={onClose} data-testid="telegram-link-close">
            {t('channels.login.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={link.isPending || token.trim() === '' || badIds.length > 0}
              data-testid="telegram-link-submit"
              onClick={() =>
                link.mutate({
                  platform: 'telegram',
                  token: token.trim(),
                  ...(ids.length > 0 ? { allowed_users: ids } : {}),
                })
              }
            >
              {link.isPending ? t('channels.telegram.checking') : t('channels.telegram.submit')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Notice tone="success">
          <span className="flex flex-col gap-1" data-testid="telegram-link-done">
            <span dir="auto">{t('channels.telegram.done_as', { account })}</span>
            <span>
              {gateway?.applies === 'on_restart'
                ? t('channels.telegram.done_restart')
                : t('channels.telegram.done_now')}
            </span>
          </span>
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <ol
            className="flex list-decimal flex-col gap-1 ps-5 text-sm"
            data-testid="telegram-steps"
          >
            <li>{t('channels.telegram.step_open')}</li>
            <li>{t('channels.telegram.step_newbot')}</li>
            <li>{t('channels.telegram.step_copy')}</li>
          </ol>
          <Field label={t('channels.telegram.token')} hint={t('channels.telegram.token_hint')}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="123456789:AA…"
                value={token}
                data-testid="telegram-token"
                onChange={(event) => setToken(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('channels.telegram.allowed')}
            hint={t('channels.telegram.allowed_hint')}
            {...(badIds.length > 0 ? { error: t('channels.telegram.allowed_invalid') } : {})}
          >
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                autoComplete="off"
                placeholder="111222333, 444555666"
                value={allowed}
                data-testid="telegram-allowed"
                onChange={(event) => setAllowed(event.target.value)}
              />
            )}
          </Field>
          {link.isError && (
            <Notice tone="danger">
              <span data-testid="telegram-link-error" dir="auto">
                {describeToolError(link.error, t)}
              </span>
            </Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Minutes since a request, in words. */
function ageOf(iso: string, t: (key: string, values?: Record<string, string>) => string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return t('channels.pairing.just_now');
  if (minutes < 60) return t('channels.pairing.minutes_ago', { count: String(minutes) });
  return t('channels.pairing.hours_ago', { count: String(Math.floor(minutes / 60)) });
}

/**
 * «طلبات بانتظار الموافقة»: the senders Hermes answered with a pairing code in this profile,
 * each approved or turned down here, and below them the approved ones, each revocable.
 * Hidden for a person who may not manage the channels (the hub answers them 403).
 */
function PairingSection({ agentId }: { agentId: string | undefined }) {
  const { t } = useI18n();
  const pairing = usePairing(agentId);
  const approve = useApprovePairing(agentId);
  const deny = useDenyPairing(agentId);
  const revoke = useRevokePairing(agentId);
  const { ask, dialog } = useConfirm();
  if (pairing.isError && (pairing.error as { status?: number } | null)?.status === 403) return null;
  const pending = pairing.data?.pending ?? [];
  const approved = pairing.data?.approved ?? [];
  const failed = approve.error ?? deny.error ?? revoke.error;

  return (
    <section className="flex flex-col gap-3" data-testid="pairing-section">
      <h2 className="text-base font-semibold">{t('channels.pairing.title')}</h2>
      <p className="text-sm text-muted">{t('channels.pairing.note')}</p>
      {pairing.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="3rem" radius="md" />
        </SkeletonGroup>
      )}
      {pairing.isError && <Notice tone="danger">{describeToolError(pairing.error, t)}</Notice>}
      {failed && <Notice tone="danger">{describeToolError(failed, t)}</Notice>}
      {pairing.data && pending.length === 0 && (
        <p className="text-sm text-muted" data-testid="pairing-none">
          {t('channels.pairing.none')}
        </p>
      )}
      {pending.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="pairing-pending">
          {pending.map((request) => (
            <li
              key={`${request.platform}:${request.request_id}`}
              className="skill-row"
              data-testid={`pairing-request-${request.request_id}`}
            >
              <span className="skill-open">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge>{request.platform}</Badge>
                  <span className="font-medium" dir="auto">
                    {request.user_name ?? t('channels.pairing.unnamed')}
                  </span>
                </span>
                <span className="skill-description">
                  <span dir="ltr">{request.user_id}</span>
                  {' · '}
                  {ageOf(request.requested_at, t)}
                </span>
              </span>
              <Button
                size="sm"
                variant="primary"
                data-testid={`pairing-approve-${request.request_id}`}
                disabled={approve.isPending}
                onClick={() => approve.mutate(request)}
              >
                {t('channels.pairing.approve')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid={`pairing-deny-${request.request_id}`}
                disabled={deny.isPending}
                onClick={() => deny.mutate(request)}
              >
                {t('channels.pairing.deny')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="text-sm font-semibold">{t('channels.pairing.approved_title')}</h3>
      {pairing.data && approved.length === 0 && (
        <p className="text-sm text-muted" data-testid="pairing-approved-none">
          {t('channels.pairing.approved_none')}
        </p>
      )}
      {approved.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="pairing-approved">
          {approved.map((sender) => (
            <li
              key={`${sender.platform}:${sender.user_id}`}
              className="skill-row"
              data-testid={`pairing-sender-${sender.user_id}`}
            >
              <span className="skill-open">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge>{sender.platform}</Badge>
                  <span className="font-medium" dir="auto">
                    {sender.user_name ?? t('channels.pairing.unnamed')}
                  </span>
                </span>
                <span className="skill-description" dir="ltr">
                  {sender.user_id}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                data-testid={`pairing-revoke-${sender.user_id}`}
                disabled={revoke.isPending}
                onClick={() => {
                  void ask({
                    title: t('channels.pairing.revoke_title', {
                      name: sender.user_name ?? sender.user_id,
                    }),
                    body: t('channels.pairing.revoke_body'),
                    confirmLabel: t('channels.pairing.revoke'),
                  }).then((yes) => {
                    if (yes) revoke.mutate(sender);
                  });
                }}
              >
                {t('channels.pairing.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </section>
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
        {!done && (
          <Notice tone="warning">
            <span data-testid="channel-pair-warning">{t('channels.how.personal_warning')}</span>
          </Notice>
        )}
        {job?.status === 'succeeded' && (
          <Notice tone="success">
            <span data-testid="channel-pair-done" dir="auto">
              {state.applies === 'now'
                ? account
                  ? t('channels.login.done_as_now', { account })
                  : t('channels.login.done_now')
                : account
                  ? t('channels.login.done_as', { account })
                  : t('channels.login.done')}
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
