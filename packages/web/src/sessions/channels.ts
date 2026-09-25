// Conversations on Telegram, WhatsApp and the other channels, read from Hermes (contract
// decision §55). They are not the hub's sessions: the hub cannot write to them, so they are
// listed beside the chats, in their channel's group, and open as a read-only transcript.
//
// Hermes announces nothing when a channel message arrives, so the list asks again every
// `POLL_MS` while it is on screen (and the tab is visible); the hub answers from what it read
// unless Hermes's store changed, so the polling costs Hermes nothing when nothing happens.
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { ALL_PROFILES_KEY } from '../hub/queries.js';
import type { Translator } from '../i18n/index.js';
import { PROFILE_PARAM } from '../chat/anchor.js';
import { routeOf } from '../navigation/manifest.js';
import type { Schemas } from '../types.js';

export type ChannelConversation = Schemas['ChannelConversation'];
export type ChannelMessage = Schemas['ChannelMessage'];
export type ChannelUnavailable = Schemas['ChannelConversationsUnavailable'];

/** Between two reads of the list while it is open. */
export const POLL_MS = 45_000;
/** Between two reads of an open transcript. */
export const TRANSCRIPT_POLL_MS = 30_000;

/** `?source=channel` on the chat's address: this id is Hermes's, not a hub session's. */
export const SOURCE_PARAM = 'source';
export const CHANNEL_SOURCE = 'channel';

export const channelKeys = {
  all: ['channel-conversations'] as const,
  list: (profile: string) => ['channel-conversations', profile] as const,
  one: (profile: string, id: string) => ['channel-conversation', profile, id] as const,
};

const inProfile = (profile: string | null | undefined) =>
  profile ? { headers: { 'X-Hub-Profile': profile } } : {};

/**
 * The channel conversations of the list's profiles: every profile the person may enter, or
 * the one the list is narrowed to. Off while `enabled` is false (the archive is on screen).
 */
export function useChannelConversations(
  filters: { allProfiles?: boolean; profile?: string | null; enabled?: boolean } = {},
) {
  const { client, profile, session } = useAuth();
  const listed = filters.profile ?? profile;
  return useQuery({
    queryKey: channelKeys.list(filters.allProfiles ? ALL_PROFILES_KEY : listed),
    queryFn: async () =>
      (
        await client.request('get', '/channel-conversations', {
          ...(filters.allProfiles ? { query: { profiles: 'all' as const } } : {}),
          ...inProfile(filters.profile),
        })
      ).data,
    enabled: !!session && (filters.enabled ?? true),
    refetchInterval: POLL_MS,
    // A list nobody is looking at does not need to be current.
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
}

/** One conversation and its messages, in the profile it lives in. */
export function useChannelConversation(id: string) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: channelKeys.one(profile, id),
    queryFn: async () =>
      (
        await client.request('get', '/channel-conversations/{conversation_id}/messages', {
          params: { conversation_id: id },
        })
      ).data,
    refetchInterval: TRANSCRIPT_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** The address a channel conversation opens at: the chat's, marked as Hermes's id. */
export function channelHref(id: string, profile?: string | null): string {
  const base = routeOf('chat').replace(':sessionId?', encodeURIComponent(id));
  const query = new URLSearchParams({ [SOURCE_PARAM]: CHANNEL_SOURCE });
  if (profile) query.set(PROFILE_PARAM, profile);
  return `${base}?${query.toString()}`;
}

/** Whether an address opens a channel conversation. */
export function isChannelAddress(params: URLSearchParams): boolean {
  return params.get(SOURCE_PARAM) === CHANNEL_SOURCE;
}

/** The platform's name in the reader's language: Telegram and WhatsApp translated, others as is. */
export function channelName(platform: string, t: Translator): string {
  if (platform === 'telegram' || platform === 'whatsapp') return t(`sessions.channels.${platform}`);
  return platform;
}

/**
 * What a row is called: the other party, as a messaging app names a chat — else Hermes's title,
 * the party's id, or "A Telegram conversation".
 */
export function conversationTitle(conversation: ChannelConversation, t: Translator): string {
  return (
    conversation.peer_name ??
    conversation.title ??
    conversation.peer_id ??
    t('sessions.channels.untitled', { channel: channelName(conversation.channel, t) })
  );
}

/** The line under the title: the latest message when known, else Hermes's preview. */
export function conversationPreview(conversation: ChannelConversation, t: Translator): string {
  const last = conversation.last_message;
  if (last) return last.role === 'assistant' ? `${t('chat.assistant')}: ${last.text}` : last.text;
  return conversation.preview ?? '';
}

/** The chats list's filter over a conversation: its title, the other party, and its preview. */
export function matchesConversation(conversation: ChannelConversation, needle: string): boolean {
  if (!needle) return true;
  return [
    conversation.title,
    conversation.peer_name,
    conversation.peer_id,
    conversation.last_message?.text,
    conversation.preview,
  ].some((text) => (text ?? '').toLowerCase().includes(needle));
}
