/**
 * What a room is and who may do what in it (DECISIONS §69, proposed — owner to confirm).
 *
 * - A room lives in one profile and is its **members'**: the person who made it (role
 *   `owner`, who manages it) and the people who joined it by its invite code. Anyone else —
 *   an admin of the hub included — does not find it (`404`), exactly as for a room that does
 *   not exist.
 * - Joining by code needs the right to enter the room's profile: a code is not a way into a
 *   profile the person was never given.
 * - A seat is an agent in the room with its own name, instructions and model, and its own
 *   conversation (`sessions`), opened when the seat is added. Names are unique in the room,
 *   ignoring case, and `all` is kept for `@all`.
 * - The first seat added becomes the room's lead: the one that answers a message that
 *   mentions nobody. Archiving refuses new messages; the transcript stays readable.
 */
import { PRODUCT } from '@corehub/contracts';
import { HubError, notFound } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import type { EngineScope, SeatSessions } from '../sessions/index.js';
import type { RoomsRealtime } from './realtime.js';
import {
  toChain,
  toMember,
  toMemory,
  toPreset,
  toRoom,
  toRoomMessage,
  toSeat,
  type SeatStatus,
} from './serialize.js';
import { summarise } from './memory.js';
import type { StoredMention } from './schema.js';
import type { RoomsStore } from './store.js';
import { type MemberRow, type RoomMessageRow, type RoomRow, type SeatRow } from './store.js';

export type RoomScope = EngineScope;

/** What the rooms module needs from elsewhere, joined in by the composition root. */
export interface RoomPorts {
  /** `sessions`: each seat's conversation, and the runs in it. `null`: seats cannot be added. */
  seats: SeatSessions | null;
  /** `auth`: a person's name as the room shows it. */
  person(userId: string): { name: string; seed: string } | null;
  /** `auth`: the profiles a person may enter, as `{ id, slug }`. */
  enterable(userId: string): Array<{ id: string; slug: string }>;
}

/** What the room knows is happening right now; the conductor (agents in the room) fills it. */
export interface RoomLive {
  seatStatus(seatId: string): SeatStatus;
  /** Run ids live in the room (queued or running), for `RoomDetail.runs`. */
  liveRuns(roomId: string): string[];
}

export const idleRoom: RoomLive = { seatStatus: () => 'idle', liveRuns: () => [] };

type Json = Record<string, unknown>;

const RESERVED_NAME = 'all';

export interface SeatConfigInput {
  agent_id: string;
  name: string;
  description?: string | null;
  model?: string | null;
  provider?: string | null;
  reasoning_effort?: string | null;
  instructions?: string | null;
  preset_id?: string | null;
  avatar?: unknown;
}

export class RoomsService {
  constructor(
    readonly store: RoomsStore,
    private readonly ports: RoomPorts,
    private readonly realtime: RoomsRealtime,
    private readonly live: RoomLive = idleRoom,
  ) {}

  // ------------------------------------------------------------------ access

  /** The room, when the caller is a member of it in this profile; `404` otherwise. */
  requireRoom(scope: RoomScope, roomId: string): { room: RoomRow; member: MemberRow } {
    const room = this.store.getRoom(scope.workspace, roomId);
    const member = room ? this.store.member(room.id, scope.userId) : undefined;
    if (!room || !member) throw notFound({ resource: 'room', id: roomId });
    return { room, member };
  }

  /** The same, and the caller manages it (`403` for a member who does not). */
  requireManager(scope: RoomScope, roomId: string): RoomRow {
    const { room, member } = this.requireRoom(scope, roomId);
    if (member.role !== 'owner') {
      throw new HubError('forbidden', {
        details: { reason: 'room_manager_only', room_id: roomId },
      });
    }
    return room;
  }

  private canManage(member: MemberRow | undefined): boolean {
    return member?.role === 'owner';
  }

  // ------------------------------------------------------------------ rooms

  roomOf(scope: RoomScope, room: RoomRow, member?: MemberRow): Json {
    const who = member ?? this.store.member(room.id, scope.userId);
    return toRoom({
      row: room,
      profile: scope.profile,
      seats: this.store.seats(room.id),
      memberCount: this.store.memberCounts([room.id]).get(room.id) ?? 0,
      canManage: this.canManage(who),
      statusOf: (seat) => this.live.seatStatus(seat.id),
    });
  }

  list(
    scope: RoomScope,
    query: { archived?: boolean; cursor?: string; limit: number },
  ): { items: Json[]; next_cursor: string | null } {
    const rows = this.store.listRoomsFor(
      scope.workspace,
      scope.userId,
      query.archived === true,
      decodeRoomCursor(query.cursor),
      query.limit,
    );
    const page = rows.slice(0, query.limit);
    const ids = page.map((row) => row.id);
    const seats = this.store.seatsOf(ids);
    const counts = this.store.memberCounts(ids);
    const items = page.map((row) =>
      toRoom({
        row,
        profile: scope.profile,
        seats: seats.get(row.id) ?? [],
        memberCount: counts.get(row.id) ?? 0,
        canManage: this.canManage(this.store.member(row.id, scope.userId)),
        statusOf: (seat) => this.live.seatStatus(seat.id),
      }),
    );
    const last = page.at(-1);
    return {
      items,
      next_cursor:
        rows.length > query.limit && last
          ? encodeRoomCursor((last.lastMessageAt ?? last.createdAt).getTime(), last.id)
          : null,
    };
  }

  async create(
    scope: RoomScope,
    body: {
      name: string;
      working_dir?: string | null;
      seats?: SeatConfigInput[];
      summary_policy?: { every_turns: number; model: string | null; provider: string | null };
      handoff?: { enabled: boolean; max_depth: number | null };
      can_mention_all?: boolean;
    },
  ): Promise<{ room: Json; seat_results: Json[] }> {
    const room = this.store.createRoom({
      workspace: scope.workspace,
      ownerId: scope.userId,
      name: body.name.trim(),
      workingDir: body.working_dir?.trim() || null,
      canMentionAll: body.can_mention_all ?? true,
      summaryEveryTurns: body.summary_policy?.every_turns ?? 20,
      summaryModel: body.summary_policy?.model ?? null,
      summaryProvider: body.summary_policy?.provider ?? null,
      handoffEnabled: body.handoff?.enabled ?? true,
      handoffMaxDepth: body.handoff ? body.handoff.max_depth : 3,
    });
    const seatResults: Json[] = [];
    for (const config of body.seats ?? []) {
      try {
        const seat = await this.insertSeat(scope, room.id, config, { announce: false });
        seatResults.push({ id: seat.id, ok: true, error: null });
      } catch (error) {
        seatResults.push({ id: null, ok: false, error: envelopeOf(error, scope.language) });
      }
    }
    const fresh = this.store.getRoom(scope.workspace, room.id) as RoomRow;
    const payload = this.roomOf(scope, fresh);
    // Only its maker is in a new room, and the room carries its invite code: the event goes
    // to that person's sockets, not the whole profile (DECISIONS §69).
    this.realtime.toUser(scope.profile, scope.userId, 'room.created', { room: payload });
    return { room: payload, seat_results: seatResults };
  }

  detail(scope: RoomScope, roomId: string, runs: Json[] = []): Json {
    const { room, member } = this.requireRoom(scope, roomId);
    return {
      ...this.roomOf(scope, room, member),
      members: this.memberList(room),
      runs,
      pending_approvals: [],
      handoff_chains: this.store.chains(room.id, true).map(toChain),
      memory: toMemory(room),
      typing: [],
    };
  }

  update(
    scope: RoomScope,
    roomId: string,
    patch: {
      name?: string;
      working_dir?: string | null;
      summary_policy?: { every_turns: number; model: string | null; provider: string | null };
      handoff?: { enabled: boolean; max_depth: number | null };
      can_mention_all?: boolean;
      lead_seat_id?: string | null;
      archived?: boolean;
    },
  ): Json {
    const room = this.requireManager(scope, roomId);
    const values: Partial<RoomRow> = {};
    if (patch.name !== undefined) values.name = patch.name.trim();
    if (patch.working_dir !== undefined) values.workingDir = patch.working_dir?.trim() || null;
    if (patch.summary_policy) {
      values.summaryEveryTurns = patch.summary_policy.every_turns;
      values.summaryModel = patch.summary_policy.model;
      values.summaryProvider = patch.summary_policy.provider;
    }
    if (patch.handoff) {
      values.handoffEnabled = patch.handoff.enabled;
      values.handoffMaxDepth = patch.handoff.max_depth;
    }
    if (patch.can_mention_all !== undefined) values.canMentionAll = patch.can_mention_all;
    if (patch.lead_seat_id !== undefined) {
      if (patch.lead_seat_id !== null && !this.activeSeat(room.id, patch.lead_seat_id)) {
        throw notFound({ resource: 'seat', id: patch.lead_seat_id });
      }
      values.leadSeatId = patch.lead_seat_id;
    }
    if (patch.archived !== undefined) {
      values.archivedAt = patch.archived ? (room.archivedAt ?? new Date()) : null;
    }
    const updated = this.store.updateRoom(scope.workspace, room.id, values) as RoomRow;
    return this.announceRoom(scope, updated);
  }

  /** `room.updated` to the members, and the room as the caller sees it. */
  announceRoom(scope: RoomScope, room: RoomRow): Json {
    const payload = this.roomOf(scope, room);
    // Members who do not manage the room must not receive the invite code in the event.
    this.realtime.toRoom(scope.profile, room.id, 'room.updated', {
      room: { ...payload, invite_code: null, can_manage: false },
    });
    return payload;
  }

  remove(scope: RoomScope, roomId: string): RoomRow {
    const room = this.requireManager(scope, roomId);
    this.realtime.toRoom(scope.profile, room.id, 'room.deleted', { room_id: room.id });
    this.store.deleteRoom(scope.workspace, room.id);
    this.realtime.close(room.id);
    return room;
  }

  async clone(scope: RoomScope, roomId: string, name: string | undefined): Promise<Json> {
    const { room } = this.requireRoom(scope, roomId);
    const created = await this.create(scope, {
      name: name?.trim() || room.name,
      working_dir: room.workingDir,
      can_mention_all: room.canMentionAll,
      summary_policy: {
        every_turns: room.summaryEveryTurns,
        model: room.summaryModel ?? null,
        provider: room.summaryProvider ?? null,
      },
      handoff: { enabled: room.handoffEnabled, max_depth: room.handoffMaxDepth ?? null },
      seats: this.store.seats(room.id).map((seat) => ({
        agent_id: seat.agentId,
        name: seat.alias,
        description: seat.description ?? null,
        model: seat.model ?? null,
        provider: seat.provider ?? null,
        reasoning_effort: seat.reasoningEffort ?? null,
        instructions: seat.persona ?? null,
        preset_id: seat.presetId ?? null,
      })),
    });
    return created.room;
  }

  // --------------------------------------------------------------- invites

  rotateInvite(scope: RoomScope, roomId: string, hubUrl: string): Json {
    const room = this.requireManager(scope, roomId);
    const updated = this.store.updateRoom(scope.workspace, room.id, {
      inviteCode: this.store.freeCode(),
    }) as RoomRow;
    this.announceRoom(scope, updated);
    const code = updated.inviteCode as string;
    return { invite_code: code, join_url: joinUrl(hubUrl, code) };
  }

  /**
   * The room an invite code names, when the caller may enter its profile. A code of a profile
   * the caller was never given reads exactly like a code that does not exist.
   */
  private roomForCode(userId: string, code: string): { room: RoomRow; slug: string } {
    const room = this.store.roomByCode(code.toUpperCase());
    const profile = room
      ? this.ports.enterable(userId).find((row) => row.id === room.workspace)
      : undefined;
    if (!room || !profile) throw notFound({ resource: 'room_invite', id: code });
    return { room, slug: profile.slug };
  }

  previewInvite(userId: string, code: string): Json {
    const { room, slug } = this.roomForCode(userId, code);
    return {
      room_id: room.id,
      profile: slug,
      name: room.name,
      seat_count: this.store.seats(room.id).length,
      member_count: this.store.memberCounts([room.id]).get(room.id) ?? 0,
      already_member: !!this.store.member(room.id, userId),
    };
  }

  /** Joining twice is not an error: the second answers the room as the first did. */
  join(
    base: Omit<RoomScope, 'workspace' | 'profile'>,
    code: string,
  ): { room: Json; scope: RoomScope } {
    const { room, slug } = this.roomForCode(base.userId, code);
    const scope: RoomScope = { ...base, workspace: room.workspace, profile: slug };
    if (room.archivedAt) {
      throw new HubError('state_invalid', {
        details: { reason: 'room_archived', room_id: room.id },
      });
    }
    const existing = this.store.member(room.id, base.userId);
    if (!existing) {
      const member = this.store.addMember(room, base.userId);
      this.realtime.toRoom(slug, room.id, 'member.joined', {
        room_id: room.id,
        member: this.memberOf(member),
      });
    }
    return { room: this.roomOf(scope, room), scope };
  }

  // --------------------------------------------------------------- members

  private memberOf(row: MemberRow): Json {
    const person = this.ports.person(row.userId) ?? { name: row.userId, seed: row.userId };
    return toMember(row, person, this.realtime.isOnline(row.roomId, row.userId));
  }

  memberList(room: RoomRow): Json[] {
    return this.store.members(room.id).map((row) => this.memberOf(row));
  }

  listMembers(scope: RoomScope, roomId: string): Json[] {
    const { room } = this.requireRoom(scope, roomId);
    return this.memberList(room);
  }

  /**
   * Leaving is one's own row; removing someone else is the manager's. The owner cannot leave
   * their own room — they archive or delete it — so a room always has someone to manage it.
   */
  removeMember(scope: RoomScope, roomId: string, memberId: string): void {
    const { room, member } = this.requireRoom(scope, roomId);
    const target = this.store.memberById(room.id, memberId);
    if (!target) throw notFound({ resource: 'member', id: memberId });
    const self = target.userId === scope.userId;
    if (!self && !this.canManage(member)) {
      throw new HubError('forbidden', {
        details: { reason: 'room_manager_only', room_id: roomId },
      });
    }
    if (target.role === 'owner') {
      throw new HubError('forbidden', { details: { reason: 'room_owner_stays', room_id: roomId } });
    }
    const payload = { room_id: room.id, member: this.memberOf(target) };
    this.store.removeMember(room.id, target.id);
    this.realtime.toRoom(scope.profile, room.id, 'member.left', payload);
    // The person removed hears it too, even when their socket already left the channel.
    this.realtime.toUser(scope.profile, target.userId, 'member.left', payload);
    this.realtime.evict(room.id, target.userId);
  }

  // ------------------------------------------------------------------ seats

  private activeSeat(roomId: string, seatId: string): SeatRow | undefined {
    const seat = this.store.seat(roomId, seatId);
    return seat && seat.status !== 'left' ? seat : undefined;
  }

  requireSeat(roomId: string, seatId: string): SeatRow {
    const seat = this.activeSeat(roomId, seatId);
    if (!seat) throw notFound({ resource: 'seat', id: seatId });
    return seat;
  }

  private checkName(roomId: string, name: string, except?: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.toLowerCase() === RESERVED_NAME) {
      throw new HubError('validation_failed', {
        details: { field: 'name', reason: trimmed ? 'reserved' : 'empty' },
      });
    }
    const clash = this.store
      .seats(roomId)
      .find((seat) => seat.id !== except && seat.alias.toLowerCase() === trimmed.toLowerCase());
    if (clash)
      throw new HubError('conflict', { details: { reason: 'seat_name_taken', name: trimmed } });
    return trimmed;
  }

  /** A seat as the contract shows it, with what it is doing now. */
  seatOf(roomId: string, seatId: string): Json {
    const seat = this.requireSeat(roomId, seatId);
    return toSeat(seat, this.live.seatStatus(seat.id));
  }

  async addSeat(scope: RoomScope, roomId: string, config: SeatConfigInput): Promise<Json> {
    this.requireManager(scope, roomId);
    const seat = await this.insertSeat(scope, roomId, config, { announce: true });
    return toSeat(seat, this.live.seatStatus(seat.id));
  }

  private async insertSeat(
    scope: RoomScope,
    roomId: string,
    config: SeatConfigInput,
    options: { announce: boolean },
  ): Promise<SeatRow> {
    const room = this.store.getRoom(scope.workspace, roomId) as RoomRow;
    const name = this.checkName(room.id, config.name);
    if (config.preset_id && !this.store.preset(scope.workspace, config.preset_id)) {
      throw notFound({ resource: 'seat_preset', id: config.preset_id });
    }
    const seats = this.ports.seats;
    if (!seats) {
      throw new HubError('agent_unavailable', {
        details: { agent_id: config.agent_id, status: 'no_runtime' },
      });
    }
    const id = newUlid();
    // The seat's conversation first: an agent that cannot take turns is refused before the
    // seat exists (`404` for an unknown agent, `422` for one that is not installed).
    const sessionId = await seats.open(scope, {
      agentId: config.agent_id,
      seatId: id,
      title: `${room.name} · ${name}`,
      model: config.model ?? null,
      provider: config.provider ?? null,
      reasoningEffort: config.reasoning_effort ?? null,
      workingDir: room.workingDir ?? null,
    });
    const seat = this.store.insertSeat({
      id,
      room,
      ownerId: scope.userId,
      agentId: config.agent_id,
      sessionId,
      name,
      description: config.description?.trim() || null,
      model: config.model ?? null,
      provider: config.provider ?? null,
      reasoningEffort: config.reasoning_effort ?? null,
      instructions: config.instructions?.trim() || null,
      presetId: config.preset_id ?? null,
      avatar: null,
    });
    if (!room.leadSeatId) this.store.updateRoom(scope.workspace, room.id, { leadSeatId: seat.id });
    if (options.announce) {
      this.realtime.toRoom(scope.profile, room.id, 'seat.added', {
        room_id: room.id,
        seat: toSeat(seat, 'idle'),
      });
      if (!room.leadSeatId) this.announceRoom(scope, this.store.getRoom(scope.workspace, room.id)!);
    }
    return seat;
  }

  async updateSeat(
    scope: RoomScope,
    roomId: string,
    seatId: string,
    patch: Partial<SeatConfigInput>,
  ): Promise<Json> {
    const room = this.requireManager(scope, roomId);
    const seat = this.requireSeat(room.id, seatId);
    const values: Partial<SeatRow> = {};
    if (patch.name !== undefined) values.alias = this.checkName(room.id, patch.name, seat.id);
    if (patch.description !== undefined) values.description = patch.description?.trim() || null;
    if (patch.instructions !== undefined) values.persona = patch.instructions?.trim() || null;
    if (patch.preset_id !== undefined) values.presetId = patch.preset_id;
    const tuning: {
      model?: string | null;
      provider?: string | null;
      reasoning_effort?: string | null;
    } = {};
    if (patch.model !== undefined) values.model = tuning.model = patch.model;
    if (patch.provider !== undefined) values.provider = tuning.provider = patch.provider;
    if (patch.reasoning_effort !== undefined)
      values.reasoningEffort = tuning.reasoning_effort = patch.reasoning_effort;
    if (Object.keys(tuning).length > 0 && this.ports.seats) {
      await this.ports.seats.configure(scope, seat.sessionId, tuning);
    }
    const updated = this.store.updateSeat(room.id, seat.id, values) as SeatRow;
    const payload = toSeat(updated, this.live.seatStatus(updated.id));
    this.realtime.toRoom(scope.profile, room.id, 'seat.updated', {
      room_id: room.id,
      seat: payload,
    });
    return payload;
  }

  /**
   * A removed seat leaves the room but keeps its row, so its past messages still say who
   * wrote them. Its conversation is archived. When it was the lead, the next seat leads.
   */
  async removeSeat(scope: RoomScope, roomId: string, seatId: string): Promise<SeatRow> {
    const room = this.requireManager(scope, roomId);
    const seat = this.requireSeat(room.id, seatId);
    const left = this.store.updateSeat(room.id, seat.id, {
      status: 'left',
      leftAt: new Date(),
    }) as SeatRow;
    if (this.ports.seats) {
      await this.ports.seats.configure(scope, seat.sessionId, { archived: true }).catch(() => {});
    }
    this.realtime.toRoom(scope.profile, room.id, 'seat.removed', {
      room_id: room.id,
      seat: toSeat(left, 'idle'),
    });
    if (room.leadSeatId === seat.id) {
      const next = this.store.seats(room.id)[0]?.id ?? null;
      this.announceRoom(
        scope,
        this.store.updateRoom(scope.workspace, room.id, { leadSeatId: next }) as RoomRow,
      );
    }
    return left;
  }

  // --------------------------------------------------------------- messages

  messageOf(scope: RoomScope, row: RoomMessageRow): Json {
    const seat = row.seatId ? this.store.seat(row.roomId, row.seatId) : undefined;
    return toRoomMessage(row, scope.profile, seat);
  }

  listMessages(
    scope: RoomScope,
    roomId: string,
    query: { before?: string; limit: number },
  ): { items: Json[]; has_more: boolean } {
    const { room } = this.requireRoom(scope, roomId);
    let beforeSeq: number | null = null;
    if (query.before) {
      const anchor = this.store.message(room.id, query.before);
      if (!anchor) throw notFound({ resource: 'message', id: query.before });
      beforeSeq = anchor.seq;
    }
    const page = this.store.messagesBefore(room.id, beforeSeq, query.limit);
    return { items: page.items.map((row) => this.messageOf(scope, row)), has_more: page.hasMore };
  }

  /**
   * A person's message: checked, stored and announced. Which seats it wakes is the
   * conductor's (`targetsOf`); this only makes sure every seat it names is in the room.
   */
  post(
    scope: RoomScope,
    roomId: string,
    body: {
      content: Array<Record<string, unknown>>;
      mentions?: StoredMention[];
      reply_to_message_id?: string | null;
    },
  ): { room: RoomRow; message: RoomMessageRow; targets: SeatRow[] } {
    const { room } = this.requireRoom(scope, roomId);
    if (room.archivedAt) {
      throw new HubError('state_invalid', {
        details: { reason: 'room_archived', room_id: room.id },
      });
    }
    const text = body.content
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
      .trim();
    if (!text) {
      throw new HubError('validation_failed', { details: { field: 'content', reason: 'empty' } });
    }
    if (body.content.some((block) => block.type !== 'text')) {
      throw new HubError('validation_failed', {
        details: { field: 'content', reason: 'text_only' },
      });
    }
    const mentions = body.mentions ?? [];
    const seats = this.store.seats(room.id);
    const targets = new Map<string, SeatRow>();
    for (const mention of mentions) {
      if (mention.kind === 'all') {
        if (!room.canMentionAll) {
          throw new HubError('bad_request', { details: { reason: 'mention_all_disabled' } });
        }
        for (const seat of seats) targets.set(seat.id, seat);
        continue;
      }
      const seat = seats.find((row) => row.id === mention.seat_id);
      if (!seat) throw notFound({ resource: 'seat', id: mention.seat_id });
      targets.set(seat.id, seat);
    }
    if (mentions.length === 0 && room.leadSeatId) {
      const lead = seats.find((row) => row.id === room.leadSeatId);
      if (lead) targets.set(lead.id, lead);
    }
    if (body.reply_to_message_id && !this.store.message(room.id, body.reply_to_message_id)) {
      throw notFound({ resource: 'message', id: body.reply_to_message_id });
    }
    const message = this.store.appendMessage({
      workspace: scope.workspace,
      ownerId: scope.userId,
      roomId: room.id,
      authorKind: 'user',
      authorUserId: scope.userId,
      authorName: this.ports.person(scope.userId)?.name ?? scope.userName,
      sessionId: room.id,
      content: text,
      parts: [{ type: 'text', text }],
      mentions: mentions.map((m) => ({
        kind: m.kind,
        seat_id: m.kind === 'all' ? null : m.seat_id,
      })),
      replyToId: body.reply_to_message_id ?? null,
    });
    this.realtime.toRoom(scope.profile, room.id, 'message.created', {
      message: this.messageOf(scope, message),
    });
    return { room, message, targets: [...targets.values()] };
  }

  // ---------------------------------------------------------------- reports

  /**
   * A line from the hub itself into a room — a task's progress into its project's room
   * (ROADMAP Phase 1). Nothing is said into a room that is gone or archived; the answer says
   * whether it was.
   */
  report(
    scope: { workspace: string; profile: string; userId: string },
    roomId: string,
    text: string,
  ): boolean {
    const room = this.store.getRoom(scope.workspace, roomId);
    if (!room || room.archivedAt || !text.trim()) return false;
    const message = this.store.appendMessage({
      workspace: room.workspace,
      ownerId: scope.userId,
      roomId: room.id,
      authorKind: 'system',
      authorName: PRODUCT.name,
      sessionId: room.id,
      content: text.trim(),
      parts: [{ type: 'text', text: text.trim() }],
    });
    this.realtime.toRoom(scope.profile, room.id, 'message.created', {
      message: toRoomMessage(message, scope.profile),
    });
    return true;
  }

  // ----------------------------------------------------------------- memory

  memoryOf(scope: RoomScope, roomId: string): Json {
    return toMemory(this.requireRoom(scope, roomId).room);
  }

  private announceMemory(scope: RoomScope, room: RoomRow): Json {
    const memory = toMemory(room);
    this.realtime.toRoom(scope.profile, room.id, 'memory.updated', { room_id: room.id, memory });
    return memory;
  }

  /** `rooms.putMemory`: the manager writes the summary by hand. */
  putMemory(scope: RoomScope, roomId: string, summary: string): Json {
    const room = this.requireManager(scope, roomId);
    const updated = this.store.updateRoom(scope.workspace, room.id, {
      memory: summary.trim() || null,
      memoryStatus: 'idle',
      memoryError: null,
      memoryUpdatedAt: new Date(),
    }) as RoomRow;
    return this.announceMemory(scope, updated);
  }

  /** How many finished messages the summary does not cover yet. */
  uncovered(room: RoomRow): RoomMessageRow[] {
    return this.store
      .messagesAfter(room.id, Math.max(room.memoryUptoSeq, room.contextFromSeq), 2_000)
      .filter((row) => row.status === 'complete' && row.content.trim().length > 0);
  }

  /**
   * Rewrite the summary to cover every finished message up to now (`memory.ts` says who
   * writes it). `summarizing` while it works; `error`, with the reason, when it could not.
   */
  async refreshMemory(scope: RoomScope, roomId: string): Promise<Json> {
    const room = this.store.getRoom(scope.workspace, roomId);
    if (!room) throw notFound({ resource: 'room', id: roomId });
    const messages = this.uncovered(room);
    if (messages.length === 0) return toMemory(room);
    this.announceMemory(
      scope,
      this.store.updateRoom(scope.workspace, room.id, {
        memoryStatus: 'summarizing',
        memoryError: null,
      }) as RoomRow,
    );
    try {
      const seats = this.store.seats(room.id);
      const lead = seats.find((seat) => seat.id === room.leadSeatId) ?? seats[0] ?? null;
      const { summary } = await summarise({ scope, room, lead, messages, seats: this.ports.seats });
      const updated = this.store.updateRoom(scope.workspace, room.id, {
        memory: summary,
        memoryStatus: 'idle',
        memoryError: null,
        memoryTurnCount: room.memoryTurnCount + messages.length,
        memoryUptoSeq: messages.at(-1)!.seq,
        memoryUpdatedAt: new Date(),
      }) as RoomRow;
      return this.announceMemory(scope, updated);
    } catch (error) {
      const failed = this.store.updateRoom(scope.workspace, room.id, {
        memoryStatus: 'error',
        memoryError: error instanceof Error ? error.message : String(error),
      }) as RoomRow;
      this.announceMemory(scope, failed);
      throw error;
    }
  }

  // ---------------------------------------------------------------- context

  /**
   * `rooms.clearContext`: the messages stay, the agents forget. Each seat gets a fresh
   * conversation (the old one is archived) and is shown nothing before this point again; the
   * summary and the token count start over.
   */
  async clearContext(scope: RoomScope, roomId: string): Promise<void> {
    const room = this.requireManager(scope, roomId);
    const seats = this.ports.seats;
    for (const seat of this.store.seats(room.id)) {
      if (seats) {
        const sessionId = await seats.open(scope, {
          agentId: seat.agentId,
          seatId: seat.id,
          title: `${room.name} · ${seat.alias}`,
          model: seat.model ?? null,
          provider: seat.provider ?? null,
          reasoningEffort: seat.reasoningEffort ?? null,
          workingDir: room.workingDir ?? null,
        });
        await seats.configure(scope, seat.sessionId, { archived: true }).catch(() => {});
        this.store.updateSeat(room.id, seat.id, { sessionId, seenSeq: room.messageCount });
      } else {
        this.store.updateSeat(room.id, seat.id, { seenSeq: room.messageCount });
      }
    }
    this.store.updateRoom(scope.workspace, room.id, {
      contextFromSeq: room.messageCount,
      totalTokens: 0,
      memory: null,
      memoryStatus: 'idle',
      memoryError: null,
      memoryTurnCount: 0,
      memoryUptoSeq: room.messageCount,
      memoryUpdatedAt: new Date(),
    });
    this.realtime.toRoom(scope.profile, room.id, 'room.cleared', {
      room_id: room.id,
      total_tokens: 0,
    });
  }

  // --------------------------------------------------------------- presets

  private async availability(
    scope: RoomScope,
    agentId: string,
  ): Promise<{ available: boolean; error: string | null }> {
    const agent = await this.ports.seats?.agent(scope.workspace, agentId).catch(() => null);
    if (!agent) return { available: false, error: 'agent_not_found' };
    if (!agent.available)
      return { available: false, error: agent.unavailableReason ?? 'unavailable' };
    return { available: true, error: null };
  }

  async listPresets(scope: RoomScope): Promise<Json[]> {
    const rows = this.store.presets(scope.workspace);
    return Promise.all(
      rows.map(async (row) =>
        toPreset(row, scope.profile, await this.availability(scope, row.agentId)),
      ),
    );
  }

  async createPreset(
    scope: RoomScope,
    body: { name?: string; seat?: SeatConfigInput },
  ): Promise<Json> {
    if (!body.name?.trim() || !body.seat) {
      throw new HubError('validation_failed', {
        details: { field: body.name?.trim() ? 'seat' : 'name', reason: 'required' },
      });
    }
    const row = this.store.insertPreset({
      workspace: scope.workspace,
      ownerId: scope.userId,
      name: body.name.trim(),
      agentId: body.seat.agent_id,
      seat: { ...body.seat } as Json,
    });
    return toPreset(row, scope.profile, await this.availability(scope, row.agentId));
  }

  async updatePreset(
    scope: RoomScope,
    presetId: string,
    body: { name?: string; seat?: SeatConfigInput },
  ): Promise<Json> {
    const row = this.store.preset(scope.workspace, presetId);
    if (!row) throw notFound({ resource: 'seat_preset', id: presetId });
    const values: Partial<typeof row> = {};
    if (body.name !== undefined) values.name = body.name.trim();
    if (body.seat) {
      values.seat = { ...body.seat } as Json;
      values.agentId = body.seat.agent_id;
    }
    const updated = this.store.updatePreset(scope.workspace, row.id, values) as typeof row;
    return toPreset(updated, scope.profile, await this.availability(scope, updated.agentId));
  }

  deletePreset(scope: RoomScope, presetId: string): void {
    if (!this.store.preset(scope.workspace, presetId)) {
      throw notFound({ resource: 'seat_preset', id: presetId });
    }
    this.store.deletePreset(scope.workspace, presetId);
  }
}

// ------------------------------------------------------------------ helpers

export function joinUrl(hubUrl: string, code: string): string {
  return `${hubUrl.replace(/\/+$/, '')}/join/${code}`;
}

function encodeRoomCursor(key: number, id: string): string {
  return Buffer.from(`${key}:${id}`, 'utf8').toString('base64url');
}

function decodeRoomCursor(cursor: string | undefined): { key: number; id: string } | null {
  if (!cursor) return null;
  const [key, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  const value = Number(key);
  return Number.isFinite(value) && id && id.length === 26 ? { key: value, id } : null;
}

function envelopeOf(error: unknown, language: 'ar' | 'en'): Json {
  if (error instanceof HubError) return error.toEnvelope(language) as unknown as Json;
  return { error: error instanceof Error ? error.message : String(error), code: 'internal' };
}
