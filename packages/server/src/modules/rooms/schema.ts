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
  bool,
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

/** The contract's `Mention`: a seat by id, or every seat (`@all`). */
export type StoredMention = { kind: 'seat' | 'all'; seat_id: string | null };

/** The contract's `Handoff`, set on a seat's reply that passes the turn to another seat. */
export type StoredHandoff = { to_seat_id: string; chain_id: string; depth: number };

/** The contract's `Avatar` as a seat keeps it. */
export type StoredAvatar = { kind: 'image' | 'generated'; url: string | null; seed: string | null };

/**
 * A stored block, in the contract's `ContentBlock` shape so it is served as written: a file
 * carries its attachment's name, type, size and address as they were when it was posted.
 */
export type RoomMessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'file';
      attachment_id: string;
      name?: string;
      mime?: string;
      size_bytes?: number;
      url?: string;
    };

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
    // Since migration 0020 (DECISIONS §69): the contract's room.
    workingDir: text('working_dir'),
    /** Upper-case code of `[A-Z2-9]`; the public link is `<hub>/join/<code>`. */
    inviteCode: text('invite_code', { length: 12 }),
    canMentionAll: bool('can_mention_all').notNull().default(true),
    /** The seat that answers a message mentioning nobody; `null` = nobody. */
    leadSeatId: ulid('lead_seat_id'),
    summaryEveryTurns: integer('summary_every_turns').notNull().default(20),
    summaryModel: text('summary_model'),
    summaryProvider: text('summary_provider'),
    handoffEnabled: bool('handoff_enabled').notNull().default(true),
    /** `null` = unlimited; the contract's `HandoffPolicy.max_depth`. */
    handoffMaxDepth: integer('handoff_max_depth').default(3),
    totalTokens: integer('total_tokens').notNull().default(0),
    /** `idle | summarizing | error` — the contract's `RoomMemory.status`. */
    memoryStatus: text('memory_status', { length: 16 }).notNull().default('idle'),
    memoryError: text('memory_error'),
    /** How many messages the summary covers (`RoomMemory.summarized_turn_count`). */
    memoryTurnCount: integer('memory_turn_count').notNull().default(0),
    /** The last `seq` the summary covers; transcript before it reaches seats as the summary. */
    memoryUptoSeq: integer('memory_upto_seq').notNull().default(0),
    /** Messages before this `seq` are not context any more (`rooms.clearContext`). */
    contextFromSeq: integer('context_from_seq').notNull().default(0),
  },
  (t) => [
    index('rooms_workspace_recent_idx').on(t.workspace, t.archivedAt, t.lastMessageAt),
    uniqueIndex('rooms_invite_code_uq').on(t.inviteCode),
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
    index('room_members_user_idx').on(t.userId),
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
    // Since migration 0020: the contract's `SeatConfig` (alias is its `name`, persona its
    // `instructions`).
    description: text('description'),
    model: text('model'),
    provider: text('provider'),
    reasoningEffort: text('reasoning_effort', { length: 16 }),
    avatar: json<StoredAvatar>('avatar'),
    presetId: ulid('preset_id'),
    /** The last room `seq` this seat was shown; its next turn starts after it. */
    seenSeq: integer('seen_seq').notNull().default(0),
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
    // Since migration 0020: what the contract's `Message` needs of a room message.
    /** `complete | streaming | failed | interrupted`. */
    status: text('status', { length: 16 }).notNull().default('complete'),
    /** The author's name when it was written: a seat or a person may leave. */
    authorName: text('author_name'),
    /** The seat's session for a seat's reply; the room's id otherwise (DECISIONS §69). */
    sessionId: ulid('session_id'),
    /** `mentions` holds the contract's `Mention` objects since 0020. */
    mentionList: json<StoredMention[]>('mention_list').notNull().default(EMPTY_ARRAY),
    handoff: json<StoredHandoff>('handoff'),
    reasoning: text('reasoning'),
    usage: json<Record<string, unknown>>('usage'),
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

export const HANDOFF_CHAIN_STATUSES = ['active', 'stopped', 'completed', 'failed'] as const;

/**
 * One run of agents passing the turn to each other (contract `HandoffChain`, DECISIONS §69).
 * A chain starts when a seat's reply to a person mentions another seat; every further pass
 * adds one to `depth`. The guard stops it at `max_depth` or when a pass repeats one the
 * chain already made (`visited`).
 */
export const roomHandoffChains = sqliteTable(
  'room_handoff_chains',
  {
    ...scopedColumns(),
    roomId: ulid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    fromSeatId: ulid('from_seat_id').notNull(),
    toSeatId: ulid('to_seat_id').notNull(),
    status: text('status', { enum: HANDOFF_CHAIN_STATUSES }).notNull().default('active'),
    stopReason: text('stop_reason', { length: 32 }),
    depth: integer('depth').notNull().default(1),
    maxDepth: integer('max_depth'),
    continueUsed: bool('continue_used').notNull().default(false),
    error: text('error'),
    /** `from>to` pairs the chain already made; a repeat is a loop. */
    visited: json<string[]>('visited').notNull().default(EMPTY_ARRAY),
    /** The message that asked for the pass the chain stopped at (`continueHandoff`). */
    lastMessageId: ulid('last_message_id'),
  },
  (t) => [
    index('room_handoff_chains_room_idx').on(t.roomId, t.updatedAt),
    check('room_handoff_chains_status_check', inList(t.status, HANDOFF_CHAIN_STATUSES)),
  ],
);

/** A seat saved to be reused in any room of the profile (contract `SeatPreset`). */
export const seatPresets = sqliteTable(
  'seat_presets',
  {
    ...scopedColumns(),
    name: text('name', { length: 80 }).notNull(),
    agentId: ulid('agent_id').notNull(),
    /** The contract's `SeatConfig`, as written. */
    seat: json<Record<string, unknown>>('seat').notNull().default(EMPTY_OBJECT),
  },
  (t) => [index('seat_presets_workspace_idx').on(t.workspace, t.name)],
);
