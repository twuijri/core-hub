# Realtime events

Socket.IO namespaces mirror the modules that stream (ARCHITECTURE §Realtime).
Every event is declared here and has one JSON Schema file per namespace directory:
`events/<namespace>/<entity>.<verb>.schema.json`. Shared entity shapes live in
`events/common.schema.json`, which is **generated** from `openapi.yaml`
(`components.schemas` → `$defs`) so HTTP and realtime never disagree. Every
operation in `openapi.yaml` lists the events it may cause under `x-rt-events`;
the generator fails if an operation names an event that has no schema.

## Envelope

Every event is one Socket.IO message named after the event, whose single
argument is:

```json
{ "event": "message.delta", "namespace": "/rt/sessions", "profile": "work",
  "ts": "2026-09-21T10:15:04Z", "seq": 8812, "payload": { … } }
```

`seq` is monotonic per namespace and profile. A client that sees a gap
refetches the affected entity over HTTP (`GET /sessions/{id}`,
`GET /rooms/{id}`, `GET /task-columns`, …) and continues. `profile` is `null` only for
user-level events on `/rt/devices` (devices, pairing, notices).

## Connecting and subscribing (client → server)

Handshake `auth: { token, profile }` on every namespace except `/rt/devices` and `/rt/terminal`,
where `profile` is optional. Acks are always `{ ok: true }` or
`{ ok: false, error, code }` with a code from the fixed list in
`docs/contracts/README.md` §4.

`auth: { token, profile, profiles: 'all' }` (ADR 0016) also joins the rooms of every
other profile the signed-in person may enter — the server decides which, as it does
for `sessions.list?profiles=all` — so a client showing one list across profiles hears
`session.*` and `approval.*` from all of them. Each envelope names its `profile`, and
`seq` stays per (namespace, profile): a client that resumes a session keeps the highest
`seq` of **that session's profile** only. The same handshake on `/rt/tasks` and
`/rt/schedules` (DECISIONS §32) hears `task.*`, `project.*`, `schedule.*` and
`workflow*.*` of every profile the Tasks board and the Schedules page show.

The token is the same bearer as HTTP and is **required on every namespace** —
there is no anonymous realtime. A handshake without one, or with one the hub
refuses, fails: the client's `connect_error` carries the error code as its
message and as `data.code` (`unauthorized`, `token_expired`, `rate_limited`),
and `profile_not_found` when `profile` names a workspace the caller may not
enter. Socket.IO does not retry a refused handshake; a client refreshes its
token and connects again. The rooms a socket hears are decided by the server
from the verified token: its own user-level events, and the profile-wide events
of the workspaces it was admitted to (`profile`, and with `profiles: 'all'`
every one it may enter) — never another's. A `subscribe` to an entity that is
not in one of those workspaces (another workspace's session, an unknown id) is
refused with `not_found`, as `GET` of it would be. When access is taken
away — sign-out, a revoked token, a disabled or deleted user, a changed role or
membership, an archived workspace — the server disconnects the socket, and the
same token cannot bring it back.

| Namespace | Command | Payload | What it does |
|---|---|---|---|
| `/rt/sessions` | `subscribe` | `{ session_id, after_seq? }` | receive the session's message/run/tool events (profile-wide events need no subscription); with `after_seq`, resume — see below |
| `/rt/sessions` | `unsubscribe` | `{ session_id }` | stop |
| `/rt/rooms` | `join` | `{ room_id }` | become present in the room (`member.joined` if not yet a member is **not** implied — join via HTTP first) and receive its events |
| `/rt/rooms` | `leave` | `{ room_id }` | stop; presence goes offline |
| `/rt/rooms` | `typing` | `{ room_id, typing: true|false }` | broadcast `member.typing` |
| `/rt/tasks` | `subscribe` | `{ project_id }` or `{}` | receive one project's task events, or the whole workspace's |
| `/rt/tasks` | `unsubscribe` | `{ project_id }` or `{}` | stop |
| `/rt/schedules` | `subscribe` | `{ workflow_id }` or `{}` | receive a workflow's run/step events, or every schedule and workflow event of the workspace |
| `/rt/schedules` | `unsubscribe` | same | stop |
| `/rt/devices` | *(none)* | — | a device's own events arrive on connect; the socket also marks the device online/offline |
| `/rt/jobs` | *(none)* | — | every job of the profile arrives on connect |
| `/rt/terminal` | `open` | `{ profile, cols, rows }` | start a shell in `DATA_DIR/workspaces/<profile>`; ack `{ ok: true, session: TerminalSession }`, or `conflict` (`details.reason: terminal_limit`) when `max_sessions` already run |
| `/rt/terminal` | `attach` | `{ terminal_id }` | show a live session on this socket (after a reload); ack `{ ok: true, session, backlog }`, where `backlog` is the session's recent output to repaint the screen with; `not_found` for a session that is gone |
| `/rt/terminal` | `input` | `{ terminal_id, data }` | keystrokes and pasted text, as typed |
| `/rt/terminal` | `resize` | `{ terminal_id, cols, rows }` | the emulator's new size |
| `/rt/terminal` | `close` | `{ terminal_id }` | end the session (`terminal.exited` with `reason: closed`) |

### The owner's terminal (`/rt/terminal`)

The web terminal (DECISIONS §70) is a shell on the hub's host. It is the one namespace where
typing goes over the socket rather than HTTP — a keystroke is not an action with an
idempotency key. Its handshake is refused with `forbidden` unless the hub runs with
`COREHUB_WEB_TERMINAL=1` **and** the token is the owner's: an admin or a member never
connects. A session belongs to the owner, not to the socket: a dropped or reloaded page
attaches again (`GET /terminal` lists what is live) until the session sits idle past the
hub's timeout. Output reaches only the sockets attached to that session. Every start and
end is in the audit log.

### Resuming a session (`after_seq`)

A phone that loses signal mid-run must not lose the part of the answer that
arrived while it was away. `subscribe` therefore takes the `seq` of the last
envelope the client processed:

```json
{ "session_id": "01J8QK3ZR2W7M5N4P6T8V9X0YA", "after_seq": 8812 }
```

The ack is `{ ok: true, replayed, truncated }`:

- the server re-sends, on that socket and in their original order, every
  envelope of that session with `seq > after_seq` — the same envelopes,
  unchanged, not a summary;
- `replayed` is how many were re-sent;
- `truncated: true` means the replay may be incomplete (the server's buffer
  no longer reaches back that far, or it restarted). The client then
  resynchronises the documented way — `GET /sessions/{id}` and
  `GET /sessions/{id}/messages` — exactly as in §Reconnection below.

Omitting `after_seq` (or sending `0`) is a fresh subscription: nothing is
replayed and `truncated` is `false`. The buffer is in memory and bounded, so
`truncated` is the normal answer for a session that has been idle for a long
time; it is never wrong, only sometimes conservative. Deltas themselves are
still never persisted.

Sending messages, answering approvals, stopping runs and every other mutation
goes over HTTP (`POST /sessions/{id}/runs`, `POST /approvals/{id}/respond`,
`POST …/cancel`), never over the socket. This keeps one path per action,
idempotency keys, and the same error envelope everywhere. The one exception is
`typing`, which is ephemeral.

Reconnection: the client reconnects with backoff (cap 30 s), re-subscribes,
then reads `GET /jobs?status=running`, `GET /sessions/{id}` (or the room /
tasks / workflow-run document) to resynchronise. Streaming deltas missed while
offline are covered by the terminal `run.completed`, which carries the final
message.

## Catalogue


### `/rt/sessions` — 21 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `session.created` | sessions module (create, fork; tasks/schedules/rooms when they open a session) | `session`: `Session` | A session appeared in the workspace. Profile-wide — no subscription needed. |
| `session.updated` | sessions module (patch, bulk patch, title generation, model change, status change) | `session`: `Session` | Any field of a session changed (title, pinned, archived, category, model, status, usage). Profile-wide. |
| `session.deleted` | sessions module | `session_id`: `Ulid` | A session was deleted. Profile-wide. |
| `message.created` | sessions module (user message stored; assistant message shell when a run starts; peer clients in the same session) | `message`: `Message` | A complete message (user, command, system) or the empty shell of a streaming assistant message. Subscribers of the session. |
| `message.delta` | sessions module from the AgentAdapter stream | `session_id`: `Ulid`, `message_id`: `Ulid`, `run_id`: `Ulid`, `delta`: `string` | Append `delta` to the assistant message text. Append-only; the terminal `run.completed` carries the full message. |
| `reasoning.delta` | sessions module from the AgentAdapter stream | `session_id`: `Ulid`, `message_id`: `Ulid`, `run_id`: `Ulid`, `delta`: `string` | Append `delta` to the reasoning block of the assistant message. |
| `tool.started` | sessions module from the AgentAdapter stream | `session_id`: `Ulid`, `message_id`: `Ulid`, `run_id`: `Ulid`, `tool_call`: `ToolCall` | A tool call began; add it to the message. |
| `tool.completed` | sessions module from the AgentAdapter stream | `session_id`: `Ulid`, `message_id`: `Ulid`, `run_id`: `Ulid`, `tool_call`: `ToolCall` | A tool call finished; `tool_call.output` is filled. |
| `tool.failed` | sessions module from the AgentAdapter stream | `session_id`: `Ulid`, `message_id`: `Ulid`, `run_id`: `Ulid`, `tool_call`: `ToolCall` | A tool call failed; `tool_call.output` holds the error text. |
| `run.queued` | sessions module (job runner) | `run`: `Run` | A run was queued behind an active one. Subscribers of the session; also profile-wide on /rt/jobs as `job.*`. |
| `run.started` | sessions module (job runner) | `run`: `Run` | A run began; the assistant message shell exists. Subscribers of the session; also profile-wide on /rt/jobs as `job.*`. |
| `run.completed` | sessions module (job runner) | `run`: `Run`, `message`: `Message` | A run finished; `message` is the final assistant message and `run.usage` the cost. Subscribers of the session; also profile-wide on /rt/jobs as `job.*`. |
| `run.failed` | sessions module (job runner) | `run`: `Run` | A run failed; `run.error` says why. Subscribers of the session; also profile-wide on /rt/jobs as `job.*`. |
| `run.cancelled` | sessions module (job runner) | `run`: `Run` | A run was cancelled by a person, a delete, or a restart. Subscribers of the session; also profile-wide on /rt/jobs as `job.*`. |
| `approval.requested` | sessions module when an adapter asks for a decision; schedules module for workflow-step gates | `approval`: `Approval` | The agent is blocked on a decision. Profile-wide so the pending-actions bar can show it anywhere. |
| `approval.resolved` | sessions module | `approval`: `Approval` | A decision was recorded (by any client) or the approval expired. Profile-wide. |
| `context.updated` | sessions module after each run and after compression | `session_id`: `Ulid`, `context`: `ContextUsage`, `usage`: `Usage | null` | The context-window usage of a session changed. |
| `subagent.started` | sessions module from the agent's delegation reports | `subagent`: `Subagent` | A delegated subagent began (DECISIONS §56). Profile-wide, so the Background panel hears it anywhere. |
| `subagent.updated` | sessions module from the agent's delegation reports | `subagent`: `Subagent` | A running subagent called a tool or stopped taking guidance; `subagent` is its whole state. Profile-wide. |
| `subagent.completed` | sessions module from the agent's delegation reports, `sessions.interruptSubagent`, `background.stop` | `subagent`: `Subagent` | A subagent ended: `completed`, `failed` or `interrupted`. Profile-wide. |
| `context.compression` | sessions module: `sessions.compress`, or the agent compressing on its own during a run | `session_id`: `Ulid`, `run_id`: `Ulid | null`, `phase`: `started` / `finished` / `failed`, `trigger`: `manual` / `auto`, `before_tokens`, `after_tokens`: `integer | null`, `message`: `string | null` | The agent is compressing (or finished compressing) the conversation's context; `context.updated` follows with the new window (decision §57). |

### `/rt/rooms` — 25 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `room.created` | rooms module | `room`: `Room` | A room was created or cloned. Profile-wide. |
| `room.updated` | rooms module (patch, invite rotation, token count changes) | `room`: `Room` | Room fields changed. Members of the room. |
| `room.deleted` | rooms module | `room_id`: `Ulid` | The room is gone. Members. |
| `room.cleared` | rooms module | `room_id`: `Ulid`, `total_tokens`: `integer` | Context was cleared: drop the transcript, the queue and activity; `total_tokens` resets. |
| `member.joined` | rooms module | `room_id`: `Ulid`, `member`: `Member` | A person joined. Members. |
| `member.left` | rooms module | `room_id`: `Ulid`, `member`: `Member` | A person left or was removed. A client whose own `member.user_id` matches shows the "removed from room" banner. |
| `member.typing` | rooms module from the `typing` command | `room_id`: `Ulid`, `member_id`: `Ulid`, `name`: `string`, `typing`: `boolean` | A person started or stopped typing. Not persisted. |
| `seat.added` | rooms module | `room_id`: `Ulid`, `seat`: `Seat` | A seat was added. Members. |
| `seat.updated` | rooms module | `room_id`: `Ulid`, `seat`: `Seat` | A seat changed — including its `status` (idle, queued, thinking, running, waiting_approval), which drives the activity strip. Members. |
| `seat.removed` | rooms module | `room_id`: `Ulid`, `seat`: `Seat` | A seat was removed; its past messages stay. Members. |
| `message.created` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `message.delta` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `reasoning.delta` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `tool.started` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `tool.completed` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `tool.failed` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `run.queued` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `run.started` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `run.completed` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `run.failed` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `run.cancelled` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `approval.requested` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `approval.resolved` | sessions module, re-emitted to the room | same as `/rt/sessions` | Same payload as `/rt/sessions`; `message.room_id` / `run.room_id` and `seat_id` are set. Members of the room receive it without subscribing to seat sessions. |
| `handoff.updated` | rooms module | `room_id`: `Ulid`, `chain`: `HandoffChain` | A handoff chain advanced, stopped or completed. Members. |
| `memory.updated` | rooms module (summarizer job, manual edit) | `room_id`: `Ulid`, `memory`: `RoomMemory` | The rolling summary changed. Members. |

### `/rt/tasks` — 12 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `project.created` | tasks module | `project`: `Project` | Profile-wide. |
| `project.updated` | tasks module (patch, count changes) | `project`: `Project` | Profile-wide. |
| `project.deleted` | tasks module | `project_id`: `Ulid` | Profile-wide. |
| `task.created` | tasks module | `task`: `Task` | Subscribers of the project (or profile-wide when subscribed without a project). |
| `task.updated` | tasks module (patch, bulk patch, summary from the assignee, dependency change) | `task`: `Task` | Any non-status field changed. |
| `task.moved` | tasks module (move, assign/stop/unassign side effects, dispatch, bulk archive) | `task`: `Task`, `from`: `TaskStatus`, `to`: `TaskStatus`, `actor`: `Author` | The task changed column; `task.status` is the new one. |
| `task.deleted` | tasks module | `task_id`: `Ulid`, `project_id`: `Ulid` |  |
| `task.assigned` | tasks module (assign, dispatch) | `task`: `Task` | `task.assignee` is set; a run may follow (`run.queued` on /rt/sessions). |
| `task.unassigned` | tasks module | `task`: `Task` | `task.assignee` is null. |
| `subtask.updated` | tasks module (create, patch, delete, assignee progress) | `task_id`: `Ulid`, `subtask`: `Subtask`, `deleted`: `boolean` | A subtask was created, changed or deleted (`deleted: true`). |
| `comment.created` | tasks module (people and agents) | `comment`: `Comment` |  |
| `worktree.updated` | tasks module (worktree jobs, git status polling while a run is active) | `task_id`: `Ulid`, `worktree`: `Worktree | null` |  |

### `/rt/schedules` — 18 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `schedule.created` | schedules module | `schedule`: `Schedule` | Profile-wide. |
| `schedule.updated` | schedules module (patch, state changes, next_run_at recomputed, repeat exhausted) | `schedule`: `Schedule` | Profile-wide. |
| `schedule.deleted` | schedules module | `schedule_id`: `Ulid` | Profile-wide. |
| `schedule.fired` | schedules module (timer or run-now) | `schedule`: `Schedule`, `schedule_run_id`: `Ulid` | A schedule fired; `schedule_run_id` identifies the history entry. |
| `schedule_run.started` | schedules module (job runner) | `schedule_run`: `ScheduleRun` | History entry state. Profile-wide. |
| `schedule_run.completed` | schedules module (job runner) | `schedule_run`: `ScheduleRun` | History entry state. Profile-wide. |
| `schedule_run.failed` | schedules module (job runner) | `schedule_run`: `ScheduleRun` | History entry state. Profile-wide. |
| `workflow.created` | schedules module | `workflow`: `Workflow` | Profile-wide. |
| `workflow.updated` | schedules module (patch, status, run counts) | `workflow`: `Workflow` | Profile-wide; `workflow.status` and `active_run_id` are the live status badge. |
| `workflow.deleted` | schedules module | `workflow_id`: `Ulid` | Profile-wide. |
| `workflow_run.started` | schedules module (workflow engine) | `workflow_run`: `WorkflowRun` | Run-level state with all steps. Subscribers of the workflow; profile-wide as `job.*` on /rt/jobs. |
| `workflow_run.completed` | schedules module (workflow engine) | `workflow_run`: `WorkflowRun` | Run-level state with all steps. Subscribers of the workflow; profile-wide as `job.*` on /rt/jobs. |
| `workflow_run.failed` | schedules module (workflow engine) | `workflow_run`: `WorkflowRun` | Run-level state with all steps. Subscribers of the workflow; profile-wide as `job.*` on /rt/jobs. |
| `workflow_run.cancelled` | schedules module (workflow engine) | `workflow_run`: `WorkflowRun` | Run-level state with all steps. Subscribers of the workflow; profile-wide as `job.*` on /rt/jobs. |
| `step.started` | schedules module (workflow engine) | `workflow_run_id`: `Ulid`, `workflow_id`: `Ulid`, `step`: `WorkflowStep` | A node began. |
| `step.completed` | schedules module (workflow engine) | `workflow_run_id`: `Ulid`, `workflow_id`: `Ulid`, `step`: `WorkflowStep` | A node finished; read its output from `step.session_id`. |
| `step.failed` | schedules module (workflow engine) | `workflow_run_id`: `Ulid`, `workflow_id`: `Ulid`, `step`: `WorkflowStep` | A node failed or was cancelled/rejected. |
| `step.waiting` | schedules module (workflow engine) | `workflow_run_id`: `Ulid`, `workflow_id`: `Ulid`, `step`: `WorkflowStep` | A node waits for an approval; `step.approval_id` resolves through `/approvals/{id}/respond`. |

### `/rt/devices` — 10 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `device.linked` | auth module (pairing claim) | `device`: `Device` | A device of the user was linked. User-level (`profile: null`). |
| `device.updated` | devices module (rename, capabilities, push registration, token renewal, a push registration the hub dropped: its sign-in ended or the token is dead) | `device`: `Device` | User-level. |
| `device.unlinked` | devices/auth modules (unlink, token revoked, user deleted) | `device_id`: `Ulid` | User-level. |
| `device.online` | socket layer when the device connects to /rt/devices | `device`: `Device` | User-level. |
| `device.offline` | socket layer when the last socket of the device drops | `device`: `Device` | User-level. |
| `pairing.claimed` | auth module | `pairing`: `Pairing`, `device`: `Device` | The QR the web showed was claimed; the web closes the dialog. User-level, to the client that created the pairing. |
| `request.created` | devices module (an agent asked for a capability) | `request`: `DeviceRequest` | Delivered only to the addressed device. The device shows consent UI and answers through `POST /device-requests/{id}/respond`. |
| `request.completed` | devices module | `request`: `DeviceRequest` | The request was answered, expired or cancelled. To the device and to the session owner. |
| `notice.created` | notify module | `notice`: `Notice`, `unread_count`: `integer` | A new in-app notice for the user (every device of the user; push mirrors it when enabled). User-level. |
| `notice.updated` | notify module (read/unread, mark-all) | `notice`: `Notice`, `unread_count`: `integer` | Read state changed on another client. User-level. |

### `/rt/jobs` — 7 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `job.queued` | the jobs kernel module, for every job of the workspace | `job`: `Job` | A job was accepted. Profile-wide. |
| `job.started` | the jobs kernel module, for every job of the workspace | `job`: `Job` | A job began. Profile-wide. |
| `job.progress` | the jobs kernel module, for every job of the workspace | `job`: `Job` | Progress changed; `job.progress.message` is displayable. Profile-wide. |
| `job.completed` | the jobs kernel module, for every job of the workspace | `job`: `Job` | The job succeeded; `job.result` is the outcome. Profile-wide. |
| `job.failed` | the jobs kernel module, for every job of the workspace | `job`: `Job` | The job failed; `job.error` is the error envelope. Profile-wide. |
| `job.cancelled` | the jobs kernel module, for every job of the workspace | `job`: `Job` | The job was cancelled. Profile-wide. |
| `agent.updated` | agents module (install/update/uninstall/restart jobs, discovery, settings, skills/MCP/memory/channel changes) | `agent`: `Agent` | The registry entry of an agent changed. Carried on /rt/jobs because it is always the outcome of hub-level work. Profile-wide. |


### `/rt/terminal` — 2 events

| Event | Emitted by | Payload | Notes |
|---|---|---|---|
| `terminal.output` | terminal module | `terminal_id`: `Ulid`, `data`: `string` | What the shell wrote, escape sequences included. Only to the sockets attached to the session; `profile` is the session's. |
| `terminal.exited` | terminal module | `terminal_id`: `Ulid`, `reason`: `exited`\|`closed`\|`idle`\|`shutdown`, `exit_code`: `integer`\|`null` | The session ended. To the sockets attached to it. |


## Rules

- Names are `<entity>.<verb>`; a changed payload is a new name, never a
  changed meaning. Additive fields are allowed.
- `message.delta` / `reasoning.delta` are append-only text; `tool.*` carry the
  whole `ToolCall`; `run.completed` carries the final `Message`.
- Room sockets receive the session events of every seat's session (same
  payload, `room_id` set) so a room client never subscribes to seat sessions.
- `/rt/jobs` is the profile-wide "is it done" channel: every `202` in the
  HTTP contract ends in a `job.completed` / `job.failed` there, and registry
  changes arrive as `agent.updated`.
- Events with no HTTP trigger (`device.online`, `device.offline`,
  `member.typing`, and the timer-driven `schedule_run.*`) are emitted by the
  socket layer or the scheduler and are still declared here.
- Push notifications mirror `notice.created`; the phone opens
  `notice.resource`.
