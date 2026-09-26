/**
 * The Rooms section's reads, writes and live stream (contract tag `rooms`, DECISIONS §69).
 *
 * A room is its members': the list is the rooms the person is in, in the profile they are
 * in. The room's screen is one document (`rooms.get`: seats, members, live runs, handoff
 * chains, memory) plus its transcript, paged backwards, and `/rt/rooms` keeps both current:
 * the transcript through the pure reducer in `transcript.ts`, everything else by asking the
 * hub again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';
import { ROOM_EVENTS, isEnvelope } from '../realtime/envelope.js';
import type {
  ContentBlock,
  HandoffChain,
  Message,
  Room,
  RoomDetail,
  RoomInvitePreview,
  Seat,
  SeatConfig,
} from '../types.js';
import type { Mention } from './mentions.js';
import {
  applyRoomEvent,
  emptyTranscript,
  loaded,
  prepend,
  type RoomTranscript,
} from './transcript.js';

export const roomKeys = {
  list: (profile: string, archived: boolean) =>
    ['rooms', profile, archived ? 'archived' : 'active'] as const,
  detail: (profile: string, id: string) => ['room', profile, id] as const,
  presets: (profile: string) => ['seat-presets', profile] as const,
};

/** Page size of the transcript. */
export const ROOM_PAGE = 50;

export function useRooms(archived = false) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: roomKeys.list(profile, archived),
    queryFn: async () =>
      (
        await client.request('get', '/rooms', {
          query: archived ? { archived: true } : {},
        })
      ).data as unknown as { items: Room[]; next_cursor: string | null },
    enabled: !!session,
  });
}

export function useRoom(roomId: string | undefined) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: roomKeys.detail(profile, roomId ?? ''),
    queryFn: async () =>
      (await client.request('get', '/rooms/{room_id}', { params: { room_id: roomId! } }))
        .data as unknown as RoomDetail,
    enabled: !!session && !!roomId,
  });
}

/** Everything a room write can change: the list and the room itself. */
function useRefresh() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['rooms'] });
    void queryClient.invalidateQueries({ queryKey: ['room'] });
  }, [queryClient]);
}

export function useCreateRoom() {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (body: { name: string; seats: SeatConfig[] }) =>
      (await client.request('post', '/rooms', { body: { ...body, can_mention_all: true } }))
        .data as unknown as {
        room: Room;
        seat_results: Array<{ id: string | null; ok: boolean; error: { error: string } | null }>;
      },
    onSuccess: refresh,
  });
}

export function useUpdateRoom(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (body: {
      name?: string;
      archived?: boolean;
      lead_seat_id?: string | null;
      can_mention_all?: boolean;
      handoff?: { enabled: boolean; max_depth: number | null };
    }) =>
      (
        await client.request('patch', '/rooms/{room_id}', {
          params: { room_id: roomId },
          body,
        })
      ).data as unknown as Room,
    onSuccess: refresh,
  });
}

export function useDeleteRoom() {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (roomId: string) => {
      await client.request('delete', '/rooms/{room_id}', { params: { room_id: roomId } });
    },
    onSuccess: refresh,
  });
}

export function useRotateInvite(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async () =>
      (
        await client.request('post', '/rooms/{room_id}/invite-code', {
          params: { room_id: roomId },
        })
      ).data as unknown as { invite_code: string; join_url: string },
    onSuccess: refresh,
  });
}

/** A pasted link or a bare code, reduced to the code the hub knows (DECISIONS §23). */
export function codeFrom(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const last = trimmed.split('/').pop() ?? '';
  return last.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function useInvitePreview(code: string) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['room-invite', code],
    queryFn: async () =>
      (
        await client.request('get', '/room-invites/{invite_code}', {
          params: { invite_code: code },
        })
      ).data as unknown as RoomInvitePreview,
    enabled: !!session && /^[A-Z2-9]{4,12}$/.test(code),
    retry: false,
  });
}

export function useJoinRoom() {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (code: string) =>
      (
        await client.request('post', '/room-invites/{invite_code}/join', {
          params: { invite_code: code },
          body: {},
        })
      ).data as unknown as Room,
    onSuccess: refresh,
  });
}

export function useRemoveMember(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (memberId: string) => {
      await client.request('delete', '/rooms/{room_id}/members/{member_id}', {
        params: { room_id: roomId, member_id: memberId },
      });
    },
    onSuccess: refresh,
  });
}

export function useAddSeat(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (body: SeatConfig) =>
      (
        await client.request('post', '/rooms/{room_id}/seats', {
          params: { room_id: roomId },
          body,
        })
      ).data as unknown as Seat,
    onSuccess: refresh,
  });
}

export function useUpdateSeat(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ seatId, ...body }: Partial<SeatConfig> & { seatId: string }) =>
      (
        await client.request('patch', '/rooms/{room_id}/seats/{seat_id}', {
          params: { room_id: roomId, seat_id: seatId },
          body,
        })
      ).data as unknown as Seat,
    onSuccess: refresh,
  });
}

export function useRemoveSeat(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (seatId: string) => {
      await client.request('delete', '/rooms/{room_id}/seats/{seat_id}', {
        params: { room_id: roomId, seat_id: seatId },
      });
    },
    onSuccess: refresh,
  });
}

export function usePostMessage(roomId: string) {
  const { client } = useAuth();
  return useMutation({
    // Words, files, or both (contract decision §99): `content` is the text block and the
    // picture/file blocks of what was attached (`attachments/tray.tsx`).
    mutationFn: async (body: { content: ContentBlock[]; mentions: Mention[] }) =>
      (
        await client.request('post', '/rooms/{room_id}/messages', {
          params: { room_id: roomId },
          body: { content: body.content, mentions: body.mentions },
        })
      ).data as unknown as { message_id: string; runs: Array<{ seat_id: string; run_id: string }> },
  });
}

/**
 * The room's transcript, kept live. Loads the newest page, joins the room's channel on
 * `/rt/rooms` (which also makes the person present), folds every event into the transcript,
 * and asks the hub for the room again when something other than the transcript changed.
 * `gone` is set when the room was deleted or the person was taken out of it.
 */
export function useRoomStream(roomId: string | undefined) {
  const { client, profile, session } = useAuth();
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const [state, setState] = useState<RoomTranscript>(emptyTranscript);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [gone, setGone] = useState<'deleted' | 'removed' | null>(null);
  const loadingOlder = useRef(false);
  const userId = session?.user.id;

  useEffect(() => {
    if (!roomId || !session) return;
    let alive = true;
    setState(emptyTranscript);
    setStatus('loading');
    setGone(null);
    /**
     * The newest page, merged under what is already held. Run on open and again every time
     * the room's channel is (re)joined: an event sent while the socket was away is not
     * replayed, so the transcript is asked for instead.
     */
    const sync = async () => {
      try {
        const page = (
          await client.request('get', '/rooms/{room_id}/messages', {
            params: { room_id: roomId },
            query: { limit: ROOM_PAGE },
          })
        ).data as unknown as { items: Message[]; has_more: boolean };
        if (!alive) return;
        setState((current) =>
          current.messages.length === 0
            ? {
                ...current,
                ...loaded(page.items, page.has_more),
                typing: current.typing,
                tools: current.tools,
              }
            : prepend(current, page.items, current.hasMore || page.has_more),
        );
        setStatus('ready');
      } catch (failure) {
        if (!alive) return;
        setError(failure);
        setStatus((current) => (current === 'ready' ? current : 'error'));
      }
    };
    void sync();

    const socket = realtime.socket('rooms');
    // Every join catches up on what was said before it took effect: the first one races the
    // opening page (a message sent before the socket was in the room is not replayed), and a
    // later one is a reconnection.
    const join = () =>
      socket.emit('join', { room_id: roomId }, (ack: { ok: boolean } | undefined) => {
        if (!alive || !ack?.ok) return;
        void sync();
        // Being in the room is presence: the members panel says so once the join took.
        void queryClient.invalidateQueries({ queryKey: roomKeys.detail(profile, roomId) });
      });
    const handler = (event: string) => (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      const payload = raw.payload;
      const forRoom =
        payload.room_id === roomId ||
        (payload.message as { room_id?: string } | undefined)?.room_id === roomId ||
        (payload.run as { room_id?: string } | undefined)?.room_id === roomId ||
        (payload.room as { id?: string } | undefined)?.id === roomId;
      // Deltas carry no room id; their message id is what places them.
      if (
        !forRoom &&
        ![
          'message.delta',
          'reasoning.delta',
          'tool.started',
          'tool.completed',
          'tool.failed',
        ].includes(event)
      )
        return;
      if (event === 'room.deleted') return setGone('deleted');
      if (event === 'member.left') {
        const member = payload.member as { user_id?: string } | undefined;
        if (member?.user_id === userId) return setGone('removed');
      }
      setState((current) => applyRoomEvent(current, event, payload));
      if (
        !['message.delta', 'reasoning.delta', 'member.typing', 'message.created'].includes(event)
      ) {
        void queryClient.invalidateQueries({ queryKey: roomKeys.detail(profile, roomId) });
      }
      if (['room.updated', 'message.created', 'seat.added', 'seat.removed'].includes(event)) {
        void queryClient.invalidateQueries({ queryKey: ['rooms'] });
      }
    };
    const handlers = ROOM_EVENTS.map((name) => [name, handler(name)] as const);
    for (const [name, fn] of handlers) socket.on(name, fn);
    socket.on('connect', join);
    if (socket.connected) join();
    else socket.connect();
    return () => {
      alive = false;
      for (const [name, fn] of handlers) socket.off(name, fn);
      socket.off('connect', join);
      socket.emit('leave', { room_id: roomId });
    };
  }, [roomId, profile, session?.user.id, realtime.epoch]);

  const loadOlder = useCallback(async () => {
    if (!roomId || loadingOlder.current) return;
    const first = state.messages[0];
    if (!first || !state.hasMore) return;
    loadingOlder.current = true;
    try {
      const page = (
        await client.request('get', '/rooms/{room_id}/messages', {
          params: { room_id: roomId },
          query: { limit: ROOM_PAGE, before: first.id },
        })
      ).data as unknown as { items: Message[]; has_more: boolean };
      setState((current) => prepend(current, page.items, page.has_more));
    } finally {
      loadingOlder.current = false;
    }
  }, [client, roomId, state.messages, state.hasMore]);

  /** Tell the room this person is typing (`true`) or stopped (`false`). */
  const typing = useCallback(
    (on: boolean) => {
      if (!roomId) return;
      realtime.socket('rooms').emit('typing', { room_id: roomId, typing: on });
    },
    [realtime, roomId],
  );

  return { state, status, error, gone, loadOlder, typing };
}

/** The rooms list follows new rooms and changes without a page of its own being open. */
export function useRoomListEvents(): void {
  const realtime = useRealtime();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = realtime.socket('rooms');
    const refresh = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      void queryClient.invalidateQueries({ queryKey: ['rooms'] });
    };
    const names = ['room.created', 'room.deleted', 'member.left'] as const;
    for (const name of names) socket.on(name, refresh);
    if (!socket.connected) socket.connect();
    return () => {
      for (const name of names) socket.off(name, refresh);
    };
  }, [profile, queryClient, realtime.epoch]);
}

export function useStopSeat(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (seatId: string) =>
      (
        await client.request('post', '/rooms/{room_id}/seats/{seat_id}/stop', {
          params: { room_id: roomId, seat_id: seatId },
        })
      ).data as unknown as Seat,
    onSuccess: refresh,
  });
}

/** The room's handoff chains, newest first — the stopped one a person may let go on. */
export function useHandoffs(roomId: string, revision: unknown) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['room-handoffs', profile, roomId, revision],
    queryFn: async () =>
      (
        await client.request('get', '/rooms/{room_id}/handoffs', {
          params: { room_id: roomId },
        })
      ).data as unknown as { items: HandoffChain[] },
    enabled: !!session,
  });
}

export function useContinueHandoff(roomId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (chainId: string) =>
      (
        await client.request('post', '/rooms/{room_id}/handoffs/{chain_id}/continue', {
          params: { room_id: roomId, chain_id: chainId },
        })
      ).data as unknown as { job_id: string },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['room-handoffs'] }),
  });
}

export function useClearContext(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async () => {
      await client.request('delete', '/rooms/{room_id}/context', { params: { room_id: roomId } });
    },
    onSuccess: refresh,
  });
}

export function usePutMemory(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (summary: string) =>
      (
        await client.request('put', '/rooms/{room_id}/memory', {
          params: { room_id: roomId },
          body: { summary },
        })
      ).data,
    onSuccess: refresh,
  });
}

export function useRefreshMemory(roomId: string) {
  const { client } = useAuth();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async () =>
      (
        await client.request('post', '/rooms/{room_id}/memory/refresh', {
          params: { room_id: roomId },
        })
      ).data as unknown as { job_id: string },
    onSuccess: refresh,
  });
}

/**
 * Which project reports its tasks' progress into this room (`Project.report_room_id`), and
 * the way to change it: one project at a time is linked from the room's settings.
 */
export function useLinkProject() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectId: string; roomId: string | null }) =>
      (
        await client.request('patch', '/projects/{project_id}', {
          params: { project_id: input.projectId },
          body: { report_room_id: input.roomId },
        })
      ).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
}
