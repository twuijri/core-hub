// A conversation held on Telegram, WhatsApp… as Hermes keeps it (contract decision §61), in
// the chat screen's own look — the person on the channel on one side, the agent's replies on the
// other. An admin may write into a Telegram or WhatsApp one from here (§153): the composer posts
// on the channel first, as «من كور هب (<name>): …», then the agent answers there; the message
// shows at once and says what became of it, and the reply appears when the agent's turn ends.
// Where it cannot be written into, the composer's place says why, in plain words. The
// conversation stays the channel's: same label, same group in the list. "Continue in Core Hub"
// (§62) stays a separate action. The hub announces each turn (`channel_conversation.updated`);
// the polling is only a fallback. Older messages are read a page at a time when asked, and the
// pictures the person sent are drawn in their bubble while Hermes still keeps them (§103).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { intlLocale } from '../i18n/index.js';
import { messageTime } from './MessageActions.js';
import { Tooltip } from '../ui/Tooltip.js';
import { termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles } from '../shell/profiles.js';
import {
  channelHref,
  channelName,
  conversationTitle,
  useChannelConversation,
  useChannelPicture,
  useChannelUpdates,
  useOlderChannelMessages,
  type ChannelMessage,
  type ChannelOutgoing,
} from '../sessions/channels.js';
import { useChannelActions } from '../sessions/ChannelActions.js';
import { TopBarActions } from '../shell/topBarSlot.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  SkeletonText,
} from '../ui/index.js';
import { IconEyeOff, IconGlobe, IconMore, IconTrash } from '../ui/icons.js';
import { Markdown } from './Markdown.js';
import { ContinueChannel } from './ContinueChannel.js';
import { ChannelComposer, sendUnavailableText } from './ChannelComposer.js';

export function ChannelConversationView({ id }: { id: string }) {
  const { t } = useI18n();
  const { profile, homeProfile } = useAuth();
  const actions = useChannelActions({ openId: id });
  const manyProfiles = useManyProfiles();
  const navigate = useNavigate();
  useChannelUpdates();
  const read = useChannelConversation(id);
  // The words on their way to the channel, shown before the hub answers.
  const [sending, setSending] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => setSending(null), [id]);
  const conversation = read.data?.conversation;
  const channel = conversation ? channelName(conversation.channel, t) : '';
  const peer = conversation ? conversationTitle(conversation, t) : '';
  // Pages before the latest one, oldest first, as the person asked for them.
  const [older, setOlder] = useState<{ items: ChannelMessage[]; next: number | null } | null>(null);
  useEffect(() => setOlder(null), [id]);
  const loadOlder = useOlderChannelMessages(id);
  const latest = read.data?.items ?? [];
  const seen = new Set(latest.map((message) => message.id));
  const messages = [...(older?.items ?? []).filter((message) => !seen.has(message.id)), ...latest];
  // What the hub's people wrote from here and the hub still follows (§153): a message the
  // transcript has shows its state under it; one it does not have yet is drawn after the rest.
  const outgoing = (read.data as { outgoing?: ChannelOutgoing[] } | undefined)?.outgoing ?? [];
  const shownIds = new Set(messages.map((message) => message.id));
  const followed = new Map(
    outgoing
      .filter((each) => each.message_id && shownIds.has(each.message_id))
      .map((each) => [each.message_id!, each]),
  );
  const pending = outgoing.filter((each) => !each.message_id || !shownIds.has(each.message_id));
  const nextOffset = older ? older.next : (read.data?.next_offset ?? null);
  const hasMore = older ? older.next !== null : read.data?.has_more === true;
  const readOlder = () => {
    if (nextOffset === null) return;
    loadOlder.mutate(nextOffset, {
      onSuccess: (page) =>
        setOlder((current) => ({
          items: [...page.items, ...(current?.items ?? [])],
          next: page.next_offset ?? null,
        })),
    });
  };
  return (
    <AppShell title={conversation ? peer : t(termKey('chat'))}>
      <div
        className="chat-flow"
        data-empty="false"
        data-view="chat"
        data-testid="channel-screen"
        data-conversation-id={id}
      >
        {/* The conversation's controls, pinned in the top bar like a chat's (ConversationBar). */}
        <TopBarActions>
          <div className="convo-bar" data-testid="chat-header">
            {conversation && (
              <Badge tone="neutral" testId="channel-badge">
                {channel}
              </Badge>
            )}
            {manyProfiles && profile !== homeProfile && (
              <ProfileBadge profile={profile} testId="chat-profile" />
            )}
            {conversation && (
              <Menu
                side="bottom"
                align="end"
                tooltip={t('sessions.channels.actions')}
                testId="channel-actions-menu"
                trigger={
                  <button
                    type="button"
                    className="btn btn-ghost px-1.5"
                    aria-label={t('sessions.channels.actions')}
                    data-testid="channel-actions"
                  >
                    <IconMore />
                  </button>
                }
              >
                <MenuItem
                  icon={<IconEyeOff size={14} />}
                  onSelect={() => actions.hide(conversation)}
                >
                  {t('sessions.channels.hide')}
                </MenuItem>
                {actions.canDelete && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<IconTrash size={14} />}
                      tone="danger"
                      onSelect={() => void actions.remove(conversation)}
                    >
                      {t('sessions.channels.delete')}
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </div>
        </TopBarActions>
        {actions.dialog}
        {/* Hermes's own title, beside the other party's name the page is called by. */}
        {conversation?.title && conversation.title !== peer && (
          <p className="mb-3 min-w-0 truncate text-sm text-muted" dir="auto">
            {conversation.title}
          </p>
        )}
        {read.isPending && (
          <div className="flex flex-col gap-6 py-4">
            <SkeletonText lines={2} label={t('common.loading')} />
            <SkeletonText lines={4} label={t('common.loading')} />
          </div>
        )}
        {read.isError && <Notice tone="danger">{describeError(read.error, t)}</Notice>}
        <div className="chat-stream chat-turns" data-testid="channel-transcript">
          {hasMore &&
            (nextOffset !== null ? (
              <div className="flex justify-center py-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loadOlder.isPending}
                  onClick={readOlder}
                  data-testid="channel-older"
                >
                  {t('sessions.channels.load_older')}
                </Button>
              </div>
            ) : (
              <p className="msg-system" data-testid="channel-has-more">
                {t('sessions.channels.has_more')}
              </p>
            ))}
          {loadOlder.isError && <Notice tone="danger">{describeError(loadOlder.error, t)}</Notice>}
          {read.data && messages.length === 0 && (
            <EmptyState
              size="sm"
              icon={<IconGlobe size={18} />}
              title={t('sessions.channels.no_messages')}
            />
          )}
          {messages.map((message, index) => (
            <ChannelMessageView
              key={message.id}
              conversationId={id}
              message={message}
              peer={peer}
              channel={channel}
              followed={followed.get(message.id) ?? null}
              grouped={
                index > 0 &&
                messages[index - 1]?.role === message.role &&
                (messages[index - 1]?.origin ?? 'channel') === (message.origin ?? 'channel')
              }
            />
          ))}
          {pending.map((each) => (
            <HubMessage
              key={each.id}
              name={each.author_name}
              text={each.text}
              channel={channel}
              status={each}
            />
          ))}
          {sending && !pending.some((each) => each.client_message_id === sending.key) && (
            <HubMessage name={null} text={sending.text} channel={channel} status={null} />
          )}
        </div>
        {/* The composer for an admin; otherwise in its place: why not, and where to reply. */}
        {conversation && (
          <div className="composer-dock flex flex-col gap-2">
            {conversation.can_send ? (
              <ChannelComposer id={id} channel={channel} peer={peer} onSending={setSending} />
            ) : (
              <div data-testid="channel-readonly">
                <Notice tone="info">
                  {/* A hub that does not run Hermes reads as it always did (§61). */}
                  {conversation.send_unavailable &&
                  conversation.send_unavailable !== 'hermes_not_managed'
                    ? sendUnavailableText(conversation.send_unavailable, channel, t)
                    : t('sessions.channels.readonly_banner', { channel })}
                </Notice>
                {conversation.send_unavailable === 'not_current' && conversation.current_id && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    onClick={() =>
                      navigate(channelHref(conversation.current_id!, conversation.profile))
                    }
                    data-testid="channel-open-current"
                  >
                    {t('sessions.channels.send.open_current')}
                  </Button>
                )}
              </div>
            )}
            <ContinueChannel id={id} channel={channel} />
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** What became of a message written from the hub, in a line under it (§153). */
function OutgoingStatus({ status, channel }: { status: ChannelOutgoing | null; channel: string }) {
  const { t } = useI18n();
  if (status?.status === 'answered') return null;
  const failed = status?.status === 'failed';
  const text = !status
    ? t('sessions.channels.send.status.sending', { channel })
    : failed
      ? t(`sessions.channels.send.failed.${status.error?.reason ?? 'not_picked_up'}`, { channel })
      : t(`sessions.channels.send.status.${status.status}`, { channel });
  return (
    <p
      className={`text-xs ${failed ? 'text-danger' : 'text-muted'}`}
      role="status"
      dir="auto"
      data-testid="channel-outgoing-status"
      data-status={status?.status ?? 'sending'}
    >
      {text}
      {failed && status.error?.message ? ` (${status.error.message})` : ''}
    </p>
  );
}

/** A message written from the hub: the hub person's bubble, named, with what became of it. */
function HubMessage({
  name,
  text,
  channel,
  status,
  messageId,
  at,
}: {
  name: string | null;
  text: string;
  channel: string;
  /** `null` while the hub has not answered yet; absent for one the hub no longer follows. */
  status?: ChannelOutgoing | null;
  messageId?: string;
  /** When it was sent, once Hermes has it; absent while it is still on its way. */
  at?: string;
}) {
  const { t } = useI18n();
  return (
    <article
      className="msg"
      data-side="user"
      data-grouped="false"
      data-origin="hub"
      data-testid="message-hub"
      {...(messageId ? { 'data-message-id': messageId } : {})}
    >
      <div className="msg-stack">
        <header className="msg-head">
          <span className="msg-name" dir="auto">
            {name
              ? t('sessions.channels.send.from_hub', { name })
              : t('sessions.channels.send.you')}
          </span>
        </header>
        <div className="msg-bubble msg-user" data-role="user">
          <p dir="auto">{text}</p>
        </div>
        {at && <ChannelTime at={at} />}
        {status !== undefined && <OutgoingStatus status={status} channel={channel} />}
      </div>
    </article>
  );
}

/** One message: the person on the channel as a bubble, the agent's reply as the chat draws it. */
function ChannelMessageView({
  conversationId,
  message,
  peer,
  channel,
  followed,
  grouped,
}: {
  conversationId: string;
  message: ChannelMessage;
  peer: string;
  channel: string;
  /** For a message written from the hub that the hub still follows: what became of it. */
  followed: ChannelOutgoing | null;
  grouped: boolean;
}) {
  const { t } = useI18n();
  const pictures = message.attachments ?? [];
  if (message.role === 'user' && message.origin === 'hub') {
    return (
      <HubMessage
        name={message.author_name ?? null}
        text={message.text}
        channel={channel}
        messageId={message.id}
        at={message.created_at}
        {...(followed ? { status: followed } : {})}
      />
    );
  }
  if (message.role === 'user') {
    return (
      <article
        className="msg"
        data-side="user"
        data-grouped={grouped ? 'true' : 'false'}
        data-testid="message-user"
        data-message-id={message.id}
      >
        <div className="msg-stack">
          {!grouped && (
            <header className="msg-head">
              <span className="msg-name" dir="auto">
                {peer}
              </span>
            </header>
          )}
          {pictures.map((picture) => (
            <ChannelPicture
              key={picture.id}
              conversationId={conversationId}
              pictureId={picture.id}
              available={picture.available}
            />
          ))}
          {message.text && (
            <div className="msg-bubble msg-user" data-role="user">
              <p dir="auto">{message.text}</p>
            </div>
          )}
          <ChannelTime at={message.created_at} />
        </div>
      </article>
    );
  }
  const name = t('chat.assistant');
  return (
    <article
      className="msg"
      data-side="agent"
      data-grouped={grouped ? 'true' : 'false'}
      data-testid="message-assistant"
      data-message-id={message.id}
    >
      {grouped ? <span className="msg-gutter" aria-hidden /> : <Avatar name={name} size="sm" />}
      <div className="msg-stack">
        {!grouped && (
          <header className="msg-head">
            <span className="msg-name" dir="auto">
              {name}
            </span>
          </header>
        )}
        <div className="msg-agent-body">
          <Markdown text={message.text} />
        </div>
        <ChannelTime at={message.created_at} />
      </div>
    </article>
  );
}

/**
 * When a channel message was sent, always shown: a conversation read here is read after the
 * fact, so «when» matters more than in a live chat (where the time waits for a hover). The same
 * words as the chat's (`messageTime`); the full date and time on hover, for the reader's zone.
 */
function ChannelTime({ at }: { at: string }) {
  const { t, language } = useI18n();
  const label = messageTime({ created_at: at }, language, t);
  if (!label) return null;
  const full = new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(at));
  return (
    <Tooltip label={full}>
      <time
        className="msg-time msg-time-channel"
        dateTime={at}
        aria-label={full}
        data-testid="channel-message-time"
      >
        {label}
      </time>
    </Tooltip>
  );
}

/**
 * A picture the person sent, drawn from Hermes's image cache through the hub (§103). Hermes
 * deletes those after a day: an older one says so instead of showing a broken image.
 */
function ChannelPicture({
  conversationId,
  pictureId,
  available,
}: {
  conversationId: string;
  pictureId: string;
  available: boolean;
}) {
  const { t } = useI18n();
  const bytes = useChannelPicture(conversationId, pictureId, available);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes.data) return;
    const url = URL.createObjectURL(bytes.data);
    setSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setSrc(null);
    };
  }, [bytes.data]);
  if (!available || bytes.isError) {
    return (
      <p className="msg-system" data-testid="channel-picture-gone">
        {t('sessions.channels.picture_gone')}
      </p>
    );
  }
  if (!src) return <SkeletonText lines={3} label={t('common.loading')} />;
  return (
    <img
      className="msg-image"
      src={src}
      alt={t('sessions.channels.picture')}
      data-testid="channel-picture"
    />
  );
}
