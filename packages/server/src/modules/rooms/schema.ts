/**
 * rooms — several agents (seats) and users in one conversation, with
 * mentions, handoffs and a hub-maintained room memory.
 *
 * All tables are workspace-scoped. A seat is backed by a session owned by the
 * `sessions` module (seats.session_id); the room fans messages into seat
 * sessions and collects replies as room_messages.
 *
 * Cross-module id columns: seats.agent_id -> agents.agents,
 * seats.session_id -> sessions.sessions, room_messages.run_id -> sessions.runs,
 * room_members.user_id / room_messages.author_user_id -> auth.users,
 * room_messages.attachment_ids -> knowledge.attachments.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  sqliteTable,
  text,
  uniqueIndex,
  integer,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import {
  EMPTY_ARRAY,
  EMPTY_OBJECT,
  inList,
  json,
  scopedColumns,
  timestampMs,
  ulid,
} from '../../db/columns.js';

export const TURN_POLICIES = ['mention', 'round_robin', 'free'] as const;
export const ROOM_MEMBER_ROLES = ['owner', 'member'] as const;
export const SEAT_STATUSES = ['active', 'muted', 'left'] as const;
export const ROOM_AUTHOR_KINDS = ['user', 'seat', 'system'] as const;
export const HANDOFF_STATUSES = [
  'pending',
  'accepted',
  'completed',
  'rejected',
  'cancelled',
] as const;

export type RoomSettings = {
  /** Seconds a seat may take before the room moves on. */
  seatTimeoutSeconds?: number;
  /** Refresh the room memory every N messages. */
  memoryEveryMessages?: number;
};

export type RoomMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string }
  | { type: 'file'; attachmentId: string };

export const rooms = sqliteTable(
  'rooms',
  {
    ...scopedColumns(),
    name: text('name', { length: 120 }).notNull(),
    description: text('description'),
    icon: text('icon', { length: 64 }),
    turnPolicy: text('turn_policy', { enum: TURN_POLICIES }).notNull().default('mention'),
    /** Cap on agent-to-agent replies per human message; stops loops. */
    maxAgentTurns: integer('max_agent_turns').notNull().default(4),
    /** Rolling summary the hub maintains and injects into every seat session. */
    memory: text('memory'),
    memoryUpdatedAt: timestampMs('memory_updated_at'),
    messageCount: integer('message_count').notNull().default(0),
    lastMessageAt: timestampMs('last_message_at'),
    settings: json<RoomSettings>('settings').notNull().default(EMPTY_OBJECT),
    archivedAt: timestampMs('archived_at'),
  },
  (t) => [
    index('rooms_workspace_recent_idx').on(t.workspace, t.archivedAt, t.lastMessageAt),
    check('rooms_turn_policy_check', inList(t.turnPolicy, TURN_POLICIES)),
  ],
);

export const roomMembers = sqliteTable(
  'room_members',
  {
    ...scopedColumns(),
    roomId: ulid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: ulid('user_id').notNull(),
    role: text('role', { enum: ROOM_MEMBER_ROLES }).notNull().default('member'),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
  },
  (t) => [
    uniqueIndex('room_members_room_user_uq').on(t.roomId, t.userId),
    check('room_members_role_check', inList(t.role, ROOM_MEMBER_ROLES)),
  ],
);

export const seats = sqliteTable(
  'seats',
  {
    ...scopedColumns(),
    roomId: ulid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    agentId: ulid('agent_id').notNull(),
    /** The seat's private session with its agent (sessions module). */
    sessionId: ulid('session_id').notNull(),
    /** Display name in the room, e.g. "Reviewer"; defaults to the agent name. */
    alias: text('alias', { length: 64 }).notNull(),
    /** Extra instructions for this seat, prepended to every turn. */
    persona: text('persona'),
    color: text('color', { length: 16 }),
    position: integer('position').notNull().default(0),
    status: text('status', { enum: SEAT_STATUSES }).notNull().default('active'),
    joinedAt: timestampMs('joined_at').notNull(),
    leftAt: timestampMs('left_at'),
    lastSpokeAt: timestampMs('last_spoke_at'),
  },
  (t) => [
    uniqueIndex('seats_room_session_uq').on(t.roomId, t.sessionId),
    index('seats_room_position_idx').on(t.roomId, t.position),
    check('seats_status_check', inList(t.status, SEAT_STATUSES)),
  ],
);

export const roomMessages = sqliteTable(
  'room_messages',
  {
    ...scopedColumns(),
    roomId: ulid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    authorKind: text('author_kind', { enum: ROOM_AUTHOR_KINDS }).notNull(),
    authorUserId: ulid('author_user_id'),
    seatId: ulid('seat_id').references(() => seats.id, { onDelete: 'set null' }),
    content: text('content').notNull().default(''),
    parts: json<RoomMessagePart[]>('parts').notNull().default(EMPTY_ARRAY),
    /** Seat ids addressed with @; drives the `mention` turn policy. */
    mentions: json<string[]>('mentions').notNull().default(EMPTY_ARRAY),
    attachmentIds: json<string[]>('attachment_ids').notNull().default(EMPTY_ARRAY),
    replyToId: ulid('reply_to_id').references((): AnySQLiteColumn => roomMessages.id, {
      onDelete: 'set null',
    }),
    /** The seat's run that produced this message (sessions module). */
    runId: ulid('run_id'),
    handoffId: ulid('handoff_id').references((): AnySQLiteColumn => handoffs.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('room_messages_room_seq_uq').on(t.roomId, t.seq),
    index('room_messages_seat_idx').on(t.seatId),
    check('room_messages_author_kind_check', inList(t.authorKind, ROOM_AUTHOR_KINDS)),
  ],
);

export const handoffs = sqliteTable(
  'handoffs',
  {
    ...scopedColumns(),
    roomId: ulid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    fromSeatId: ulid('from_seat_id')
      .notNull()
      .references(() => seats.id, { onDelete: 'cascade' }),
    toSeatId: ulid('to_seat_id')
      .notNull()
      .references(() => seats.id, { onDelete: 'cascade' }),
    /** The room message that asked for the handoff. */
    requestMessageId: ulid('request_message_id').references(
      (): AnySQLiteColumn => roomMessages.id,
      {
        onDelete: 'set null',
      },
    ),
    /** What the receiving seat is asked to do, in the sender's words. */
    brief: text('brief').notNull(),
    /** Files, task ids, snippets the sender attached. */
    context: json<Record<string, unknown>>('context').notNull().default(EMPTY_OBJECT),
    status: text('status', { enum: HANDOFF_STATUSES }).notNull().default('pending'),
    acceptedAt: timestampMs('accepted_at'),
    completedAt: timestampMs('completed_at'),
    /** The room message the receiver answered with. */
    resultMessageId: ulid('result_message_id'),
  },
  (t) => [
    index('handoffs_room_status_idx').on(t.roomId, t.status),
    check('handoffs_status_check', inList(t.status, HANDOFF_STATUSES)),
    check('handoffs_distinct_seats_check', sql`${t.fromSeatId} <> ${t.toSeatId}`),
  ],
);
