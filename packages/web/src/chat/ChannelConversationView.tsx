// A conversation held on Telegram, WhatsApp… as Hermes keeps it (contract decision §61), in
// the chat screen's own look — the person on the channel on one side, the agent's replies on the
// other — but read-only: the hub cannot write to it, so where the composer would be there is the
// banner saying where the reply is made. It is read again every half minute while open.
// "Continue in Core Hub" (§62) carries it into a new hub chat with the transcript attached.
// Older messages are read a page at a time when asked, and the pictures the person sent are
// drawn in their bubble while Hermes still keeps them (§103).
import { useEffect, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles } from '../shell/profiles.js';
import {
  channelName,
  conversationTitle,
  useChannelConversation,
  useChannelPicture,
  useOlderChannelMessages,
  type ChannelMessage,
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

export function ChannelConversationView({ id }: { id: string }) {
  const { t } = useI18n();
  const { profile, homeProfile } = useAuth();
  const actions = useChannelActions({ openId: id });
  const manyProfiles = useManyProfiles();
  const read = useChannelConversation(id);
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
              grouped={index > 0 && messages[index - 1]?.role === message.role}
            />
          ))}
        </div>
        {/* Where the composer would be: why there is none, and where the reply is made. */}
        {conversation && (
          <div className="composer-dock flex flex-col gap-2">
            <div data-testid="channel-readonly">
              <Notice tone="info">{t('sessions.channels.readonly_banner', { channel })}</Notice>
            </div>
            <ContinueChannel id={id} channel={channel} />
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** One message: the person on the channel as a bubble, the agent's reply as the chat draws it. */
function ChannelMessageView({
  conversationId,
  message,
  peer,
  grouped,
}: {
  conversationId: string;
  message: ChannelMessage;
  peer: string;
  grouped: boolean;
}) {
  const { t } = useI18n();
  const pictures = message.attachments ?? [];
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
      </div>
    </article>
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
