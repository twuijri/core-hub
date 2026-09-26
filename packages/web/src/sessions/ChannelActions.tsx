/**
 * What a person can do with a channel conversation (contract decision §87), wherever it shows:
 * its row in the chats list and the bar of its open transcript.
 *
 * - **Hide** takes it out of the person's own list — nobody else's, and Hermes keeps it. "Show
 *   hidden" at the foot of the list brings hidden ones back into view, each with "Show again".
 * - **Delete from Hermes** is an admin's: it goes from Hermes's store with its messages, for
 *   everyone, and cannot be undone — so it asks first and says so. The chat on the channel
 *   itself (the person's Telegram) is not touched.
 */
import { useNavigate } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { useConfirm, useToast } from '../ui/index.js';
import {
  channelName,
  conversationTitle,
  useChannelConversationWrites,
  type ChannelConversation,
} from './channels.js';

export function useChannelActions(options: { openId?: string | undefined } = {}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const writes = useChannelConversationWrites();
  const canDelete = user?.role === 'owner' || user?.role === 'admin';
  const failed = (error: unknown) =>
    toast({
      title: t('sessions.channels.action_failed'),
      body: describeError(error, t),
      tone: 'danger',
    });

  const hide = (conversation: ChannelConversation) =>
    writes.hide.mutate(conversation, {
      onSuccess: () =>
        toast({
          title: t('sessions.channels.hidden_toast', { title: conversationTitle(conversation, t) }),
          body: t('sessions.channels.hidden_toast_body'),
        }),
      onError: failed,
    });

  const unhide = (conversation: ChannelConversation) =>
    writes.unhide.mutate(conversation, { onError: failed });

  const remove = async (conversation: ChannelConversation) => {
    const sure = await ask({
      title: t('sessions.channels.delete_title', { title: conversationTitle(conversation, t) }),
      body: t('sessions.channels.delete_body', { channel: channelName(conversation.channel, t) }),
      confirmLabel: t('sessions.channels.delete_confirm'),
    });
    if (!sure) return;
    writes.remove.mutate(conversation, {
      onSuccess: () => {
        if (options.openId === conversation.id) navigate(routeOf('new_chat'));
      },
      onError: failed,
    });
  };

  return { hide, unhide, remove, canDelete, dialog };
}
