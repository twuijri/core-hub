# Contract decisions

Why the resources in `packages/contracts/openapi.yaml` have the shapes they
have. Each decision names the alternative it rejected and the client evidence
behind it (from our own MIT phone clients, read as an inventory of needs — no
Studio source was consulted, ADR 0004). A decision here is superseded only by
a new numbered entry, not by editing an old one.

## 1. One `Message` schema for sessions and rooms

A room message and a chat message are the same thing with two extra nullable
fields (`room_id`, `seat_id`), structured `mentions` and an optional
`handoff`. Both clients already render the two with one row component and
fold tool rows into an assistant reply by `(author, run_id)`. Two schemas
would have meant two renderers, two paging codepaths and two streaming
reducers for the same pixels.

Consequences: there is no `tool` role — tool output lives in
`Message.tool_calls[]` (each with `output`, `status`, `duration_ms`), so a
reply is one row with one run card. `role: command` marks a user message that
starts with `/` so clients can draw it differently without parsing text.
`run_id` is stable across the user message, the assistant reply and its tool
calls. Rooms simply re-emit the session events of each seat's session on
`/rt/rooms` with `room_id` set.

## 2. Agent runs are jobs, and every run lives in a session

A run (`Run`) is one agent turn. It is created by exactly one module —
`sessions` — and always belongs to a session. Rooms, the board, schedules and
workflows do not run agents themselves: a room seat has a session per seat, a
task has a task session (`source: task`), a schedule opens a session per
firing, a workflow step opens a session per node. Each run is also a `Job`
(`kind: run`, `resource: { kind: run }`), so `/rt/jobs` is the one place a
client watches for "is it done" and `202 { job_id, run_id }` is the one shape
for "start something" (ARCHITECTURE invariant 4).

Rejected: a per-module "execution" model (room activities, kanban runs,
workflow node sessions as three different things). The clients today merge
three different status vocabularies (`queued|thinking|running|replying`,
`in_progress|pending|succeeded|success|done|…`, `running|paused|scheduled`)
into one colour; the contract gives them one `RunStatus`
(`queued|running|waiting|succeeded|failed|cancelled`) instead.

Queueing is a property of the run: `RunCreate.when` is `queue`, `next` or
`interrupt`, `Run.queue_position` shows the order, and cancelling a queued run
removes it. Reconnection reads `GET /sessions/{id}`, which returns the runs
and pending approvals — replacing the "replay-log inside a snapshot" the
clients had to re-dispatch.

## 3. One `Approval` resource for tool approvals, questions, plans, memory/skill writes and workflow gates

Every "the agent is waiting for a person" case is an `Approval` with a `kind`
(`tool_call | memory_write | skill_write | question | plan | workflow_step`),
`choices[]`, `allow_always`, `answer_mode` (`choice | text | both`) and one
verb: `POST /approvals/{id}/respond { decision?, answer? }`. It is resolved
the same way from a chat, a room, the pending-actions bar or a workflow-run
timeline, and it is profile-wide on the socket (`approval.requested`) so a
person who scrolled away still sees it. `decision` is a fixed enum
(`approve_once | approve_session | approve_always | deny`) — clients no longer
synthesise "once/session/always" from an empty list or invent a "reject"
button.

Rejected: separate `approval` and `clarify` events with separate `respond`
emits over the socket (two payload shapes, three id spellings), and
write-gate records living under skills only.

## 4. Workspace scope is the `X-Hub-Profile` header carrying the slug

ADR 0005 makes the profile an ambient filter. The header carries the profile
*slug*, not its id, because people type it in curl and read it in logs, and
because switching workspace must not require a lookup. There is no `?profile=`
query form (the clients today send both, sometimes with different values).
Global operations (`auth`, `updates`, `devices`, `notify`, `meta`, stubs) are
marked `x-scope: global` and ignore the header.

## 5. The server mints every id; there are no client-side drafts

Both phones invent a session UUID for "New chat" and then suppress every call
until the first run is accepted, because the server had never heard of the id.
Here `POST /sessions` returns a real session immediately (a session with zero
messages is still a session), so every later call has a valid id and the
"session not found on reconnect" class of bugs disappears. All ids are ULIDs:
sortable by creation time, URL-safe, no coordination.

`Idempotency-Key` (a client ULID) makes retries of `POST …/runs`,
`POST /rooms/{id}/messages`, `POST /tasks` and `POST /workflows/{id}/run` safe
on flaky mobile networks.

## 6. History pages backwards by id; lists page by opaque cursor; no offsets

Message history is `?before=<message_id>&limit=` returning chronological
items plus `has_more` — the newest page on the first call, which removes the
"probe with limit=1 to learn total, then fetch the last offset page" round trip
the clients perform today. Every other list is `cursor` + `limit` with
`{ items, next_cursor }`; totals are explicit fields only where a screen shows
one (`unread_count`, board `counts`).

## 7. Bulk operations act on the collection, never on a literal sibling of `{id}`

`PATCH /sessions { session_ids, patch }`, `DELETE /sessions?ids=`,
`PATCH /tasks`, `DELETE /tasks?ids=` and per-item `BulkResult` (partial success
is still `200`). Paths like `/sessions/batch-archive` or `/rooms/join` beside
`/sessions/{id}` and `/rooms/{id}` are ambiguous for routers and generators
(`redocly` flags them), so joining is `POST /room-invites/{code}/join`,
discovery is `POST /agent-discoveries`, delivery targets are
`/delivery-targets`, device capability requests are `/device-requests`.

## 8. Kanban: nine columns and a server-enforced transition table

Statuses, in workflow order: `triage → todo → ready → scheduled → running →
blocked → review → done → archived` (the board the phones already draw, with
`running` instead of the web's `in_progress`). `POST /tasks/{id}/move` is the
only way to change `status`; an illegal move is `409 state_invalid` with
`details.allowed[]`, so the drop rules live in one place:

| from ＼ to | todo | ready | scheduled | running | blocked | review | done | archived |
|---|---|---|---|---|---|---|---|---|
| triage | ✓ specify | ✓ | | | | | | |
| todo | | ✓ promote | ✓ | | | | | |
| ready | ✓ | | ✓ | server only | ✓ reason | ✓ | ✓ | |
| scheduled | ✓ | ✓ unblock | | server only | | | | |
| running | | ✓ stop | | | ✓ reason | ✓ | ✓ | |
| blocked | ✓ unblock | ✓ unblock | ✓ | | | | ✓ | |
| review | ✓ reopen | ✓ reopen | | server only (rework) | | | ✓ | |
| done | | | | | | ✓ reopen | | ✓ |
| archived | | | | | | | ✓ restore | |

Nothing moves *into* `triage`; `running` is entered only by `assign` /
`dispatch` / `stop`'s inverse, never by a drag. `blocked` requires `reason`;
`archived` is reachable only from `done` (bulk `archived: true` is sugar for
that move). Column order inside a status is server-owned (`position`, a
fractional index set by `after_task_id`), replacing the per-device layout the
phones keep in local preferences. `GET /board` returns columns, ordered tasks
and counts in one call because the kanban screen is one fetch.

Assignment (`POST /tasks/{id}/assign { agent_id, start }`) is where Vibe
Kanban's idea lands: a worktree per task, a task session, a run, and progress
reported into the project's `report_room_id`. The task carries `worktree`,
`session_id`, `last_run`, `latest_summary` so the card needs no second call.

## 9. One `Schedule` resource for Hermes cron jobs and workflow schedules

The clients had two schedulers: Hermes "jobs" (cron/interval/once, prompt,
skills, delivery target, repeat count) and workflow schedules (cron only,
`input`). Here `Schedule` has a `trigger` (`cron | interval | once`, with a
server-rendered localized `display`), a `target` (`agent_prompt` or
`workflow`), a `delivery` (`none | notice | room | channel`) and `repeat`.
The agent's Jobs screen lists `?agent_id=`, the workflow's Schedules tab lists
`?workflow_id=`. Run history is `ScheduleRun` with machine fields
(`status`, `output_size_bytes`, `delivery_status`, ISO timestamps) instead of
file names and pre-formatted strings.

## 10. A workflow step's output is a session

`WorkflowStep.session_id` points at the session the node's agent worked in;
"show output" is `GET /sessions/{id}/messages`. There is no second transcript
format, and approvals inside a run are ordinary `Approval`s of
`kind: workflow_step` surfaced as `step.waiting`. Import is a two-step
preview/confirm (`/workflow-imports`) because the phones already do that and
because an import can reference agents that are not installed.

## 11. The agent registry is data, visible to every signed-in user

`GET /agents` is readable by every user and returns everything a client needs
to draw the manager and the "under the agent" menu: `kind` (which adapter),
`install` (source, versions, auto-update), `runtime` (state), `capabilities`,
and `sections` — the ordered rows of NAVIGATION §4 — so the client no longer
hard-codes a catalogue, npm package names, or which agent has Presets. Agent
runtime settings are schema-driven (`GET /agents/{id}/settings` returns
sections with typed fields and choices), which also serves the enumerations the
two phones currently disagree on (tool enforcement, approvals mode). Install /
update / uninstall / restart are jobs; a failed install is `job.failed`,
never a `200` with `success: false`.

## 12. One memory model for two runtimes

Hermes exposes three Markdown documents; Ekko exposes entries with revisions.
`MemoryItem { id, kind: document | entry, title, content, tags, revision }`
covers both; the document ids are the fixed keys `memory`, `user`, `soul`.
`PUT` with the `revision` you read gives Ekko's optimistic concurrency to
everything, and a `202 { approval_id }` answer covers Hermes's write approval.

## 13. Channels, webhook events, providers and choices are served, not hard-coded

`GET /agents/{id}/channels` returns each platform with its field list (key,
kind, target, masked value); `GET /notify/webhook-events`,
`GET /models/getDefaults.auxiliary.tasks`, `GET /models/speech` and
`SettingsField.options` do the same for the other lists the phones carry as
tables today. Adding a platform or a provider is a server change only.

## 14. Devices: a stable key, a capability handshake, requests as jobs, fixed error codes

Pairing sends `device_key` (generated once by the device) so re-pairing updates
the same row; the claim also declares `capabilities`, so the server never asks
a phone for a calendar it cannot serve. An agent asking a device for something
is a `DeviceRequest` (a job): `request.created` reaches only the addressed
device on `/rt/devices`, the device answers `POST /device-requests/{id}/respond`
with a `result` or a `DeviceRequestError.code` from one list
(`permission_denied | unavailable | timeout | cancelled | failed`) — the two
platforms currently send different strings. Location results are
`{ latitude, longitude, accuracy_m, captured_at }`, one shape, ISO time.

Push has a real surface (`PUT /devices/{id}/push`); notices are the unit of
push, and `notice.resource` says what to open.

## 15. Pairing QR is JSON with a fixed `type`

`{ "type": "corehub.pairing", "hub_url", "pairing_id", "code", "expires_at" }`.
The phone validates `type`, refuses expired codes, and claims with
`POST /auth/pairings/{id}/claim`. The claim returns the app token, the device,
the user and `Meta` (contract version) in one response; the web receives
`pairing.claimed`. Errors are distinct codes (`401` wrong code, `409` claimed,
`404` expired, `403` disabled user) so the phone can word each.

## 16. Attachments are a `sessions` resource with a `purpose`

Phase 4's `knowledge` will own files; until then attachments must exist for
messages, avatars, task files, skill imports, backgrounds, profile archives and
client releases. They live under `sessions` with `purpose` and are referenced
by id from content blocks, tasks, skills, appearance and releases. Two upload
paths: single multipart (≤ 25 MB) and resumable chunks (≤ 50 MB, 256 KiB
chunks, `next_offset` to resume) — the phones already implement the second.
Bytes are fetched with the bearer header and `Range`; a token never goes in a
URL (today the profile export and workflow export leak one).

## 17. Secrets read as `[stored]`

Provider keys, channel credentials, MCP headers, webhook secrets, the update
source token: writable, never readable. The schema type is
`enum: ['[stored]', null]` so a generated client cannot even model the value.
`""` clears a value without wiping its siblings.

## 18. Speech belongs to `models`

STT/TTS providers are providers (`kind: stt | tts`); `GET /models/speech`
answers the phone's "is server dictation possible" question with `ready` +
`reason`, and synthesis returns bytes with `X-Speech-Provider` so a client can
tell when the fallback voice spoke. The user's *choice* of device vs server
voice is a preference (§21), not a provider setting.

## 19. A `jobs` kernel module, and `agent.updated` on `/rt/jobs`

ARCHITECTURE lists `/rt/jobs` and says long work is a job, but no module in
the table owns jobs. The contract assumes a small kernel module
`packages/server/src/modules/jobs` (registry, progress, cancellation) that
every other module composes, and puts registry changes (`agent.updated`) on the
same namespace because they are always the outcome of hub-level work. This
should be reflected in ARCHITECTURE §Modules when the skeleton lands.

## 20. Phase 4 stubs have real shapes

`knowledge.listItems`, `audit.getReport` and `plugins.list` answer
`501 not_implemented` until Phase 4 but are fully typed, so the Logs / Usage /
Performance / Skills Usage screens have a declared source today and generated
clients do not change shape later. `audit.getReport` is one operation with
`kind` so the stub stays at one endpoint.

## 21. Three owners of settings, three resources

NAVIGATION's rule: human settings → Settings; agent runtime settings → under
the agent; providers and voice → Models. The contract mirrors it: `Preferences`
(per user, global: theme, locale, text scale, display flags, voice modes,
default reasoning effort), `ProfileSettings` (per workspace: proxy,
compression, privacy, appearance/theme), `AgentSettings` (per agent, schema
driven). Nothing is duplicated across the three.

## 22. One timestamp format, one number type

ISO-8601 UTC strings everywhere (the clients today parse seconds,
milliseconds and ISO, with a `1e11` heuristic). Money is a decimal string with
a currency; sizes are `*_bytes`; durations are `*_ms`. Pre-formatted display
strings are not returned by the server.

## 23. Rooms: structured mentions, unique seat names, one join URL

`mentions[]` is sent by the client and honoured by the server; the server does
not parse `@name` out of text (the two phones currently have to replicate a
word-boundary regex and mask quoted blocks). Seat names are unique per room and
`all` is reserved. The public join link is `<hub_url>/join/<code>`, one route
for web and phones (they build two different URLs today). The room detail is
one document with everything the transcript header, panels and settings sheet
need.

## 24. No `200` with `success: false`

An operation either succeeds with its documented shape or fails with the error
envelope. Outcomes that are legitimately "the remote thing said no" (MCP test,
provider test) are `200` with an explicit `ok: boolean` in a dedicated schema,
never a generic `success` flag on a resource.
