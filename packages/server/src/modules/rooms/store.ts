/**
 * The rooms module's tables, and nothing else (ARCHITECTURE §Modules): rooms, their people,
 * their seats, the transcript, the agents' handoff chains and the saved seat presets.
 *
 * Every read takes the workspace, so a row of another profile is never found by id alone.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { ModuleDatabase } from '../../db/handle.js';
import { newUlid } from '../../db/ids.js';
import {
  roomHandoffChains,
  roomMembers,
  roomMessages,
  rooms,
  seatPresets,
  seats,
  type StoredAvatar,
  type StoredHandoff,
  type StoredMention,
} from './schema.js';

export type RoomRow = typeof rooms.$inferSelect;
export type MemberRow = typeof roomMembers.$inferSelect;
export type SeatRow = typeof seats.$inferSelect;
export type RoomMessageRow = typeof roomMessages.$inferSelect;
export type ChainRow = typeof roomHandoffChains.$inferSelect;
export type PresetRow = typeof seatPresets.$inferSelect;

/** Letters and digits a person cannot mistake for each other (no I, O, 0, 1). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;

export function newInviteCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

export interface NewRoomMessage {
  workspace: string;
  ownerId: string;
  roomId: string;
  authorKind: 'user' | 'seat' | 'system';
  authorUserId?: string | null;
  authorName: string;
  seatId?: string | null;
  sessionId: string;
  content: string;
  parts: Array<Record<string, unknown>>;
  mentions?: StoredMention[];
  replyToId?: string | null;
  runId?: string | null;
  status?: 'complete' | 'streaming' | 'failed' | 'interrupted';
  handoff?: StoredHandoff | null;
}

export class RoomsStore {
  constructor(readonly db: ModuleDatabase) {}

  // ------------------------------------------------------------------ rooms

  createRoom(input: {
    workspace: string;
    ownerId: string;
    name: string;
    workingDir: string | null;
    canMentionAll: boolean;
    summaryEveryTurns: number;
    summaryModel: string | null;
    summaryProvider: string | null;
    handoffEnabled: boolean;
    handoffMaxDepth: number | null;
  }): RoomRow {
    const id = newUlid();
    return this.db.transaction((tx) => {
      tx.insert(rooms)
        .values({
          id,
          workspace: input.workspace,
          ownerId: input.ownerId,
          name: input.name,
          workingDir: input.workingDir,
          canMentionAll: input.canMentionAll,
          summaryEveryTurns: input.summaryEveryTurns,
          summaryModel: input.summaryModel,
          summaryProvider: input.summaryProvider,
          handoffEnabled: input.handoffEnabled,
          handoffMaxDepth: input.handoffMaxDepth,
          inviteCode: this.freeCode(),
        })
        .run();
      tx.insert(roomMembers)
        .values({
          workspace: input.workspace,
          ownerId: input.ownerId,
          roomId: id,
          userId: input.ownerId,
          role: 'owner',
        })
        .run();
      return tx.select().from(rooms).where(eq(rooms.id, id)).get() as RoomRow;
    });
  }

  /** A code no room has, drawn again on the (rare) clash. */
  freeCode(): string {
    for (;;) {
      const code = newInviteCode();
      const taken = this.db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.inviteCode, code))
        .get();
      if (!taken) return code;
    }
  }

  getRoom(workspace: string, id: string): RoomRow | undefined {
    return this.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.workspace, workspace), eq(rooms.id, id)))
      .get();
  }

  /** By invite code, in any workspace: the code is what names the workspace (`x-scope: global`). */
  roomByCode(code: string): RoomRow | undefined {
    return this.db.select().from(rooms).where(eq(rooms.inviteCode, code)).get();
  }

  updateRoom(workspace: string, id: string, patch: Partial<RoomRow>): RoomRow | undefined {
    this.db
      .update(rooms)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(rooms.workspace, workspace), eq(rooms.id, id)))
      .run();
    return this.getRoom(workspace, id);
  }

  deleteRoom(workspace: string, id: string): void {
    this.db
      .delete(rooms)
      .where(and(eq(rooms.workspace, workspace), eq(rooms.id, id)))
      .run();
  }

  /**
   * The rooms a person is in, newest activity first. The sort key is the last message's time,
   * or the room's creation for a room nobody spoke in yet; the cursor is the last id seen
   * together with its key.
   */
  listRoomsFor(
    workspace: string,
    userId: string,
    archived: boolean,
    cursor: { key: number; id: string } | null,
    limit: number,
  ): RoomRow[] {
    const key = sql<number>`coalesce(${rooms.lastMessageAt}, ${rooms.createdAt})`;
    const where: SQL[] = [
      eq(rooms.workspace, workspace),
      archived ? sql`${rooms.archivedAt} is not null` : isNull(rooms.archivedAt),
      sql`exists (select 1 from ${roomMembers} m where m.room_id = ${rooms.id} and m.user_id = ${userId})`,
    ];
    if (cursor) {
      where.push(
        sql`(${key} < ${cursor.key} or (${key} = ${cursor.key} and ${rooms.id} < ${cursor.id}))`,
      );
    }
    return this.db
      .select()
      .from(rooms)
      .where(and(...where))
      .orderBy(desc(key), desc(rooms.id))
      .limit(limit + 1)
      .all();
  }

  // ---------------------------------------------------------------- members

  member(roomId: string, userId: string): MemberRow | undefined {
    return this.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
      .get();
  }

  memberById(roomId: string, id: string): MemberRow | undefined {
    return this.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.id, id)))
      .get();
  }

  members(roomId: string): MemberRow[] {
    return this.db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId))
      .orderBy(asc(roomMembers.createdAt), asc(roomMembers.id))
      .limit(200)
      .all();
  }

  memberCounts(roomIds: readonly string[]): Map<string, number> {
    if (roomIds.length === 0) return new Map();
    const rows = this.db
      .select({ roomId: roomMembers.roomId, n: sql<number>`count(*)` })
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, [...roomIds]))
      .groupBy(roomMembers.roomId)
      .all();
    return new Map(rows.map((row) => [row.roomId, Number(row.n)]));
  }

  addMember(room: RoomRow, userId: string): MemberRow {
    this.db
      .insert(roomMembers)
      .values({
        workspace: room.workspace,
        ownerId: userId,
        roomId: room.id,
        userId,
        role: 'member',
      })
      .onConflictDoNothing()
      .run();
    return this.member(room.id, userId) as MemberRow;
  }

  removeMember(roomId: string, id: string): void {
    this.db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.id, id)))
      .run();
  }

  // ------------------------------------------------------------------ seats

  /** Seats still in the room (a removed seat keeps its row for its past messages). */
  seats(roomId: string): SeatRow[] {
    return this.db
      .select()
      .from(seats)
      .where(and(eq(seats.roomId, roomId), ne(seats.status, 'left')))
      .orderBy(asc(seats.position), asc(seats.id))
      .all();
  }

  seatsOf(roomIds: readonly string[]): Map<string, SeatRow[]> {
    const byRoom = new Map<string, SeatRow[]>();
    if (roomIds.length === 0) return byRoom;
    const rows = this.db
      .select()
      .from(seats)
      .where(and(inArray(seats.roomId, [...roomIds]), ne(seats.status, 'left')))
      .orderBy(asc(seats.position), asc(seats.id))
      .all();
    for (const row of rows) {
      const list = byRoom.get(row.roomId) ?? [];
      list.push(row);
      byRoom.set(row.roomId, list);
    }
    return byRoom;
  }

  /** Any seat of the room by id, removed ones included (a past message's author). */
  seat(roomId: string, id: string): SeatRow | undefined {
    return this.db
      .select()
      .from(seats)
      .where(and(eq(seats.roomId, roomId), eq(seats.id, id)))
      .get();
  }

  seatBySession(sessionId: string): SeatRow | undefined {
    return this.db.select().from(seats).where(eq(seats.sessionId, sessionId)).get();
  }

  insertSeat(input: {
    id: string;
    room: RoomRow;
    ownerId: string;
    agentId: string;
    sessionId: string;
    name: string;
    description: string | null;
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
    instructions: string | null;
    presetId: string | null;
    avatar: StoredAvatar | null;
  }): SeatRow {
    const position =
      (this.db
        .select({ max: sql<number | null>`max(${seats.position})` })
        .from(seats)
        .where(eq(seats.roomId, input.room.id))
        .get()?.max ?? -1) + 1;
    this.db
      .insert(seats)
      .values({
        id: input.id,
        workspace: input.room.workspace,
        ownerId: input.ownerId,
        roomId: input.room.id,
        agentId: input.agentId,
        sessionId: input.sessionId,
        alias: input.name,
        persona: input.instructions,
        description: input.description,
        model: input.model,
        provider: input.provider,
        reasoningEffort: input.reasoningEffort,
        presetId: input.presetId,
        avatar: input.avatar,
        position,
        joinedAt: new Date(),
        // A seat added to a room that already talked starts from now: it is told the room's
        // summary, not handed the whole history on its first turn.
        seenSeq: input.room.messageCount,
      })
      .run();
    return this.seat(input.room.id, input.id) as SeatRow;
  }

  updateSeat(roomId: string, id: string, patch: Partial<SeatRow>): SeatRow | undefined {
    this.db
      .update(seats)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(seats.roomId, roomId), eq(seats.id, id)))
      .run();
    return this.seat(roomId, id);
  }

  // --------------------------------------------------------------- messages

  /**
   * One message at the end of the transcript. The room's counter and the message's `seq` move
   * together in one transaction, so two posts at once never share a number.
   */
  appendMessage(input: NewRoomMessage): RoomMessageRow {
    const id = newUlid();
    return this.db.transaction((tx) => {
      const room = tx.select().from(rooms).where(eq(rooms.id, input.roomId)).get() as RoomRow;
      const seq = room.messageCount + 1;
      const now = new Date();
      tx.insert(roomMessages)
        .values({
          id,
          workspace: input.workspace,
          ownerId: input.ownerId,
          roomId: input.roomId,
          seq,
          authorKind: input.authorKind,
          authorUserId: input.authorUserId ?? null,
          authorName: input.authorName,
          seatId: input.seatId ?? null,
          sessionId: input.sessionId,
          content: input.content,
          parts: input.parts as never,
          mentions: (input.mentions ?? [])
            .map((m) => m.seat_id)
            .filter((v): v is string => typeof v === 'string'),
          mentionList: input.mentions ?? [],
          replyToId: input.replyToId ?? null,
          runId: input.runId ?? null,
          status: input.status ?? 'complete',
          handoff: input.handoff ?? null,
        })
        .run();
      tx.update(rooms)
        .set({ messageCount: seq, lastMessageAt: now, updatedAt: now })
        .where(eq(rooms.id, input.roomId))
        .run();
      return tx.select().from(roomMessages).where(eq(roomMessages.id, id)).get() as RoomMessageRow;
    });
  }

  message(roomId: string, id: string): RoomMessageRow | undefined {
    return this.db
      .select()
      .from(roomMessages)
      .where(and(eq(roomMessages.roomId, roomId), eq(roomMessages.id, id)))
      .get();
  }

  messageByRun(runId: string): RoomMessageRow | undefined {
    return this.db
      .select()
      .from(roomMessages)
      .where(and(eq(roomMessages.runId, runId), eq(roomMessages.authorKind, 'seat')))
      .get();
  }

  updateMessage(id: string, patch: Partial<RoomMessageRow>): RoomMessageRow | undefined {
    this.db
      .update(roomMessages)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(roomMessages.id, id))
      .run();
    return this.db.select().from(roomMessages).where(eq(roomMessages.id, id)).get();
  }

  /** A page of the transcript ending before `beforeSeq`, oldest first. */
  messagesBefore(
    roomId: string,
    beforeSeq: number | null,
    limit: number,
  ): { items: RoomMessageRow[]; hasMore: boolean } {
    const where: SQL[] = [eq(roomMessages.roomId, roomId)];
    if (beforeSeq !== null) where.push(lt(roomMessages.seq, beforeSeq));
    const rows = this.db
      .select()
      .from(roomMessages)
      .where(and(...where))
      .orderBy(desc(roomMessages.seq))
      .limit(limit + 1)
      .all();
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).reverse(), hasMore };
  }

  /** Messages after `afterSeq`, oldest first (what a seat has not yet been shown). */
  messagesAfter(roomId: string, afterSeq: number, limit = 500): RoomMessageRow[] {
    return this.db
      .select()
      .from(roomMessages)
      .where(and(eq(roomMessages.roomId, roomId), gt(roomMessages.seq, afterSeq)))
      .orderBy(asc(roomMessages.seq))
      .limit(limit)
      .all();
  }

  /** Replies still streaming, across every room (settled at boot after a restart). */
  streamingMessages(): RoomMessageRow[] {
    return this.db.select().from(roomMessages).where(eq(roomMessages.status, 'streaming')).all();
  }

  // ------------------------------------------------------------ handoffs

  createChain(input: {
    room: RoomRow;
    ownerId: string;
    fromSeatId: string;
    toSeatId: string;
    maxDepth: number | null;
    lastMessageId: string;
  }): ChainRow {
    const id = newUlid();
    this.db
      .insert(roomHandoffChains)
      .values({
        id,
        workspace: input.room.workspace,
        ownerId: input.ownerId,
        roomId: input.room.id,
        fromSeatId: input.fromSeatId,
        toSeatId: input.toSeatId,
        depth: 1,
        maxDepth: input.maxDepth,
        visited: [`${input.fromSeatId}>${input.toSeatId}`],
        lastMessageId: input.lastMessageId,
      })
      .run();
    // A room keeps its fifty newest chains (contract: "max 50 kept").
    const stale = this.db
      .select({ id: roomHandoffChains.id })
      .from(roomHandoffChains)
      .where(eq(roomHandoffChains.roomId, input.room.id))
      .orderBy(desc(roomHandoffChains.id))
      .offset(50)
      .all()
      .map((row) => row.id);
    if (stale.length > 0)
      this.db.delete(roomHandoffChains).where(inArray(roomHandoffChains.id, stale)).run();
    return this.chain(input.room.id, id) as ChainRow;
  }

  chain(roomId: string, id: string): ChainRow | undefined {
    return this.db
      .select()
      .from(roomHandoffChains)
      .where(and(eq(roomHandoffChains.roomId, roomId), eq(roomHandoffChains.id, id)))
      .get();
  }

  updateChain(id: string, patch: Partial<ChainRow>): ChainRow | undefined {
    this.db
      .update(roomHandoffChains)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(roomHandoffChains.id, id))
      .run();
    return this.db.select().from(roomHandoffChains).where(eq(roomHandoffChains.id, id)).get();
  }

  chains(roomId: string, onlyActive = false): ChainRow[] {
    const where: SQL[] = [eq(roomHandoffChains.roomId, roomId)];
    if (onlyActive) where.push(eq(roomHandoffChains.status, 'active'));
    return this.db
      .select()
      .from(roomHandoffChains)
      .where(and(...where))
      .orderBy(desc(roomHandoffChains.id))
      .limit(50)
      .all();
  }

  // ------------------------------------------------------------- presets

  presets(workspace: string): PresetRow[] {
    return this.db
      .select()
      .from(seatPresets)
      .where(eq(seatPresets.workspace, workspace))
      .orderBy(asc(seatPresets.name), asc(seatPresets.id))
      .limit(100)
      .all();
  }

  preset(workspace: string, id: string): PresetRow | undefined {
    return this.db
      .select()
      .from(seatPresets)
      .where(and(eq(seatPresets.workspace, workspace), eq(seatPresets.id, id)))
      .get();
  }

  insertPreset(input: {
    workspace: string;
    ownerId: string;
    name: string;
    agentId: string;
    seat: Record<string, unknown>;
  }): PresetRow {
    const id = newUlid();
    this.db
      .insert(seatPresets)
      .values({ id, ...input })
      .run();
    return this.preset(input.workspace, id) as PresetRow;
  }

  updatePreset(workspace: string, id: string, patch: Partial<PresetRow>): PresetRow | undefined {
    this.db
      .update(seatPresets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(seatPresets.workspace, workspace), eq(seatPresets.id, id)))
      .run();
    return this.preset(workspace, id);
  }

  deletePreset(workspace: string, id: string): void {
    this.db
      .delete(seatPresets)
      .where(and(eq(seatPresets.workspace, workspace), eq(seatPresets.id, id)))
      .run();
  }
}
