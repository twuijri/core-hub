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
 * **How the number is used** is asked before the code is drawn (the owner, 2026-09-26): «بوت»,
 * a number for the agent that other people message, or «أنا», the person's own number, talking to
 * the agent in WhatsApp's "Message yourself". Nothing is guessed from the number. The linked card
 * says which, and «تغيير الوضع» switches it (the hub restarts the gateway itself).
 *
 * **Who may message the agent.** A linked WhatsApp in bot mode answers a new sender with a pairing
 * code; the request waits under «الموافقات» — one button in the page's header with the count
 * waiting, opening a panel grouped by platform — until someone approves or denies it there, and
 * the approved senders are removed there too (the owner, 2026-09-26: not a list under the cards).
 * A card with somebody waiting links to the same panel. Read again every ten seconds.
 *
 * **A channel the gateway does not serve yet** (`restart_needed`) says Hermes needs a restart,
 * with the button.
 *
 * **Telegram links by a bot token.** "Link Telegram" explains @BotFather in plain words, takes the
 * token, and the hub asks Telegram who the bot is before storing it (in the profile's own `.env`,
 * never shown again). Linked, the row names the bot (@username) and «كيف تبدأ» says how to start:
 * open the bot, send a message, approve the request under «الموافقات». Hermes's outside
 * bot-creation service is not used.
 *
 * **More platforms link like Telegram.** Discord, Slack, Matrix, Mattermost and Email each have a
 * «ربط <المنصة>» dialog with plain setup steps; the hub asks the platform who the account is
 * before storing anything, and the linked row names it and offers its own settings. Every other
 * platform Hermes has links with a form of the variables Hermes reads, stored unchecked — the
 * dialog says so. The catalog is the hub's (`agents.listChannelPlatforms`).
 *
 * **Only what is linked is listed** (the owner, 2026-09-25). One «ربط منصة» button opens a
 * searchable picker of every platform (`ChannelPlatformPicker`), and picking one opens that
 * platform's own form. With nothing linked the page is an empty state with the same button. Each
 * platform's "how to start" lives in its own card and dialog, never over the page.
 *
 * **When a change takes effect** is said by the gateway that serves the profile: at once wherever
 * the hub runs Hermes (it restarts that profile's messaging gateway, the default one's too), so
 * the page's "restart it" note and the guides' restart step are only for a Hermes the hub does not
 * run, or an older hub.
 *
 * **«عنوان الردود»** (WhatsApp in «مراسلة نفسي»): the header over every reply of the agent — its
 * name by default, or a typed title (`ReplyHeaderDialog`).
 *
 * **«ويب هوك»** under the channels (`WebhooksSection`, decision §97): Hermes's incoming webhook
 * routes, each with its address on this hub and its secret, and a plain word that an outside
 * service needs the hub's address to be public.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
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
  Radio,
  Sheet,
  Skeleton,
  SkeletonGroup,
  Switch,
  useConfirm,
} from '../ui/index.js';
import { IconGlobe, IconPlus } from '../ui/icons.js';
import { QrCode } from '../screens/DeviceConnectionsScreen.js';
import { canRestart, useRestartAgent } from './useRestartAgent.js';
import { PairingDecision } from './PairingDecision.js';
import type { Job } from '../types.js';
import {
  channelKeys,
  useApprovePairing,
  useCancelJob,
  useChannelPlatforms,
  useChannels,
  useClearChannel,
  useDenyPairing,
  useJob,
  useLinkChannel,
  useLoginChannel,
  usePairing,
  useRevokePairing,
  useSetChannelMode,
  useSetChannelReplyHeader,
  useUnlinkChannel,
  useUpdateChannel,
  type Channel,
  type ChannelField,
  type ChannelPlatform,
  type ChannelGateway,
  type ChannelLink,
  type PairingState,
  type WhatsAppMode,
} from './skills.js';
import { ChannelPlatformPicker } from './ChannelPlatformPicker.js';
import { ChannelSettingsPanel } from './ChannelSettingsPanel.js';
import { WebhooksSection } from './WebhooksSection.js';
import { useProfileName } from '../shell/profiles.js';
import { describeToolError, platformName } from './toolErrors.js';
import { useJobs } from './useJobs.js';

export function AgentChannelsScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const { user } = useAuth();
  const channels = useChannels(agentId);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [changingMode, setChangingMode] = useState<Channel | null>(null);
  const [changingHeader, setChangingHeader] = useState<Channel | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [linkingTelegram, setLinkingTelegram] = useState(false);
  const [linking, setLinking] = useState<ChannelPlatform | null>(null);
  const [picking, setPicking] = useState(false);
  const platforms = useChannelPlatforms(agentId);
  const requests = usePairing(agentId, !!channels.data);
  const unlink = useUnlinkChannel(agentId);
  const restarter = useRestartAgent(agentId);
  const specOf = (platform: string) =>
    platforms.data?.items.find((entry) => entry.platform === platform) ?? null;

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('channels.title_of', { name: agent.name }) : t('nav.agent_channels');
  const items = channels.data?.items ?? [];
  const gateway = channels.data?.gateway ?? null;
  const pending = requests.data?.pending ?? [];
  const waiting = new Set(pending.map((request) => request.platform));
  const waitingOn = (platform: string) =>
    pending.filter((request) => request.platform === platform).length;
  // A person who may not manage the channels is answered 403: no Approvals for them.
  const mayApprove = !(
    requests.isError && (requests.error as { status?: number } | null)?.status === 403
  );
  const restartable = canRestart(agent, user?.role);
  // Only what is linked (or somebody is waiting on): the platforms not linked yet live in the
  // picker, not in a long list under these.
  // Hermes's webhook receiver is a platform too; it has its own section below (§97).
  const shown = items.filter(
    (channel) =>
      channel.platform !== 'webhook' &&
      ((channel.link ? channel.link.linked : channel.configured) || waiting.has(channel.platform)),
  );
  const linkedSet = new Set(
    items.filter((channel) => channel.link?.linked).map((channel) => channel.platform),
  );
  const pick = (spec: ChannelPlatform) => {
    setPicking(false);
    if (spec.login === 'token') setLinkingTelegram(true);
    else if (spec.login === 'qr') setPairing(spec.platform);
    else setLinking(spec);
  };
  const pickButton = (
    <Button
      size="sm"
      icon={<IconPlus size={14} />}
      onClick={() => setPicking(true)}
      data-testid="platform-picker-open"
    >
      {t('channels.picker.open')}
    </Button>
  );
  const unlinkedName = unlink.variables
    ? platformName(unlink.variables, t, specOf(unlink.variables)?.label)
    : '';

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {(shown.length > 0 || pending.length > 0) && (
            <span className="ms-auto flex flex-wrap items-center gap-2">
              {mayApprove && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setApprovalsOpen(true)}
                  aria-label={
                    pending.length > 0
                      ? t('channels.approvals.open_count', { count: String(pending.length) })
                      : t('channels.approvals.open')
                  }
                  data-testid="approvals-open"
                  data-count={pending.length}
                >
                  {t('channels.approvals.open')}
                  {pending.length > 0 && (
                    <Badge tone="warning" testId="approvals-count">
                      {pending.length > 99 ? '99+' : String(pending.length)}
                    </Badge>
                  )}
                </Button>
              )}
              {shown.length > 0 && pickButton}
            </span>
          )}
        </div>
        {shown.length > 0 && <GatewayNote gateway={gateway} />}

        {channels.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {channels.isError && <Notice tone="danger">{describeToolError(channels.error, t)}</Notice>}
        {unlink.isError && <Notice tone="danger">{describeToolError(unlink.error, t)}</Notice>}
        {unlink.isSuccess && unlink.variables && (
          <Notice>
            <span data-testid="channel-unlinked">
              {unlink.variables === 'telegram'
                ? t('channels.telegram.unlinked_note')
                : unlink.variables === 'whatsapp'
                  ? t('channels.unlinked_note')
                  : t('channels.platform.unlinked_note', { name: unlinkedName })}
            </span>
          </Notice>
        )}
        {channels.data &&
          (shown.length === 0 ? (
            <EmptyState
              icon={<IconGlobe size={20} />}
              title={t('channels.none')}
              body={t('channels.none_body')}
              action={pickButton}
              testId="channels-empty"
            />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="channel-list">
              {shown.map((channel) => {
                const spec = specOf(channel.platform);
                return (
                  <li key={channel.platform}>
                    <ChannelRow
                      agentId={agentId}
                      channel={channel}
                      spec={spec}
                      gateway={gateway}
                      waiting={mayApprove ? waitingOn(channel.platform) : 0}
                      onReview={() => setApprovalsOpen(true)}
                      onChangeMode={() => setChangingMode(channel)}
                      onReplyHeader={() => setChangingHeader(channel)}
                      restart={restartable ? restarter : null}
                      unlinking={unlink.isPending}
                      onUnlink={() => unlink.mutate(channel.platform)}
                      onEdit={() => setEditing(channel)}
                      onPair={() => {
                        if (channel.login === 'token') setLinkingTelegram(true);
                        else if (channel.login === 'credentials' && spec) setLinking(spec);
                        else setPairing(channel.platform);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          ))}
        {channels.data && agentId && mayApprove && (
          <WebhooksSection agentId={agentId} channels={items} />
        )}
      </div>
      {mayApprove && (
        <ApprovalsSheet agentId={agentId} open={approvalsOpen} onOpenChange={setApprovalsOpen} />
      )}
      {changingMode && (
        <ModeDialog
          agentId={agentId}
          channel={changingMode}
          onClose={() => setChangingMode(null)}
        />
      )}
      {changingHeader && (
        <ReplyHeaderDialog
          agentId={agentId}
          agentName={agent?.name ?? ''}
          channel={changingHeader}
          onClose={() => setChangingHeader(null)}
        />
      )}
      {picking && platforms.data && (
        <ChannelPlatformPicker
          platforms={platforms.data.items}
          linked={linkedSet}
          onPick={pick}
          onClose={() => setPicking(false)}
        />
      )}
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
      {linking && (
        <PlatformLinkDialog
          agentId={agentId}
          spec={linking}
          gateway={gateway}
          onClose={() => setLinking(null)}
        />
      )}
    </AppShell>
  );
}

/**
 * One linked platform. Its "how to start" lives here, not over the page, closed behind «كيف تبدأ»
 * until that is pressed (the owner, 2026-09-26: it opened by itself on Telegram every visit). A
 * sender waiting for approval shows as its own «N بانتظار الموافقة — راجِع» link.
 */
function ChannelRow({
  agentId,
  channel,
  spec,
  gateway,
  waiting,
  onReview,
  onChangeMode,
  onReplyHeader,
  restart,
  unlinking,
  onUnlink,
  onEdit,
  onPair,
}: {
  agentId: string | undefined;
  channel: Channel;
  spec: ChannelPlatform | null;
  gateway: ChannelGateway | null;
  /** How many senders wait for approval on this platform. */
  waiting: number;
  /** Opens «الموافقات». */
  onReview: () => void;
  /** Opens «تغيير الوضع» (WhatsApp). */
  onChangeMode: () => void;
  /** Opens «عنوان الردود» (WhatsApp in self-chat). */
  onReplyHeader: () => void;
  /** Restarts the agent's runtime; null for a person or a runtime that cannot. */
  restart: { restart: () => Promise<void>; pending: boolean } | null;
  unlinking: boolean;
  onUnlink: () => void;
  onEdit: () => void;
  onPair: () => void;
}) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // The platform's name in the reader's language where it has one («تيليجرام»), else its own.
  const name = platformName(channel.platform, t, spec?.label ?? channel.label);
  const hasSettings =
    (channel.platform === 'telegram' || spec?.settings === true) && channel.link?.linked === true;
  const credentials = channel.login === 'credentials';
  const update = useUpdateChannel(agentId);
  const clear = useClearChannel(agentId);
  const { ask, dialog } = useConfirm();
  const link = channel.link;
  const account = link ? accountOf(link) : '';
  const guide = link?.linked ? guideOf(channel, spec) : null;
  const showGuide = guide !== null && guideOpen;

  const failed = channel.status === 'error' && channel.error;
  const restartNeeded = channel.restart_needed === true;
  const mode = channel.platform === 'whatsapp' && link?.linked ? (link.mode ?? null) : null;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="channel-card"
        data-enabled={channel.enabled || undefined}
        data-testid={`channel-card-${channel.platform}`}
      >
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
              <span className="font-medium" dir="auto">
                {name}
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
              {mode && (
                <span data-testid={`channel-mode-${channel.platform}`} data-mode={mode}>
                  <Badge tone="info">
                    {t(
                      mode === 'self-chat' ? 'channels.mode.badge_self' : 'channels.mode.badge_bot',
                    )}
                  </Badge>
                </span>
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
          {(channel.login === 'token' || (credentials && spec)) && !link?.linked && (
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
          {mode && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`channel-mode-change-${channel.platform}`}
              onClick={onChangeMode}
            >
              {t('channels.mode.change')}
            </Button>
          )}
          {mode === 'self-chat' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`channel-reply-header-${channel.platform}`}
              onClick={onReplyHeader}
            >
              {t('channels.reply_header.open')}
            </Button>
          )}
          {guide && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showGuide}
              data-testid={`channel-guide-${channel.platform}`}
              onClick={() => setGuideOpen(!showGuide)}
            >
              {t('channels.guide')}
            </Button>
          )}
          {link?.linked && (
            <Button
              size="sm"
              variant="danger-quiet"
              data-testid={`channel-unlink-${channel.platform}`}
              disabled={unlinking}
              onClick={() => {
                void ask({
                  title: t('channels.unlink_title', { name }),
                  body:
                    channel.platform === 'telegram'
                      ? t('channels.telegram.unlink_body')
                      : credentials
                        ? t('channels.platform.unlink_body', { name })
                        : t('channels.unlink_body'),
                  confirmLabel: t('channels.unlink'),
                }).then((yes) => {
                  if (yes) onUnlink();
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
        {(showGuide || failed || restartNeeded || waiting > 0) && (
          <div className="channel-card-body">
            {restartNeeded && (
              <Notice tone="warning">
                <span
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`channel-restart-needed-${channel.platform}`}
                >
                  <span>{t('channels.restart_needed', { name })}</span>
                  {restart && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={restart.pending}
                      data-testid={`channel-restart-now-${channel.platform}`}
                      onClick={() => void restart.restart()}
                    >
                      {t('channels.restart_now')}
                    </Button>
                  )}
                </span>
              </Notice>
            )}
            {failed && (
              <Notice tone="danger">
                <span dir="auto">{channel.error}</span>
              </Notice>
            )}
            {waiting > 0 && (
              <button
                type="button"
                className="link self-start text-sm underline"
                data-testid={`channel-waiting-${channel.platform}`}
                onClick={onReview}
              >
                {t('channels.approvals.waiting_review', { count: String(waiting) })}
              </button>
            )}
            {showGuide && guide}
          </div>
        )}
      </div>
      {hasSettings && settingsOpen && (
        <ChannelSettingsPanel
          agentId={agentId}
          platform={channel.platform}
          name={name}
          gateway={gateway}
        />
      )}
    </div>
  );
}

/**
 * The platform's own "how to start", once it is linked; null when it has none. No restart step:
 * where the hub runs Hermes a change applies at once, and where it does not the page's note says
 * to restart.
 */
function guideOf(channel: Channel, spec: ChannelPlatform | null): ReactNode {
  const link = channel.link;
  if (!link?.linked) return null;
  if (channel.platform === 'whatsapp') return <HowToUse link={link} />;
  if (channel.platform === 'telegram') return <TelegramHowTo link={link} />;
  if (channel.login === 'credentials' && spec?.support === 'full') {
    return <PlatformHowTo spec={spec} />;
  }
  return null;
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
      <p className="text-xs text-muted" data-testid="channel-gateway-note">
        {t('channels.restart_note')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <p className="flex flex-wrap items-center gap-2" data-testid="channel-gateway-note">
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
      </p>
      {gateway.error && (
        <p className="text-danger-soft-text" dir="auto">
          {gateway.error}
        </p>
      )}
    </div>
  );
}

/**
 * What to do once WhatsApp is linked, in plain words: in «أنا» mode, write to the agent in
 * "Message yourself"; in «بوت» mode, message the number from another account and approve the
 * first request — with what linking a personal number that way means.
 */
function HowToUse({ link }: { link: ChannelLink }) {
  const { t } = useI18n();
  const account = accountOf(link);
  if (link.mode === 'self-chat') {
    return (
      <Notice tone="info">
        <span
          className="flex flex-col gap-1"
          data-testid="channel-how-to-use"
          data-mode="self-chat"
        >
          <strong>{t('channels.how.title')}</strong>
          <span dir="auto">
            {account
              ? t('channels.how.self_step_open_as', { account })
              : t('channels.how.self_step_open')}
          </span>
          <span>{t('channels.how.self_step_write')}</span>
          <span>{t('channels.how.self_note')}</span>
        </span>
      </Notice>
    );
  }
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
function TelegramHowTo({ link }: { link: ChannelLink }) {
  const { t } = useI18n();
  const username = link.account_username;
  const url = username ? `https://t.me/${username}` : null;
  return (
    <Notice tone="info">
      <span className="flex flex-col gap-1" data-testid="telegram-how-to-use">
        <strong>{t('channels.telegram.how_title')}</strong>
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
  const nameOf = useProfileName();
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
                {describeToolError(link.error, t, nameOf)}
              </span>
            </Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The platform's setup steps, as many as its words have (`channels.platform.<p>.stepN`). */
function stepsOf(platform: string, t: (key: string) => string): string[] {
  const steps: string[] = [];
  for (let index = 1; index <= 9; index += 1) {
    const key = `channels.platform.${platform}.step${index}`;
    const text = t(key);
    if (text === key) break;
    steps.push(text);
  }
  return steps;
}

/** A platform's own words for `key`, or the shared ones. */
function wordsOf(t: (key: string, values?: Record<string, string>) => string) {
  return (platform: string, key: string, values?: Record<string, string>): string => {
    const own = `channels.platform.${platform}.${key}`;
    const text = t(own, values);
    return text === own ? t(`channels.platform.${key}`, values) : text;
  };
}

/** What to do once a platform is linked, in plain words. */
function PlatformHowTo({ spec }: { spec: ChannelPlatform }) {
  const { t } = useI18n();
  const name = platformName(spec.platform, t, spec.label);
  return (
    <Notice tone="info">
      <span className="flex flex-col gap-1" data-testid={`platform-how-${spec.platform}`}>
        <strong>{t('channels.platform.how_title', { name })}</strong>
        <span>{t(`channels.platform.${spec.platform}.how`)}</span>
        {spec.pairs && <span>{t('channels.platform.how_pairs')}</span>}
        {spec.allowlist && <span>{t('channels.platform.how_allowlist')}</span>}
      </span>
    </Notice>
  );
}

/** Entries typed as a person likes: commas (Latin or Arabic), spaces, new lines. */
function entriesOf(text: string): string[] {
  return text
    .split(/[\s,،]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * «ربط <المنصة>»: the steps in plain words, the variables the platform takes, and who may message
 * the agent. Where the hub can ask the platform it does, before storing anything, so a wrong
 * value is said here in the platform's words; the generic platforms say they are not checked.
 */
function PlatformLinkDialog({
  agentId,
  spec,
  gateway,
  onClose,
}: {
  agentId: string | undefined;
  spec: ChannelPlatform;
  gateway: ChannelGateway | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const nameOf = useProfileName();
  const link = useLinkChannel(agentId);
  const words = wordsOf(t);
  const name = platformName(spec.platform, t, spec.label);
  const full = spec.support === 'full';
  const [values, setValues] = useState<Record<string, string>>({});
  const [allowed, setAllowed] = useState('');
  const entries = entriesOf(allowed);
  const missing = spec.credentials.some(
    (credential) => credential.required && (values[credential.key] ?? '').trim() === '',
  );
  const done = link.data?.link?.linked ? link.data.link : null;
  const account = done ? accountOf(done) : '';
  const steps = full ? stepsOf(spec.platform, t) : [];
  const fieldLabel = (key: string) => {
    const own = `channels.platform.field.${key}`;
    const text = t(own);
    return text === own ? key : text;
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('channels.platform.link_title', { name })}
      description={
        full
          ? t(`channels.platform.${spec.platform}.intro`)
          : t('channels.platform.generic_intro', { name })
      }
      closeLabel={t('common.cancel')}
      testId="platform-link"
      footer={
        done ? (
          <Button onClick={onClose} data-testid="platform-link-close">
            {t('channels.login.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={link.isPending || missing}
              data-testid="platform-link-submit"
              onClick={() => {
                const credentials: Record<string, string> = {};
                for (const credential of spec.credentials) {
                  const value = (values[credential.key] ?? '').trim();
                  if (value !== '' || !credential.required) credentials[credential.key] = value;
                }
                link.mutate({
                  platform: spec.platform,
                  credentials,
                  ...(spec.allowed_users_key && entries.length > 0
                    ? { allowed_users: entries }
                    : {}),
                });
              }}
            >
              {link.isPending
                ? t('channels.platform.checking', { name })
                : spec.validates
                  ? t('channels.platform.submit_check')
                  : t('channels.platform.submit')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Notice tone="success">
          <span className="flex flex-col gap-1" data-testid="platform-link-done">
            <span dir="auto">
              {account ? t('channels.platform.done_as', { account }) : t('channels.platform.done')}
            </span>
            <span>
              {gateway?.applies === 'on_restart'
                ? t('channels.platform.done_restart')
                : t('channels.platform.done_now')}
            </span>
            {full && <span>{t(`channels.platform.${spec.platform}.how`)}</span>}
          </span>
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          {steps.length > 0 && (
            <ol
              className="flex list-decimal flex-col gap-1 ps-5 text-sm"
              data-testid="platform-steps"
            >
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {spec.docs_url && (
            <a
              href={spec.docs_url}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
              dir="ltr"
              data-testid="platform-docs"
            >
              {spec.docs_url}
            </a>
          )}
          {!full && (
            <Notice tone="warning">
              <span data-testid="platform-generic-note">{t('channels.platform.generic_note')}</span>
            </Notice>
          )}
          {spec.packages === 'first_use' && (
            <Notice>
              <span data-testid="platform-first-use">{t('channels.platform.first_use_note')}</span>
            </Notice>
          )}
          {spec.inbound && (
            <Notice tone="warning">
              <span data-testid="platform-inbound">{t('channels.platform.inbound_note')}</span>
            </Notice>
          )}
          {spec.program && (
            <Notice tone="warning">
              <span data-testid="platform-program">
                {t('channels.platform.program_note', { program: spec.program })}
              </span>
            </Notice>
          )}
          {spec.credentials.map((credential) => (
            <Field
              key={credential.key}
              label={
                credential.required
                  ? fieldLabel(credential.key)
                  : t('channels.platform.optional', { label: fieldLabel(credential.key) })
              }
              {...(credential.kind === 'secret'
                ? { hint: t('channels.platform.secret_hint') }
                : {})}
            >
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  type={
                    credential.kind === 'secret'
                      ? 'password'
                      : credential.kind === 'email'
                        ? 'email'
                        : credential.kind === 'number'
                          ? 'number'
                          : 'text'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  value={values[credential.key] ?? ''}
                  data-testid={`platform-field-${credential.key}`}
                  onChange={(event) =>
                    setValues({ ...values, [credential.key]: event.target.value })
                  }
                />
              )}
            </Field>
          ))}
          {spec.allowed_users_key && (
            <Field
              label={words(spec.platform, 'allowed')}
              hint={
                full
                  ? words(spec.platform, 'allowed_hint')
                  : t('channels.platform.allowed_hint_generic', { key: spec.allowed_users_key })
              }
            >
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  value={allowed}
                  data-testid="platform-allowed"
                  onChange={(event) => setAllowed(event.target.value)}
                />
              )}
            </Field>
          )}
          {spec.allowlist && entries.length === 0 && (
            <Notice tone="warning">
              <span data-testid="platform-allowlist-empty">
                {t('channels.platform.allowlist_empty', { name })}
              </span>
            </Notice>
          )}
          {link.isError && (
            <Notice tone="danger">
              <span data-testid="platform-link-error" dir="auto">
                {describeToolError(link.error, t, nameOf)}
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

/** Rows grouped by platform, in the order the platforms first appear. */
function byPlatform<T extends { platform: string }>(rows: readonly T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.platform);
    if (group) group.push(row);
    else groups.set(row.platform, [row]);
  }
  return [...groups];
}

/**
 * «الموافقات»: the senders Hermes answered with a pairing code in this profile, grouped by
 * platform, each approved or denied here; and the approved senders per platform, each removable.
 * One panel for every platform that pairs (WhatsApp, Telegram, Slack…), opened from the page's
 * header or from a card with somebody waiting.
 */
function ApprovalsSheet({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const pairing = usePairing(agentId);
  const approve = useApprovePairing(agentId);
  const deny = useDenyPairing(agentId);
  const revoke = useRevokePairing(agentId);
  const { ask, dialog } = useConfirm();
  const pending = pairing.data?.pending ?? [];
  const approved = pairing.data?.approved ?? [];
  const failed = approve.error ?? deny.error ?? revoke.error;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('channels.approvals.title')}
      closeLabel={t('channels.approvals.close')}
      testId="approvals-sheet"
    >
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
          <div className="flex flex-col gap-3" data-testid="pairing-pending">
            {byPlatform(pending).map(([platform, rows]) => (
              <div
                key={platform}
                className="flex flex-col gap-2"
                data-testid={`pairing-pending-${platform}`}
              >
                <h3 className="text-sm font-semibold">{platformName(platform, t)}</h3>
                <ul className="flex flex-col gap-2">
                  {rows.map((request) => (
                    <li
                      key={`${request.platform}:${request.request_id}`}
                      className="skill-row"
                      data-testid={`pairing-request-${request.request_id}`}
                    >
                      <span className="skill-open">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge>{platformName(request.platform, t)}</Badge>
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
                      <PairingDecision
                        request={request}
                        busy={approve.isPending || deny.isPending}
                        onApprove={() => approve.mutate(request)}
                        onDeny={() => deny.mutate(request)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <h2 className="text-base font-semibold">{t('channels.pairing.approved_title')}</h2>
        {pairing.data && approved.length === 0 && (
          <p className="text-sm text-muted" data-testid="pairing-approved-none">
            {t('channels.pairing.approved_none')}
          </p>
        )}
        {approved.length > 0 && (
          <div className="flex flex-col gap-3" data-testid="pairing-approved">
            {byPlatform(approved).map(([platform, rows]) => (
              <div
                key={platform}
                className="flex flex-col gap-2"
                data-testid={`pairing-approved-${platform}`}
              >
                <h3 className="text-sm font-semibold">{platformName(platform, t)}</h3>
                <ul className="flex flex-col gap-2">
                  {rows.map((sender) => (
                    <li
                      key={`${sender.platform}:${sender.user_id}`}
                      className="skill-row"
                      data-testid={`pairing-sender-${sender.user_id}`}
                    >
                      <span className="skill-open">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge>{platformName(sender.platform, t)}</Badge>
                          <span className="font-medium" dir="auto">
                            {sender.user_name || t('channels.pairing.unnamed')}
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
                              name: sender.user_name || sender.user_id,
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
              </div>
            ))}
          </div>
        )}
        {dialog}
      </section>
    </Sheet>
  );
}

/** The two ways a WhatsApp number is used, as the person chooses them. */
function useModeOptions() {
  const { t } = useI18n();
  return [
    { value: 'bot', label: t('channels.mode.bot'), hint: t('channels.mode.bot_hint') },
    { value: 'self-chat', label: t('channels.mode.self'), hint: t('channels.mode.self_hint') },
  ] as const;
}

/**
 * «تغيير الوضع»: how the linked number is used. The phone stays linked; the hub rewrites the mode
 * and restarts the gateway that serves the profile itself.
 */
function ModeDialog({
  agentId,
  channel,
  onClose,
}: {
  agentId: string | undefined;
  channel: Channel;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const setMode = useSetChannelMode(agentId);
  const options = useModeOptions();
  const [mode, setModeValue] = useState<WhatsAppMode | null>(channel.link?.mode ?? null);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('channels.mode.change_title')}
      description={t('channels.mode.change_note')}
      closeLabel={t('common.cancel')}
      testId="channel-mode-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="channel-mode-save"
            disabled={!mode || mode === channel.link?.mode || setMode.isPending}
            onClick={() => {
              if (!mode) return;
              setMode.mutate({ platform: channel.platform, mode }, { onSuccess: onClose });
            }}
          >
            {t('channels.mode.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {setMode.isError && <Notice tone="danger">{describeToolError(setMode.error, t)}</Notice>}
        <Radio
          label={t('channels.mode.title')}
          value={mode}
          onChange={(next) => setModeValue(next as WhatsAppMode)}
          options={options}
          testId="channel-mode-choice"
        />
      </div>
    </Dialog>
  );
}

/** Hermes's rule under a reply header's title (`channels.ts` §REPLY_RULE on the hub). */
const REPLY_RULE = '────────────';
const REPLY_TITLE_MAX = 64;

/**
 * «عنوان الردود»: in «مراسلة نفسي» the owner and the agent write from one number, so Hermes puts a
 * header over every reply of the agent. The agent's name (the default) or a typed title, shown as
 * the reply will start. While nothing is written Hermes's own header shows, and the agent's name is
 * picked for the person to save. There is no "no header": Hermes's bridge puts its own back.
 */
function ReplyHeaderDialog({
  agentId,
  agentName,
  channel,
  onClose,
}: {
  agentId: string | undefined;
  agentName: string;
  channel: Channel;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const setHeader = useSetChannelReplyHeader(agentId);
  const current = channel.link?.reply_title ?? null;
  const [use, setUse] = useState<'agent_name' | 'custom'>(
    current === null || current === agentName ? 'agent_name' : 'custom',
  );
  const [text, setText] = useState(current !== null && current !== agentName ? current : '');
  const title = (use === 'agent_name' ? agentName : text).replace(/\s+/g, ' ').trim();
  const usable = title !== '' && [...title].length <= REPLY_TITLE_MAX;
  const unchanged = current !== null && title === current;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('channels.reply_header.title')}
      description={t('channels.reply_header.note')}
      closeLabel={t('common.cancel')}
      testId="channel-reply-header-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="channel-reply-header-save"
            disabled={!usable || unchanged || setHeader.isPending}
            onClick={() =>
              setHeader.mutate(
                {
                  platform: channel.platform,
                  header: use === 'custom' ? { use, title } : { use },
                },
                { onSuccess: onClose },
              )
            }
          >
            {t('channels.reply_header.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {current === null && (
          <p className="text-sm text-muted" data-testid="channel-reply-header-hermes">
            {t('channels.reply_header.hermes_now')}
          </p>
        )}
        <Radio
          label={t('channels.reply_header.title')}
          value={use}
          onChange={(next) => setUse(next as 'agent_name' | 'custom')}
          options={[
            {
              value: 'agent_name',
              label: agentName
                ? t('channels.reply_header.agent_name', { name: agentName })
                : t('channels.reply_header.agent_name_plain'),
            },
            { value: 'custom', label: t('channels.reply_header.custom') },
          ]}
          testId="channel-reply-header-choice"
        />
        {use === 'custom' && (
          <Field
            label={t('channels.reply_header.custom_label')}
            hint={t('channels.reply_header.custom_hint')}
          >
            {(props) => (
              <Input
                {...props}
                dir="auto"
                autoComplete="off"
                maxLength={REPLY_TITLE_MAX}
                value={text}
                data-testid="channel-reply-header-text"
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </Field>
        )}
        {usable && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{t('channels.reply_header.preview')}</span>
            <div
              className="rounded-md border border-line p-2"
              data-testid="channel-reply-header-preview"
            >
              <strong dir="auto">{title}</strong>
              <div aria-hidden="true">{REPLY_RULE}</div>
              <span className="text-muted">{t('channels.reply_header.preview_body')}</span>
            </div>
          </div>
        )}
        <p className="text-xs text-muted">{t('channels.reply_header.no_none')}</p>
        {setHeader.isError && (
          <Notice tone="danger">{describeToolError(setHeader.error, t)}</Notice>
        )}
      </div>
    </Dialog>
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
 * Pairing by QR. First the person says how the number will be used — «بوت» or «أنا» — nothing is
 * picked for them; then one `channel_login` job in that mode draws the code. Closing the dialog
 * before the phone is linked cancels the job, and the hub tells Hermes to forget the pairing.
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
  const options = useModeOptions();
  const [choice, setChoice] = useState<WhatsAppMode | null>(null);
  const [mode, setMode] = useState<WhatsAppMode | null>(null);

  const start = (chosen: WhatsAppMode) => {
    setMode(chosen);
    setJobId(null);
    login.mutate({ platform, mode: chosen }, { onSuccess: (data) => setJobId(data.job_id) });
  };

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
  const personal = (state.mode ?? mode) === 'self-chat';
  const doneKey =
    state.applies === 'now'
      ? personal
        ? account
          ? 'channels.login.done_as_self_now'
          : 'channels.login.done_self_now'
        : account
          ? 'channels.login.done_as_now'
          : 'channels.login.done_now'
      : account
        ? 'channels.login.done_as'
        : 'channels.login.done';

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
          {!mode && (
            <Button
              variant="primary"
              disabled={!choice}
              onClick={() => choice && start(choice)}
              data-testid="channel-pair-continue"
            >
              {t('channels.mode.continue')}
            </Button>
          )}
          {mode && job && (job.status === 'failed' || job.status === 'cancelled') && (
            <Button onClick={() => start(mode)} data-testid="channel-pair-again">
              {t('channels.login.again')}
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            {done ? t('channels.login.close') : t('common.cancel')}
          </Button>
        </>
      }
    >
      {!mode ? (
        <div className="flex flex-col gap-3" data-testid="channel-pair-mode">
          <p className="text-sm font-medium">{t('channels.mode.title')}</p>
          <Radio
            label={t('channels.mode.title')}
            value={choice}
            onChange={(next) => setChoice(next as WhatsAppMode)}
            options={options}
            testId="channel-pair-mode-choice"
          />
        </div>
      ) : (
        <div
          className="flex flex-col items-center gap-3"
          data-status={job?.status ?? 'starting'}
          data-mode={mode}
        >
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
          {!done && job?.progress?.message && (
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
          {!done && !personal && (
            <Notice tone="warning">
              <span data-testid="channel-pair-warning">{t('channels.how.personal_warning')}</span>
            </Notice>
          )}
          {job?.status === 'succeeded' && (
            <Notice tone="success">
              <span data-testid="channel-pair-done" dir="auto">
                {t(doneKey, { account })}
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
      )}
    </Dialog>
  );
}
