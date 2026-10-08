// Conversations on Telegram, WhatsApp and the other channels, read from Hermes (contract
// decision §61). They are not the hub's sessions: they are listed beside the chats, in their
// channel's group, and open as the channel's transcript. An admin may write into a Telegram or
// WhatsApp one from here (§153): the words go out on the channel, then to the agent, and the
// conversation stays the channel's.
//
// Where the hub's bridge in Hermes's gateway is connected (`live_updates`), every turn on a
// channel is announced as `channel_conversation.updated` and the screens read again then; the
// polling below stays as a slow fallback. Without it (an older hub, a Hermes the hub does not
// run) the list asks again every `POLL_MS` while it is on screen, as before; the hub answers
// from what it read unless Hermes's store changed, so that costs Hermes nothing.
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { isEnvelope } from '../realtime/envelope.js';
import { ALL_PROFILES_KEY } from '../hub/queries.js';
import type { Translator } from '../i18n/index.js';
import { PROFILE_PARAM } from '../chat/anchor.js';
import { routeOf } from '../navigation/manifest.js';
import type { Schemas } from '../types.js';

export type ChannelConversation = Schemas['ChannelConversation'];
export type ChannelMessage = Schemas['ChannelMessage'];
export type ChannelUnavailable = Schemas['ChannelConversationsUnavailable'];
export type ChannelOutgoing = Schemas['ChannelOutgoing'];
export type ChannelSendUnavailable = Schemas['ChannelSendUnavailable'];
type ChannelTranscript = {
  conversation: ChannelConversation;
  items: ChannelMessage[];
  outgoing?: ChannelOutgoing[];
  live_updates?: boolean;
};

/** Between two reads of the list while it is open. */
export const POLL_MS = 45_000;
/** Between two reads of an open transcript. */
export const TRANSCRIPT_POLL_MS = 30_000;
/** The same, while the hub announces each change itself (`live_updates`): only a fallback. */
export const LIVE_POLL_MS = 5 * 60_000;
export const LIVE_TRANSCRIPT_POLL_MS = 2 * 60_000;
/** The realtime event that says a channel conversation changed (§153). */
export const CHANNEL_EVENT = 'channel_conversation.updated';
/** How many of each profile's conversations a list reads, and how many more "older" adds. */
export const CHANNEL_PAGE = 100;
/** The most the hub lists per profile (`limit`, §103). */
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
    /** Each profile's most recent this many (§103); the hub's own 100 when not said. */
    limit?: number;
  } = {},
) {
  const { client, profile, session } = useAuth();
  const listed = filters.profile ?? profile;
  const limit = filters.limit ?? CHANNEL_PAGE;
  // Read again as each channel turn is announced (§153), not only on the poll.
  useChannelUpdates();
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
    refetchInterval: (query) =>
      (query.state.data as { live_updates?: boolean } | undefined)?.live_updates === true
        ? LIVE_POLL_MS
        : POLL_MS,
    // A list nobody is looking at does not need to be current.
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
}

/**
 * The pages before the latest one, read when the person asks for older messages (§103): each
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
 * A picture the person sent on the channel, as an address the page can draw (§103): read with
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
    refetchInterval: (query) =>
      (query.state.data as { live_updates?: boolean } | undefined)?.live_updates === true
        ? LIVE_TRANSCRIPT_POLL_MS
        : TRANSCRIPT_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** What `channel_conversation.updated` carries (contract `events/sessions`). */
interface ChannelUpdate {
  conversation_id: string;
  channel: string;
  reason: 'turn_started' | 'turn_ended' | 'outgoing';
  outgoing: ChannelOutgoing | null;
}

/** A message written from the hub, put into the open transcript's `outgoing` as it now stands. */
export function withOutgoing<T extends { outgoing?: ChannelOutgoing[] }>(
  data: T,
  outgoing: ChannelOutgoing,
): T {
  const list = data.outgoing ?? [];
  const known = list.some((each) => each.id === outgoing.id);
  return {
    ...data,
    outgoing: known
      ? list.map((each) => (each.id === outgoing.id ? outgoing : each))
      : [...list, outgoing],
  };
}

/** Applies one `channel_conversation.updated` to what the screens hold. */
export function applyChannelUpdate(
  queryClient: QueryClient,
  profile: string,
  update: ChannelUpdate,
): void {
  const one = channelKeys.one(profile, update.conversation_id);
  if (update.outgoing) {
    const outgoing = update.outgoing;
    queryClient.setQueryData<ChannelTranscript>(one, (data) =>
      data ? withOutgoing(data, outgoing) : data,
    );
  }
  // A turn began or ended (or the hub's message reached its end): the transcript and the list
  // have something new to show.
  const settled =
    update.reason !== 'outgoing' ||
    update.outgoing?.status === 'answered' ||
    update.outgoing?.status === 'failed';
  if (settled) {
    void queryClient.invalidateQueries({ queryKey: one });
    void queryClient.invalidateQueries({ queryKey: channelKeys.all });
  }
}

/**
 * Hears `channel_conversation.updated` on the sessions socket (every profile the person may
 * enter, ADR 0016) while a channel screen or the list is mounted.
 */
export function useChannelUpdates(): void {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  useEffect(() => {
    if (!session) return;
    const socket = realtime.socket('sessions');
    const onUpdate = (raw: unknown) => {
      if (!isEnvelope(raw) || !raw.profile) return;
      const update = raw.payload as unknown as ChannelUpdate;
      if (typeof update.conversation_id !== 'string') return;
      applyChannelUpdate(queryClient, raw.profile, update);
    };
    socket.on(CHANNEL_EVENT, onUpdate);
    if (!socket.connected) socket.connect();
    return () => {
      socket.off(CHANNEL_EVENT, onUpdate);
    };
  }, [realtime, realtime.epoch, session, queryClient]);
}

/**
 * Writing into a channel conversation from the hub (§153): the words go out on the channel,
 * then to the agent. The answer is the hub's `ChannelOutgoing`, put into the open transcript at
 * once; a refusal leaves the words with the caller.
 */
export function useSendChannelMessage(id: string) {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { text: string; client_message_id: string }) =>
      (
        await client.request('post', '/channel-conversations/{conversation_id}/messages', {
          params: { conversation_id: id },
          body: input,
        })
      ).data as { outgoing: ChannelOutgoing },
    onSuccess: ({ outgoing }) => {
      queryClient.setQueryData<ChannelTranscript>(channelKeys.one(profile, id), (data) =>
        data ? withOutgoing(data, outgoing) : data,
      );
    },
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
