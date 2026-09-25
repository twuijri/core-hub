/**
 * Rows to the contract's shapes (`Room`, `Seat`, `Member`, `Message`, `HandoffChain`,
 * `SeatPreset`). Nothing here reads the database: what a shape needs from elsewhere (names,
 * presence, a seat's live status) is handed in.
 */
import { iso } from '../../lib/time.js';
import type { ChainRow, MemberRow, PresetRow, RoomMessageRow, RoomRow, SeatRow } from './store.js';

/** What a seat is doing right now (contract `SeatStatus`); `idle` when nothing runs. */
export type SeatStatus =
  'idle' | 'queued' | 'thinking' | 'running' | 'waiting_approval' | 'offline';

export function generatedAvatar(seed: string): Record<string, unknown> {
  return { kind: 'generated', url: null, seed };
}

export function toSeat(row: SeatRow, status: SeatStatus = 'idle'): Record<string, unknown> {
  return {
    id: row.id,
    room_id: row.roomId,
    agent_id: row.agentId,
    name: row.alias,
    description: row.description ?? null,
    avatar: row.avatar ?? generatedAvatar(row.alias),
    model: row.model ?? null,
    provider: row.provider ?? null,
    reasoning_effort: row.reasoningEffort ?? null,
    instructions: row.persona ?? null,
    preset_id: row.presetId ?? null,
    status,
    executor: { kind: 'server', device_id: null },
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export interface RoomView {
  row: RoomRow;
  profile: string;
  seats: SeatRow[];
  memberCount: number;
  /** Whether the caller may manage the room: it decides `can_manage` and the invite code. */
  canManage: boolean;
  statusOf?: (seat: SeatRow) => SeatStatus;
}

export function toRoom(view: RoomView): Record<string, unknown> {
  const { row } = view;
  return {
    id: row.id,
    profile: view.profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    name: row.name,
    working_dir: row.workingDir ?? null,
    invite_code: view.canManage ? (row.inviteCode ?? null) : null,
    can_manage: view.canManage,
    can_mention_all: row.canMentionAll,
    member_count: view.memberCount,
    total_tokens: row.totalTokens,
    summary_policy: {
      every_turns: row.summaryEveryTurns,
      model: row.summaryModel ?? null,
      provider: row.summaryProvider ?? null,
    },
    handoff: { enabled: row.handoffEnabled, max_depth: row.handoffMaxDepth ?? null },
    seats: view.seats.map((seat) => toSeat(seat, view.statusOf?.(seat) ?? 'idle')),
    last_active_at: iso(row.lastMessageAt),
    lead_seat_id: row.leadSeatId ?? null,
    archived_at: iso(row.archivedAt),
  };
}

export function toMember(
  row: MemberRow,
  person: { name: string; seed: string },
  online: boolean,
): Record<string, unknown> {
  return {
    id: row.id,
    room_id: row.roomId,
    user_id: row.userId,
    name: person.name,
    avatar: generatedAvatar(person.seed),
    role: row.role,
    online,
    joined_at: iso(row.createdAt),
  };
}

export function toMemory(row: RoomRow): Record<string, unknown> {
  return {
    summary: row.memory ?? null,
    status:
      row.memoryStatus === 'summarizing' || row.memoryStatus === 'error'
        ? row.memoryStatus
        : 'idle',
    summarized_turn_count: row.memoryTurnCount,
    error: row.memoryError ?? null,
    updated_at: iso(row.memoryUpdatedAt),
  };
}

/**
 * A room message as the contract's one `Message` (DECISIONS §1). A person's and the hub's
 * messages carry the room's id as `session_id` — a room is not a session; a seat's reply
 * carries its seat's session, where the run that wrote it lives (DECISIONS §57).
 */
export function toRoomMessage(
  row: RoomMessageRow,
  profile: string,
  seat?: SeatRow,
): Record<string, unknown> {
  const role =
    row.authorKind === 'seat' ? 'assistant' : row.authorKind === 'system' ? 'system' : 'user';
  const author =
    row.authorKind === 'seat'
      ? {
          kind: 'agent',
          id: seat?.agentId ?? null,
          name: seat?.alias ?? row.authorName ?? '',
          avatar: seat?.avatar ?? generatedAvatar(seat?.alias ?? row.authorName ?? 'seat'),
        }
      : row.authorKind === 'system'
        ? { kind: 'system', id: null, name: row.authorName ?? '', avatar: null }
        : {
            kind: 'user',
            id: row.authorUserId ?? null,
            name: row.authorName ?? '',
            avatar: generatedAvatar(row.authorName ?? row.authorUserId ?? 'user'),
          };
  const parts = Array.isArray(row.parts) ? (row.parts as unknown[]) : [];
  const content =
    parts.length > 0 ? parts : row.content ? [{ type: 'text', text: row.content }] : [];
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    session_id: row.sessionId ?? row.roomId,
    room_id: row.roomId,
    seat_id: row.seatId ?? null,
    seq: row.seq,
    role,
    author,
    content,
    reasoning: row.reasoning ? { text: row.reasoning, duration_ms: null } : null,
    tool_calls: [],
    run_id: row.runId ?? null,
    status: row.status,
    mentions: row.mentionList ?? [],
    handoff: row.handoff ?? null,
    usage: row.usage ?? null,
    reply_to_message_id: row.replyToId ?? null,
  };
}

export function toChain(row: ChainRow): Record<string, unknown> {
  return {
    id: row.id,
    room_id: row.roomId,
    from_seat_id: row.fromSeatId,
    to_seat_id: row.toSeatId,
    status: row.status,
    stop_reason: row.stopReason ?? null,
    depth: row.depth,
    max_depth: row.maxDepth ?? null,
    continue_used: row.continueUsed,
    error: row.error ?? null,
    updated_at: iso(row.updatedAt),
  };
}

export function toPreset(
  row: PresetRow,
  profile: string,
  availability: { available: boolean; error: string | null },
): Record<string, unknown> {
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    name: row.name,
    agent_id: row.agentId,
    seat: row.seat,
    available: availability.available,
    validation_error: availability.error,
  };
}
