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

`{ "type": "majlis.pairing", "hub_url", "pairing_id", "code", "expires_at" }`.
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

## 25. The section is `tasks`, never `board` or `kanban`

Owner decision (2026-09-21): the section that holds projects and their task
cards is named **Tasks** in English and **«المهام»** in Arabic, everywhere —
navigation, contract, server module, database. "Kanban" and "Board" are
descriptions of its shape, never its name; a first mention may read "Tasks (a
kanban-style board)". The model words stay: a task sits in a **column**, is
drawn as a **card**, and swimlanes remain swimlanes.

The rename is breaking and happened pre-1.0, before any client or deployment
existed, so it is applied in place rather than versioned to `/api/v2` (§ADR
0003 forbids incompatible changes to a *published* `/api/v1`; nothing was
published). Entries 2, 6 and 8 above were written with the old names — read
them through this table:

| Old | New |
|---|---|
| tag `board` | tag `tasks` |
| `board.*` operation ids | `tasks.*` |
| `GET /board` | `GET /task-columns` (`tasks.getColumns`) |
| `POST /board/dispatch` | `POST /task-dispatches` (`tasks.dispatch`) |
| schema `Board` | schema `TaskColumns` |
| `AgentCapability` / `AgentSection` value `kanban` | `tasks` |
| `events/board/` | `events/tasks/` |
| namespace `/rt/board` | `/rt/tasks` |

`/board` did not become `/tasks`: that path already lists tasks. It did not
become `/tasks/columns` or `/tasks/dispatch` either, because a literal
sibling of `/tasks/{task_id}` is exactly what §7 rejects and what redocly's
`no-ambiguous-paths` fails on. The house pattern for these
(`/room-invites`, `/agent-discoveries`, `/delivery-targets`) is a hyphenated
top-level collection, so `/task-columns` and `/task-dispatches` it is.

Event names did not change (`task.moved`, `project.created`, …): they are
`<entity>.<verb>` and never named the section.

## 26. First run is a claim token, not open onboarding

`GET /auth/setup` answers `{ required }` and nothing else; `POST /auth/setup` takes a token
plus the owner's username and password and answers the same `TokenPair` `auth.login` answers,
so the browser that completed setup is signed in without a second round trip.

Rejected: **open onboarding** — "no user exists, so let whoever loads the page create the
owner". Every hub we deploy sits on a public domain behind a reverse proxy; open onboarding
means the first stranger who loads the URL owns the instance, and the owner cannot tell it
happened. The claim token is the model Jenkins uses (`initialAdminPassword`): the hub writes a
random token to `<DATA_DIR>/setup-token.txt` (0600) and logs it once, so proving you are the
person who can read the server's disk or log is the authentication. It costs the operator one
`docker compose logs` and nothing else.

Rejected: **putting the token in the `GET`** (as a boolean "a token file exists", or worse the
token itself). The `GET` is unauthenticated, so anything in it is public. `required` is the
only bit a client needs to decide which screen to show.

Rejected: **a second rate-limit mechanism** for setup attempts. Wrong tokens count on the same
per-IP `login_lockout` row as wrong passwords (`kind: password`): five failures in fifteen
minutes lock the IP for fifteen minutes, and the lock is visible in `auth.listLockouts` like
any other. One mechanism, one admin screen.

Once an owner exists the operation is `409 conflict`, checked before the token is looked at, so
a replayed token cannot even be distinguished from a random one by its answer. `TokenPair`
rather than `204` was chosen because the alternative — setup then sign in — asks a person to
type the password twice into two screens for no gain.

`HUB_ADMIN_PASSWORD` keeps working and simply skips all of this: with it set, the owner exists
at the end of first boot, `auth.getSetup` answers `false`, and no token file is ever written
(ADR 0011).

## 27. A provider row is something you added; the catalogue is a separate list of presets

Owner decision (2026-09-22): the Models screen shows **only the providers he
configured**, plus one "Add provider" button. The old shape — one card per
bundled provider, each with its own key box — was the whole screen, and he
found it scattered.

So the two lists are split in the contract:

| Question | Operation |
|---|---|
| What have I configured? | `models.listProviders` — a fresh workspace answers `{ items: [] }` |
| What can I add? | `models.listProviderPresets` — the bundled catalogue of provider *types* |

`ProviderCreate.preset` names a preset; the hub then takes the slug, protocol,
credential family and default base URL from the catalogue and only what the
person typed from the body, and creates the sibling rows of the same family in
the same call (OpenAI chat + dictation + speech are three rows and one key,
ADR 0010 §2). Without `preset` the body still describes a bare
OpenAI-compatible endpoint, exactly as before, so no existing caller changed.
`models.deleteProvider` now removes any provider the workspace added, preset or
not: what a person added, a person removes. Nothing is hidden by this — a
provider the hub supports but you have not added is in the preset list, which
is where "visible and unconfigured" now lives (ADR 0006's rule still holds; the
list it applies to moved).

`models.probeProvider` (`POST /models/provider-probes`) is the dialog's
**Fetch** button: the model list of an endpoint that has not been saved yet, so
a default model can be chosen in the same dialog that types the URL. It stores
nothing, and a provider that cannot be reached is `ok: false` carrying the
endpoint's own words — §24's rule, and never an empty list drawn as success.

`ProviderPreset.key` is `required | optional`. There is deliberately **no**
value meaning "a key is refused": a local endpoint (LM Studio, LiteLLM,
`cli-proxy-api`, vLLM) is routinely put behind a master key, and the owner hit
exactly that wall — a card badged "No key needed" that also showed "Missing API
key", with no field to type one into. `Provider.auth.kind: none` therefore
means *no key is required*, clients always offer the field, and the only thing
allowed to say a key is missing is the endpoint's own 401.

`ProviderPreset.local` and the response's `host { containerized,
loopback_alias }` exist for the same deployment: the hub runs in a container,
so `127.0.0.1` in a base URL is the container, not the person's machine. The
hub reports the fact; the client warns and suggests `host.docker.internal`.
Rewriting the URL silently was rejected — a hub that edits what you typed is a
hub you cannot debug.

## 26. Changing a conversation's agent is a fork; changing its model is a patch

Owner direction, 2026-09-22. Mid-conversation, "talk to a different agent" and
"run on a different model" look like the same gesture and are not the same act.

A model is a setting of the running conversation: the same agent, the same
tools, the same memory, a different engine behind the next turn. It stays
`PATCH /sessions/{id}` (`SessionPatch.model`, `provider`) and the transcript is
untouched.

An agent is *who* the conversation is with. Its tools, its permissions, its
notion of a session and its side of the transcript all change. Rewriting
`Session.agent_id` in place would leave a transcript half of which was produced
by an agent the row no longer names, and would abandon the first agent's live
session with no way back. So it forks: `POST /sessions/{id}/fork` gained
optional `agent_id`, `model` and `provider`. The fork copies the messages, sets
the agent, starts **no** run, and points `parent_session_id` at the original,
which is left exactly as it was — the person can go back to it.

The refusals are explicit rather than silent: an unknown `agent_id` is `404
not_found`, and an agent the hub has not installed is `422 agent_unavailable`
with the agent id and its status in `details`. A fork with no `agent_id` is the
fork that existed before this entry, unchanged.

Rejected: a dedicated `POST /sessions/{id}/handoff`. It would be `fork` with one
more field and a second copy of the copy-the-transcript rule, and §7's shape
rules do not want a second verb under `/sessions/{id}` for an act the existing
one already performs.

### The hub names a session, unless a person did

`Session.title` stays `null` until something names it, and "New chat" in a
sidebar of twenty rows is a list with no information in it. After the first
assistant reply of a session completes, the hub asks the session's *own* agent
for a short title in the conversation's language, through a separate one-shot
call that is not a run: no `Run` row, no job, no `/rt/sessions` run events, and
a failure costs the caller nothing. The fallback, whenever that call is refused
or unsupported by the adapter, is the first user message trimmed on a word
boundary.

No field was added for it. A person's own title is one they sent in
`SessionPatch.title`, so the hub marks the row when the patch carries a
non-empty string and never overwrites it afterwards; `title: null` hands the
naming back and the hub names it again, emitting `session.updated` on
`/rt/sessions`. Rejected: a `title_source` enum on `Session`. Every client would
have to render a state nobody displays, and the one question a client actually
asks — "may I ask for a new title?" — is answered by sending `title: null`.

## 28. A list may span every profile the caller may enter (`profiles=all`)

§4 keeps the header as the one way to name *the* profile a request acts in. ADR 0016
(owner, 2026-09-24) makes the chats list and search gather every profile a person may
enter, so `sessions.list` takes `profiles=all`: the page holds every enterable profile,
each item names its own `profile`, and the header still has to name one of them. It is a
query value rather than a second header or a `*` in `X-Hub-Profile` because it narrows
*which rows are listed*, the way `archived=all` does, and the header's meaning — where
the request acts — stays the same for every other call. Which profiles "all" covers is
the server's decision (`auth`'s membership rule), never a list the client sends. Opening
an item is an ordinary call with the item's `profile` in the header. The realtime
counterpart is the handshake's `profiles: 'all'` (events/README.md §Connecting).

Rejected: `X-Hub-Profile: *` (every scoped operation would have to refuse it but one),
and a new global operation beside `sessions.list` (two lists with the same filters and
the same cursor, drifting apart). `tasks.getColumns` stays the global operation it
already was.

## 29. A member's profile list is explicit; empty means none

Owner report, 2026-09-24: «انا كنت فاتح يوزر fff لما فتحت بروفايل جديد اضافه لليوزر fff مع
انه مهب ادمن؟ المفروض ما يضيفه له بدون ما ادخل انا واضيفه له؟». Until then
`UserCreate.profiles` said "Empty means every profile": a member with no list entered every
profile, including each one created afterwards, and the user view listed those as if they
had been granted. That rule is withdrawn.

- `User.profiles` for a member is exactly what an admin granted. Empty means the member
  enters **no** profile: they can sign in, `GET /profiles` answers an empty list, and every
  scoped request answers `404 profile_not_found` with `details.reason =
  no_profile_granted`, so a client can say "ask an admin" instead of "unknown profile".
  `default_profile` still reads `default` then; clients decide from `profiles`.
- `POST /auth/users` with `role: member` requires at least one slug, and `PATCH
  /auth/users/{id}` turning an admin into a member must carry the list in the same request
  (`400 validation_failed`, `details.field = profiles`). The rule depends on `role`, so it
  is stated in the descriptions rather than as `minItems`.
- `PATCH` with `profiles: []` on a member is allowed and explicit: it withdraws every
  profile. Archiving a member's last profile has the same result.
- Owners and admins are unchanged: they enter every profile, created later or not.
- Hubs upgraded from an earlier build keep what their members could enter on the day of the
  upgrade, and nothing created afterwards: `drizzle/0010_member_profiles_explicit.sql`
  enrolls each member with no list in every non-archived profile that exists then.

Not changed: `Webhook.profiles` ("Empty means every workspace") scopes a webhook, not a
person, and grants nobody access.
