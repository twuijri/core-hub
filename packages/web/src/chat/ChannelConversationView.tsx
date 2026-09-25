// A conversation held on Telegram, WhatsApp… as Hermes keeps it (contract decision §55), in
// the chat screen's own look — the person on the channel on one side, the agent's replies on the
// other — but read-only: the hub cannot write to it, so where the composer would be there is the
// banner saying where the reply is made. It is read again every half minute while open.
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
  type ChannelMessage,
} from '../sessions/channels.js';
import { Avatar, Badge, EmptyState, Notice, SkeletonText } from '../ui/index.js';
import { IconGlobe } from '../ui/icons.js';
import { Markdown } from './Markdown.js';

export function ChannelConversationView({ id }: { id: string }) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const manyProfiles = useManyProfiles();
  const read = useChannelConversation(id);
  const conversation = read.data?.conversation;
  const channel = conversation ? channelName(conversation.channel, t) : '';
  const peer = conversation ? conversationTitle(conversation, t) : '';
  const messages = read.data?.items ?? [];
  return (
    <AppShell title={conversation ? peer : t(termKey('chat'))}>
      <div
        className="chat-flow"
        data-empty="false"
        data-view="chat"
        data-testid="channel-screen"
        data-conversation-id={id}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="chat-header">
          {conversation && (
            <Badge tone="neutral" testId="channel-badge">
              {channel}
            </Badge>
          )}
          {manyProfiles && <ProfileBadge profile={profile} testId="chat-profile" />}
          {/* Hermes's own title, beside the other party's name the page is called by. */}
          {conversation?.title && conversation.title !== peer && (
            <span className="min-w-0 truncate text-sm text-muted" dir="auto">
              {conversation.title}
            </span>
          )}
        </div>
        {read.isPending && (
          <div className="flex flex-col gap-6 py-4">
            <SkeletonText lines={2} label={t('common.loading')} />
            <SkeletonText lines={4} label={t('common.loading')} />
          </div>
        )}
        {read.isError && <Notice tone="danger">{describeError(read.error, t)}</Notice>}
        <div className="chat-stream chat-turns" data-testid="channel-transcript">
          {read.data?.has_more && (
            <p className="msg-system" data-testid="channel-has-more">
              {t('sessions.channels.has_more')}
            </p>
          )}
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
              message={message}
              peer={peer}
              grouped={index > 0 && messages[index - 1]?.role === message.role}
            />
          ))}
        </div>
        {/* Where the composer would be: why there is none, and where the reply is made. */}
        {conversation && (
          <div className="composer-dock" data-testid="channel-readonly">
            <Notice tone="info">{t('sessions.channels.readonly_banner', { channel })}</Notice>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** One message: the person on the channel as a bubble, the agent's reply as the chat draws it. */
function ChannelMessageView({
  message,
  peer,
  grouped,
}: {
  message: ChannelMessage;
  peer: string;
  grouped: boolean;
}) {
  const { t } = useI18n();
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
          <div className="msg-bubble msg-user" data-role="user">
            <p dir="auto">{message.text}</p>
          </div>
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
