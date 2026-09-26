// Conversations on Telegram, WhatsApp and the other channels, read from Hermes (contract
// decision §61). They are not the hub's sessions: the hub cannot write to them, so they are
// listed beside the chats, in their channel's group, and open as a read-only transcript.
//
// Hermes announces nothing when a channel message arrives, so the list asks again every
// `POLL_MS` while it is on screen (and the tab is visible); the hub answers from what it read
// unless Hermes's store changed, so the polling costs Hermes nothing when nothing happens.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
/** How many of each profile's conversations a list reads, and how many more "older" adds. */
export const CHANNEL_PAGE = 100;
/** The most the hub lists per profile (`limit`, §102). */
export const CHANNEL_MAX = 1000;

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
  filters: {
    allProfiles?: boolean;
    profile?: string | null;
    enabled?: boolean;
    /** Each profile's most recent this many (§102); the hub's own 100 when not said. */
    limit?: number;
  } = {},
) {
  const { client, profile, session } = useAuth();
  const listed = filters.profile ?? profile;
  const limit = filters.limit ?? CHANNEL_PAGE;
  return useQuery({
    queryKey: [...channelKeys.list(filters.allProfiles ? ALL_PROFILES_KEY : listed), limit],
    // The rows already shown stay while a longer list is read.
    placeholderData: (previous) => previous,
    queryFn: async () =>
      (
        await client.request('get', '/channel-conversations', {
          // Hidden ones too, marked: the list leaves them out unless asked to show them (§88).
          query: {
            hidden: 'include' as const,
            ...(filters.allProfiles ? { profiles: 'all' as const } : {}),
            ...(limit !== CHANNEL_PAGE ? { limit } : {}),
          },
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

/**
 * The pages before the latest one, read when the person asks for older messages (§102): each
 * page is Hermes's own, asked from where the one after it stopped (`next_offset`).
 */
export function useOlderChannelMessages(id: string) {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (offset: number) =>
      (
        await client.request('get', '/channel-conversations/{conversation_id}/messages', {
          params: { conversation_id: id },
          query: { offset },
        })
      ).data,
  });
}

/**
 * A picture the person sent on the channel, as an address the page can draw (§102): read with
 * the person's own credentials, kept as a blob for as long as it is on screen.
 */
export function useChannelPicture(conversationId: string, pictureId: string, enabled: boolean) {
  const { client, profile } = useAuth();
  return useQuery({
    queryKey: ['channel-picture', profile, conversationId, pictureId] as const,
    queryFn: async ({ signal }) => {
      const res = await client.request(
        'get',
        '/channel-conversations/{conversation_id}/pictures/{picture_id}',
        {
          params: { conversation_id: conversationId, picture_id: pictureId },
          responseKind: 'bytes',
          signal,
        },
      );
      return new Blob([res.data as unknown as ArrayBuffer], {
        type: res.headers.get('content-type') ?? 'image/jpeg',
      });
    },
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
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

/**
 * Hiding one from the person's own list, showing it again, and — for an admin — deleting it
 * from Hermes for good (contract decision §88). Each in the conversation's own profile; the
 * lists read again afterwards.
 */
export function useChannelConversationWrites() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const settle = () => queryClient.invalidateQueries({ queryKey: channelKeys.all });
  const call =
    (method: 'put' | 'delete', path: '/channel-conversations/{conversation_id}/hidden') =>
    async (conversation: Pick<ChannelConversation, 'id' | 'profile'>) => {
      await client.request(method, path, {
        params: { conversation_id: conversation.id },
        ...inProfile(conversation.profile),
      });
    };
  const hide = useMutation({
    mutationFn: call('put', '/channel-conversations/{conversation_id}/hidden'),
    onSettled: settle,
  });
  const unhide = useMutation({
    mutationFn: call('delete', '/channel-conversations/{conversation_id}/hidden'),
    onSettled: settle,
  });
  const remove = useMutation({
    mutationFn: async (conversation: Pick<ChannelConversation, 'id' | 'profile'>) => {
      await client.request('delete', '/channel-conversations/{conversation_id}', {
        params: { conversation_id: conversation.id },
        ...inProfile(conversation.profile),
      });
    },
    onSettled: settle,
  });
  return { hide, unhide, remove };
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
