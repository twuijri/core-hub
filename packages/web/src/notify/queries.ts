/**
 * The notify module's reads and writes: the inbox, what reaches you, and the webhooks.
 *
 * **Nothing here invents a notice.** The inbox is what other modules wrote — a run that
 * finished, an approval that is waiting — so an empty inbox is an empty inbox, never a
 * placeholder row. The unread count comes from the list response and is the person's
 * whole count, not this page's, which is why the sidebar can show it without paging.
 *
 * The inbox is global too (`x-scope: global`) — it belongs to a person, not to a
 * workspace — but the key still carries the profile, because switching workspaces must
 * refetch everything the screen shows (NAVIGATION rule 4).
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';

export const NOTICE_KINDS = [
  'run_completed',
  'approval_requested',
  'room_mention',
  'task_moved',
  'schedule_failed',
  'update_available',
  'system',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string | null;
  resource: { kind: string; id: string } | null;
  read_at: string | null;
  created_at: string;
}

export interface NoticePage {
  items: Notice[];
  next_cursor: string | null;
  unread_count: number;
}

export interface Channels {
  in_app: boolean;
  push: boolean;
}

export interface NotifyPreferences {
  events: Partial<Record<NoticeKind, Channels>>;
  quiet_hours: { enabled: boolean; from: string; to: string; timezone: string };
}

export const notifyKeys = {
  notices: (profile: string, unread: boolean) => ['notices', profile, unread] as const,
  preferences: (profile: string) => ['notify-preferences', profile] as const,
};

export function useNotices(unreadOnly: boolean) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: notifyKeys.notices(profile, unreadOnly),
    queryFn: async () =>
      (
        await client.request('get', '/notify/notices', {
          query: unreadOnly ? { unread: true, limit: 50 } : { limit: 50 },
        })
      ).data as unknown as NoticePage,
    enabled: !!session,
  });
}

/**
 * Just the count, for the row in the sidebar. One item is fetched rather than none,
 * because the contract has no count-only call and asking for a page of fifty to render a
 * badge is fifty rows nobody reads.
 */
export function useUnreadCount(): number {
  const { client, profile, session } = useAuth();
  const query = useQuery({
    queryKey: ['notices', profile, 'count'],
    queryFn: async () =>
      (await client.request('get', '/notify/notices', { query: { limit: 1 } }))
        .data as unknown as NoticePage,
    enabled: !!session,
  });
  return query.data?.unread_count ?? 0;
}

function useNoticeInvalidation() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['notices', profile] });
  };
}

/** Read or unread one notice. The contract's `updateNotice` takes `read`, not a timestamp. */
export function useMarkNotice() {
  const { client } = useAuth();
  const invalidate = useNoticeInvalidation();
  return useMutation({
    mutationFn: async (input: { id: string; read: boolean }) =>
      (
        await client.request('patch', '/notify/notices/{notice_id}', {
          params: { notice_id: input.id },
          body: { read: input.read },
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useMarkAllRead() {
  const { client } = useAuth();
  const invalidate = useNoticeInvalidation();
  return useMutation({
    mutationFn: async () => (await client.request('patch', '/notify/notices')).data,
    onSuccess: invalidate,
  });
}

export function useNotifyPreferences() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: notifyKeys.preferences(profile),
    queryFn: async () =>
      (await client.request('get', '/notify/preferences')).data as unknown as NotifyPreferences,
    enabled: !!session,
  });
}

export function useSaveNotifyPreferences() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: NotifyPreferences) =>
      (await client.request('put', '/notify/preferences', { body: body as never })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notifyKeys.preferences(profile) });
    },
  });
}

/**
 * The inbox other clients changed.
 *
 * `notice.created` and `notice.updated` are user-level events on `/rt/devices`, so the
 * page that is open on a laptop learns that the phone read something. It is subscribed
 * **once, in the shell**, not on the Notifications page: the count is shown in the
 * sidebar, which is on screen when that page is not. Both carry the new
 * `unread_count`, but the list is refetched rather than patched: a notice arriving while
 * a filter is on belongs in the list only if it matches, and the server already knows.
 */
export function useNoticeStream(): void {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  useEffect(() => {
    if (!session) return;
    const connection = socket('devices');
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['notices'] });
    };
    connection.on('notice.created', refresh);
    connection.on('notice.updated', refresh);
    return () => {
      connection.off('notice.created', refresh);
      connection.off('notice.updated', refresh);
    };
  }, [socket, queryClient, session]);
}
