# rooms

Owns: `room`, `room_member`, `seat`, `room_message`, `handoff`. Schema:
`packages/server/src/modules/rooms/schema.ts`. All scoped. Base columns
omitted.

Realtime namespace `/rt/rooms`: `room_message.posted`, `seat.typing`,
`seat.joined`, `seat.left`, `handoff.requested`, `handoff.completed`,
`room.memory_updated`.

**Since migration `0017` (contract decision §57)** the tables carry what the contract's room,
seat and message need, and this page's older columns map as follows: `seat.alias` is the
seat's `name`, `seat.persona` its `instructions`, and `seat.status = left` is a removed seat;
`room` gained `working_dir`, `invite_code` (unique), `can_mention_all`, `lead_seat_id`, the
summary and handoff policies, `total_tokens`, the memory's status/error/coverage and
`context_from_seq`; `seat` gained `description`, `model`, `provider`, `reasoning_effort`,
`avatar`, `preset_id` and `seen_seq` (the last room `seq` the seat was shown);
`room_message` gained `status`, `author_name`, `session_id`, `mention_list` (the contract's
`Mention` objects), `handoff`, `reasoning` and `usage`. `room.turn_policy` and
`max_agent_turns` are not read: who answers is §57's rule (mentions, `@all`, else the lead
seat) and the loop breaker is the handoff policy's `max_depth`. Agent-to-agent passes are
`room_handoff_chains` (the contract's `HandoffChain`), not the founding `handoff` table,
which stays unused. `seat_presets` holds saved seats. Room members are `owner` or `member`.

A room fans a posted message into every addressed seat's session (a
`messages` row of role `user` with the room log rendered as context), runs
the seat's agent (an ordinary `run`), and posts the reply back as a
`room_message` (`DECISIONS.md` §1, §12).

## room (scoped)

| column | type | meaning |
|---|---|---|
| name | text(120) | |
| description, icon | | |
| turn_policy | enum(mention, round_robin, free) | who answers a human message: only @mentioned seats, the next seat, or every seat |
| max_agent_turns | int (4) | cap on agent-to-agent replies per human message; loop breaker |
| memory | text? | rolling summary the hub maintains and injects into every seat turn |
| memory_updated_at | ms? | |
| message_count, last_message_at | | list card ("agentCount", "updatedAt") |
| settings | json<RoomSettings> | seatTimeoutSeconds, memoryEveryMessages |
| archived_at | ms? | |

Indexes: (workspace, archived_at, last_message_at).

## room_member (scoped)

Humans in the room (the client shows `memberCount`).

| column | type | meaning |
|---|---|---|
| room_id | ulid → room (FK, cascade) | |
| user_id | ulid → auth.user | |
| role | enum(owner, member) | |
| last_read_seq | int | unread counter = `room.message_count - last_read_seq` |

Indexes: unique (room_id, user_id).

## seat (scoped)

An agent in a room.

| column | type | meaning |
|---|---|---|
| room_id | ulid → room (FK, cascade) | |
| agent_id | ulid → agents.agent | |
| session_id | ulid → sessions.session | the seat's private session (`origin_kind = room`, `origin_id = seat.id`) |
| alias | text(64) | name in the room ("Reviewer"); an agent may sit twice with two aliases |
| persona | text? | instructions prepended to every turn |
| color | text(16)? | |
| position | int | order in the header |
| status | enum(active, muted, left) | muted seats read but never answer; left seats keep history |
| joined_at, left_at, last_spoke_at | | |

Indexes: unique (room_id, session_id); (room_id, position).

## room_message (scoped)

| column | type | meaning |
|---|---|---|
| room_id | ulid → room (FK, cascade) | |
| seq | int | order in the room; unique per room |
| author_kind | enum(user, seat, system) | the client's `isAgent` = `author_kind = seat` |
| author_user_id | ulid? → auth.user | |
| seat_id | ulid? → seat (FK, set null) | |
| content | text | Markdown |
| parts | json<RoomMessagePart[]> | text / image / file |
| mentions | json<string[]> | seat ids addressed with @ |
| attachment_ids | json<string[]> | knowledge.attachment |
| reply_to_id | ulid? → room_message (FK, set null) | |
| run_id | ulid? → sessions.run | the seat run that produced it; cost and tool calls live there |
| handoff_id | ulid? → handoff (FK, set null) | when the message is a handoff request or result |

Indexes: unique (room_id, seq); `seat_id`.

## handoff (scoped)

One seat delegating scoped work to another, with a brief and context.

| column | type | meaning |
|---|---|---|
| room_id | ulid → room (FK, cascade) | |
| from_seat_id, to_seat_id | ulid → seat (FK, cascade); distinct (CHECK) | |
| request_message_id | ulid? → room_message (FK, set null) | |
| brief | text | what is asked |
| context | json | task ids, file paths, snippets |
| status | enum(pending, accepted, completed, rejected, cancelled) | |
| accepted_at, completed_at | | |
| result_message_id | ulid? | the receiver's answer |

Lifecycle: `pending → accepted → completed`; `pending → rejected`;
`pending | accepted → cancelled`. `completed`, `rejected`, `cancelled` are
terminal.

Indexes: (room_id, status).

## Queries the clients need

- Room list: scoped, not archived, order by `last_message_at desc`, with
  `count(seats where status != left)` and `count(room_members)`.
- Room screen: seats by position; messages by `seq` paged backwards; then
  subscribe.
- Post: insert `room_message(author_kind=user)`, resolve addressed seats by
  policy, create one run per seat through the sessions module, post replies.
- Handoff inbox: `handoffs where to_seat_id in (my seats) and status = pending`.
- Room cost: audit `usage_records where origin_kind = 'room' and origin_id = room.id`.

## Not stored

- Typing indicators, seat "thinking" state: realtime only.
- The rendered context each seat received (derivable from the room log up to
  that `seq`).
- Seat transcripts: they are the seat's session, owned by `sessions`.
