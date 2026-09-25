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

## 30. A job may show its state while it runs; the agent tools that need Hermes to act

2026-09-24, with `agents.testMcpServer`, `agents.loginChannel` and `agents.importSkills`.

- **`channel_login` is a `JobKind`.** A QR pairing is long work with a state a screen must
  draw while it runs, so it is a job (invariant 4). `progress.message` stays a line for a
  person; the code itself travels in the job's `result` while the job runs —
  `{status, qr, expires_at}` — and the outcome replaces it when the job ends
  (`{status: connected, account_name, account_phone}`). Putting the QR payload in
  `progress.message` (the earlier wording) would have made a machine value out of a line
  every client shows as text.
- **Only `whatsapp` pairs by QR today**; any other platform is `409 state_invalid` with
  `details.reason = login_not_supported`. Telegram's onboarding in Hermes creates a bot
  through an outside service and asks for allowed user ids — a different product, not a pairing.
- **Where the hub does not supervise Hermes** the two tools that ask Hermes to act answer
  `409 state_invalid`, `details.reason = hermes_not_supervised`; Hermes refusing is `409
  conflict`, `hermes_refused`, with Hermes's `details.message`; Hermes's API not starting is
  `503 service_unavailable`, `hermes_api_unavailable`.
- **`SkillImport.category` is optional and not used for placement.** An imported skill is
  installed beside the others and lists under the category its own front matter names, like
  every other skill; a required field nobody used would have been a promise the hub did not
  keep. A refused pack names `details.reason`, `details.skill`, `details.file` and
  `details.message`; a skill that already exists is `409`, anything else `400`.

## 31. Archiving a conversation stops its runs; a paging cursor belongs to its conversation

Owner, 2026-09-24: archiving several chats while one was still working left the agent
working — and spending — in a conversation that was out of sight, and a task on that run
stayed `running` on the board. And the chat only ever showed the newest 100 messages.

- `sessions.update` with `archived: true`, and `sessions.bulkUpdate` with the same patch,
  stop every live run of each session exactly as the chat's Stop does (`sessions.cancelRun`):
  a queued run is cancelled before it starts (queued ones first, so ending the active run
  does not hand the adapter the next in line), an active run is interrupted and ends
  `cancelled` with its own `run.cancelled`. Both operations now declare `run.cancelled` in
  `x-rt-events`. A task on such a run moves as a stop from the chat moves it (`ready`, still
  assigned). `archived: false` starts nothing.
- `sessions.listMessages` pages back by keyset on the message's position in its session.
  A `before` that is not a message of **this** session — another conversation's, or one
  that no longer exists — answers `404 not_found` (`details.resource = message`). It used
  to be ignored, which answered the newest page again: a client paging back would have
  taken messages it already held for older ones.

## 32. Tasks and schedules list every profile; `profiles=all` is the one word for it

ADR 0016 stage 2 (owner, 2026-09-24: «الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون
تصنيف»). The Tasks board and the Schedules page show every profile the caller may enter,
with no profile filter in the clients; each card and schedule names its own `profile`.

- `tasks.listTasks` takes `profiles=all` exactly as `sessions.list` does (§28): without it
  the header's profile alone, as before; with it every enterable profile, one keyset
  (`id desc`) over all of them in one statement, and the header must still name one of them.
- `tasks.getColumns` and `schedules.list` were global already (`x-scope: global`, since
  2026-09-23). They accept `profiles=all` too, as an explicit synonym of what they answer
  anyway, so a client asks every list across profiles in the same words. Together with their
  older `profile` narrowing it is a contradiction and answers `400 validation_failed`. The
  `profile` narrowing stays for API callers; the clients do not offer it (ADR 0016 §4).
- `schedules.list` now honours the `cursor` and `limit` it always declared: newest first
  (`id desc`), one keyset across every profile. It used to answer everything with
  `next_cursor: null`; a client that read one page and ignored the cursor saw the first 50.
- **Acting on an item is an ordinary scoped call with the item's `profile` in
  `X-Hub-Profile`** — editing, moving, assigning, stopping, commenting, deleting, firing. The
  server checks that profile like any other: a member outside it gets `404
  profile_not_found`, and an item that is not in the named profile is `404 not_found`, never
  found in another. The top selector's profile only decides where a **new** task or schedule
  is made.
- Realtime: `profiles: 'all'` in the handshake of `/rt/tasks` and `/rt/schedules` joins the
  room of every enterable profile, by the same rule as `/rt/sessions` (§28).
- A task's `assignee.name` is resolved by the hub (the agents registry, the user's display
  name), never left to the client to guess from the agents of the profile it happens to be in.

Rejected: a profile filter on either page (the owner's words above); a new global operation
beside `tasks.listTasks` (the same reason as §28); changing the default of the two global
lists to "the header's profile" (it would silently narrow every existing caller).

## 33. An agent's pages are addressed by the agent's id; the contract does not move with the menu

Owner, 2026-09-24: «قراري اننا ندخل الايجنتات داخل الاعدادات كان خطا بالتصميم — تطلع فوق
Tasks في الصفحة الرئيسية». The Agents page leaves Settings for the main sidebar, above Tasks,
and an agent's pages carry the agent's own list (`docs/clients/NAVIGATION.md` §4). This is a
client decision; what it asks of the contract is recorded here so no client reads more into it.

- **No operation changes.** The Agents page is `agents.list`; each agent page is the operation
  it already was (`agents.listSkills`, `agents.listMcpServers`, `agents.listMemory`,
  `agents.listChannels`, `agents.getSettings`, …), addressed by `agent_id`. A client's own
  address for a page (`/agents/{agent_id}/memory` on the web) carries the same id and nothing
  the hub has to know about.
- **Which pages an agent has is the registry's answer, not the client's.** The pages come from
  the agent's `capabilities`; Settings is there for every installed agent, because every
  adapter has a settings descriptor (ADR 0002). `Agent.sections` stays as declared; the clients
  do not read it for this, so there is one rule and not two.
- **An agent page is scoped like any other call**: the person's `X-Hub-Profile`. Skills, MCP,
  memory and channels are per profile, so every client keeps the profile selector visible on
  these pages — the header decides which profile's tools are being edited.
- **Owners and admins, as before.** The operations keep their `x-roles` unchanged. Clients hide
  the entry from members and send a member who types the address back home; that is a menu
  rule, and the hub's own `x-roles` stay the refusal that counts.

Rejected: a new `agents.navigation` operation that tells clients which rows to draw (the
capabilities already say it), and moving `agent_id` out of the path for a slug (a slug can be
renamed; the id cannot).

## 34. Profile export and import are jobs in the caller's profile

ADR 0014 stage 2 makes `auth.exportProfile` and `auth.importProfile` do what they say, and
three details of the contract had to be settled for that:

- **Where the job lives.** Both operations are global (`x-scope: global`), but a job is a
  profile's row and `/rt/jobs` is a profile's room. The job is recorded in the caller's
  current profile (`X-Hub-Profile`, `default` when absent) — the one the client is already
  listening to — and so is the exported archive. The profile the export is *about* is the
  job's `resource: {kind: profile, id}`; the archive an import reads is `resource: {kind:
  attachment, id}`. `ResourceRef.kind` gains `profile` and `attachment` for that, and
  `JobKind` gains `import` (the stored kinds are `auth.export` and `auth.import`).
- **Who may read the archive.** An export holds a profile's memory and chats. Its attachment
  is readable only by the person who asked for it (`404` for anyone else, even in the same
  profile), is not listed by `knowledge.listItems`, and is deleted 24 hours later
  (`expires_at` in the job's result). An uploaded import archive is deleted when its job ends.
- **What a hub without Hermes answers.** Only a hub that supervises Hermes can ask it for an
  archive (ADR 0015). Elsewhere both operations answer `409 state_invalid` with
  `details.reason = hermes_not_supervised` before any job exists, rather than a job that fails
  a second later.

The result shapes are written in the operations' descriptions rather than as components:
`Job.result` is free-form for every kind, and a component nothing references is one the
linter rightly calls unused.

## 35. The hub fires its own schedules; a workflow step can wait for a person

The hub now runs every schedule that does not live in Hermes's scheduler, and a workflow
can pause at a step until someone answers. What that settles in the contract:

- **`schedules.runNow` answers the ids of what it started.** `ScheduleRunAccepted` gains
  `session_id`, `run_id` and `workflow_run_id` (required, nullable): an `agent_prompt`
  target opens a session of source `schedule` whose `origin` is the history line
  (`{kind: schedule_run, id}`), and `job_id` is that run's job; a `workflow` target starts a
  workflow run, which is also the `job_id`. A schedule in Hermes's scheduler still answers
  `null` for the three — Hermes runs it on its next tick. A target that cannot start is a
  failed history line and `409 conflict` with `details.reason = target_unavailable`,
  `details.message` and `details.schedule_run_id`, never a run that silently did not happen.
- **The history carries what each line started.** `ScheduleRun.session_id` is filled for a
  prompt run, so a client opens its conversation; `trigger` is `manual` for "Run now" and
  `schedule` for the schedule's own time. A tick that was claimed and not run (missed too
  long ago, or the previous run still going) is `status: cancelled` with the reason in
  `error` — the contract has no `skipped`.
- **`Schedule.next_run_at` is the stored tick** the scheduler will claim, so the page and
  the scheduler never disagree; it is computed when a tick is claimed, from that moment, in
  the schedule's timezone. `runNow` does not move it.
- **A workflow step's gate is an ordinary `Approval`** of kind `workflow_step`, with
  `workflow_run_id` and `node_id` set and `session_id`, `run_id`, `message_id` null; `agent`
  names the workflow (its id and name), because nothing else is asking. It is listed by
  `sessions.listApprovals`, read by `getApproval`, announced as `approval.requested` /
  `approval.resolved` profile-wide (no session journal to keep it in), and put in the run
  owner's inbox as an `approval_requested` notice whose `resource` is `{kind:
  workflow_run}`. `respondApproval` answers it: any `approve_*` continues the run from that
  step; `deny` fails the step with `answer` as the reason (the run follows the step's
  `failure` edges, or fails with the step's words); a second answer, or one after the run
  was cancelled, is `409 state_invalid`. The workflow emits `step.waiting` with the
  contract's `WorkflowStep`.
- **`WorkflowRun` is served in the contract's words**: a run paused at a gate is `waiting`
  (stored as `waiting_approval`), `trigger` is a `RunTrigger` (`{kind: schedule, id}` for a
  schedule's run, `{kind: user, id}` for a person's, `{kind: api, id: null}` otherwise), and
  `input` is what the person typed. The server used to send the stored words (`manual`,
  `waiting_approval`), which the schema never allowed.

Rejected: a separate gate resource beside `Approval` (the contract already names
`workflow_step` and the two fields; one inbox and one answer is the point), and answering
`runNow` before the run exists (the ids would be promises the hub might break).

## 36. An agent's plugins are what Hermes lists in the profile; its jobs are its schedules

2026-09-24, with the agent's Plugins and Jobs pages and Hermes's skills in category folders.

- **Plugins are Hermes's, per profile.** `agents.listPlugins` and `agents.updatePlugin`, stubs
  until now, answer with what Hermes's own `hermes plugins` command says in the Hermes home of
  the profile in `X-Hub-Profile`. Hermes's dashboard has plugin routes too, but they take no
  profile (unlike its MCP, skills and cron routes) and so could only ever reach the default
  profile. Two operations are added: `agents.installPlugin` (`POST /agents/{agent_id}/plugins`,
  a job of the new `JobKind` `plugin_install`, installed switched off) and `agents.deletePlugin`
  (`DELETE /agents/{agent_id}/plugins/{plugin_key}`, only what was installed into the profile;
  what Hermes ships answers `409 conflict`, `details.reason = plugin_bundled`).
- **`AgentPlugin` gains `status` and `removable`.** `status` is Hermes's own word —
  `enabled`, `disabled` (its deny list, which wins) or `not_enabled` (on neither; Hermes
  plugins are opt-in) — because a boolean would have folded the last two together.
  `removable` says what `DELETE` accepts; `manageable` now means "may be switched", which is
  true of every plugin Hermes lists, the ones it ships included (they are opt-in too). Fields
  Hermes's list does not report stay in the schema and are empty, and the schema says so.
- **A name Hermes lists twice is listed once.** Hermes ships a few plugins under one name in two
  categories, and its commands take the name to mean the first; the second is named in
  `warnings`.
- **Where the hub does not supervise Hermes** every plugin operation answers `409
  state_invalid`, `details.reason = hermes_not_supervised`, as the other tools that need
  Hermes to act; an agent that is not Hermes is `plugins_are_hermes_only`.
- **Jobs need no operation of their own.** For Hermes an agent's jobs are the jobs in Hermes's
  own scheduler, which `schedules.list` already returns (`profile` + `agent_id`, the
  "an agent's Jobs screen" its summary always named), and which the schedules operations
  already run, pause and delete. A second list would have been a second truth.
- **Skills in category folders.** `agents.listSkills` lists every skill below a folder that has
  no `SKILL.md` of its own, under that folder as its category (described by its
  `DESCRIPTION.md`) — Hermes's layout for its built-in skills. A skill Hermes seeded from its
  bundle (`skills/.bundled_manifest`) is `source: builtin`, and `putSkill`, `updateSkill`
  (`enabled`) and `deleteSkill` answer `409 conflict`, `details.reason = skill_bundled`;
  pinning, the hub's own order, still works. `putSkill` and `updateSkill` gain the `409` they
  can now answer.

## 37. A provider is every profile's or one profile's own; the model choice is the profile's

ADR 0010 says a provider is added **once** and every agent inherits it. The contract read "the
providers this workspace has added" and the server kept them per profile, so a profile made
later had no provider at all, and saving providers in any profile rewrote Hermes's default
profile with that profile's keys and model. A single hub-wide list was proposed and turned
down by the owner (2026-09-24): teams in different profiles may hold their own subscriptions —
Design and Finance each with its own OpenAI key — and one list «كذا بيدمجهم بحساب واحد وهي
مشكله». Hermes supports this itself: a profile's own `.env` wins over the process environment.
The owner's design, approved point by point:

- **Two scopes.** `ProviderCreate.scope` (`ProviderScope`: `all`, the default | `profile`) —
  «لمن هذا المزوّد؟ / Who is this provider for?», «كل البروفايلات / All profiles» or «هذا
  البروفايل فقط / This profile only» (the profile in `X-Hub-Profile`). `Provider.scope` (new,
  required) says which, and clients badge it «مشترك / Shared» or «<profile> فقط / <profile>
  only». Shared rows, their models and keys are stored under `default` (`Provider.profile` is
  `default`); a profile's own under that profile. `models.updateProvider` has no `scope`: a
  provider never moves between scopes. The same preset twice **in one scope** is `409
  provider_exists`; once shared and once as a profile's own is allowed.
- **Resolution.** A profile lists both; where both have a slug, its **own wins** — for its
  agents' keys, for the model a turn names (a stored id of the shared row runs on the profile's
  own of that slug), and in `models.listCatalogue`, which lists the providers the profile uses.
  A new blank profile has every shared provider and works at once.
- **Keys to Hermes.** The root home (Hermes's `default`) gets the keys the default profile uses
  and the gateway's environment the same. A named profile's own keys are written into **its**
  `.env`, which Hermes reads first. Hermes loads the root `.env` into its environment at start,
  so a named profile's `.env` also says the shared key where the default profile has its own
  instead, and an empty value where the root has a key that profile must not use; a variable
  equal to the root's is left out. Endpoints (`corehub-*` `providers:` blocks) are written into
  the `config.yaml` of every profile that uses them. Done on each save, after a profile is made,
  copied or imported, and before each turn in a named profile. Keys never come back (`[stored]`).
- **Model defaults per profile.** A role a profile has not chosen is the `default` profile's —
  the same model on the provider of the same slug the profile uses (owner: «صح»).
  `ModelDefaults.inherited` (new, optional) names those roles: `default` for the chat model with
  its fallbacks, else the auxiliary key. Saving `null` goes back to inheriting. The speech choice
  follows the same rule.
- **Copy.** A profile made as a copy of another gets the source's own providers **with their
  keys** («علشان لو الكي نسيته ما ابلش وينه»); the owner removes what the copy should not keep.
- **Export asks** «مع المزوّدين / بدون المزوّدين». `auth.exportProfile` takes an optional body
  `ProfileExport {providers}` (default `false`, as before: no key in the file). With `true` the
  archive also carries `<profile>/corehub-providers.json`: the providers the profile uses — its
  own and the shared ones it has no own row of that slug for — with their models and keys **in
  the clear**, written as providers of that profile alone; every other file is still checked
  and masked, and the client warns before it asks. `result.providers` counts them. On
  `auth.importProfile` the hub reads that file before Hermes sees the archive, never hands it on,
  and adds each entry to the new profile as its own; `result.providers` counts them.
- **Existing rows** (migration `0012_provider_scope`): every provider row older than the
  migration becomes its profile's own, where it was, key included — nothing merged, nothing
  lost. The owner's data at this point is test data; a shared provider is added once from then on.

Rejected: one hub-wide list (the owner's reason above); a copy of every shared provider in each
profile (that is the per-profile key entry ADR 0010 said no to); a scope that can be edited in
place (a key that silently changes owners).

## 38. A channel that pairs a device says whether it is linked; who may message the agent is approved in the profile

2026-09-24, with a messaging gateway per Hermes profile (the owner's report: WhatsApp paired in
profile «manger», Hermes restarted, the number never answered).

- **`Channel.link`.** WhatsApp's identity is the bridge's session folder, not a field, so a
  paired WhatsApp read as "not configured, 0 fields". `Channel` gains `link` —
  `{linked, account_id, account_name, account_phone}` for WhatsApp, read from the profile's
  session, `null` for every other platform — and for WhatsApp `configured` is `link.linked`.
  `enabled` follows Hermes's own rule for it (`WHATSAPP_ENABLED` in `.env` and
  `platforms.whatsapp.enabled` in `config.yaml`, whichever says off wins).
- **`agents.unlinkChannel`** (`POST /agents/{agent_id}/channels/{platform}/unlink`, `200` with
  the channel) is not `agents.clearChannel`: clearing forgets credentials that are fields,
  unlinking stops the gateway that runs the bridge, deletes the session and switches the
  channel off. Hermes and its bridge have no logout, which the description says, so the phone
  keeps listing the device until it is removed there. Only `whatsapp` (`409`,
  `unlink_not_supported` otherwise; `not_linked` when nothing is linked).
- **`agents.listChannels` gains `gateway`**: the messaging gateway that serves the profile and
  `applies` — `now` in a named profile, whose gateway the hub starts, restarts or stops on each
  channel change, `on_restart` in the default profile, whose gateway also carries the API
  server and waits for Hermes's Restart. `null` where the hub does not run Hermes.
  `Channel.status` now says what that gateway reports (`online`, `error` with Hermes's
  sentence, `offline`), `unknown` where the hub cannot know.
- **`AgentRuntime.gateways`** (optional; Hermes only): every messaging gateway, the default
  one and each named profile's, with its state, restarts, channels and `scheduled_jobs`. A
  named profile has one while it has a channel switched on and linked **or an active scheduled
  job of Hermes's own**, because Hermes fires a profile's jobs only in a gateway scoped to that
  profile; only the default gateway dispatches Hermes's one kanban board.
- **Pairing approvals** are Hermes's pairing in the selected profile: `agents.listPairing`
  (`GET /agents/{agent_id}/pairing` → `PairingList`), `agents.approvePairing`
  (`POST …/pairing/{platform}/requests/{request_id}/approve` → `PairedSender`),
  `agents.denyPairing` (`DELETE …/pairing/{platform}/requests/{request_id}`, `204`) and
  `agents.revokePairing` (`DELETE …/pairing/{platform}/approved/{user_id}`, `204`), all
  `x-roles: [owner, admin]` — the lists are other people's phone numbers. A request is
  addressed by Hermes's request id, never its code. Hermes has no verb for turning one request
  down (only one that clears every platform's), so Deny is the hub's removal of that request
  from Hermes's own pending file; the sender is not told. No realtime event: the page reads
  the list again every ten seconds while it is open.

## 39. Every upload is an attachment of its own; the same bytes are stored once and removed with the last

`sessions.uploadAttachment` and `sessions.completeUpload` answered `500` for the same file
uploaded again after it was deleted, and for the same bytes under another name
(`UNIQUE constraint failed: attachments.storage_key`): the store is content addressed, so every
copy of the same bytes in a profile has the same storage key, and the key was unique. The web's
skill import kept its uploaded packs for that reason alone (2026-09-24, agent tools PR).

- **One row per upload, bytes once.** Each upload answers a new `Attachment` id, even when the
  profile already holds the same bytes, under this name or another, live or deleted. The bytes
  stay stored once per profile (`sha256`), and `sessions.deleteAttachment` removes them only with
  the last live attachment that points at them. Until now the very same file with the same name
  and purpose answered the **existing** id; it no longer does, so one person deleting their
  upload never deletes someone else's copy. Proposed — owner to confirm.
- **`409` on `sessions.uploadAttachment`** (new documented status): only when the shared bytes
  were deleted while this upload was arriving — sending it again succeeds. Any other storage
  conflict is a `409` too, never a `500`.
- Migration `0013_attachments_shared_bytes`: the unique index on `attachments.storage_key` becomes
  a plain `(workspace, storage_key)` index. No row changes.
- The web deletes an imported skill pack's uploads once the import answered, whether it
  succeeded or was refused.

## 40. A schedule says whether a missed time runs, and what happens when its previous run is still going

The owner turned the two fixed rules of §35 into options of each schedule (2026-09-24):

- **`Schedule.run_if_missed`** (boolean; `false` when a new schedule does not say). A time up
  to two minutes late is on time — the hub looks every fifteen seconds — and runs either way.
  Later than that the hub was not running at the time: with the option on, it runs **once**
  if the hub is back within 24 hours of it; off, and always when older, the history records
  it (`status: cancelled`, `error` saying why) and the schedule moves on from now. Off is the
  default because «مرات الشي لزم ينرسل بوقت بالضبط علشان ما ينحاس المستخدم».
- **`Schedule.overlap`** (`ScheduleOverlap`: `skip` | `wait` | `parallel` | `replace`; `wait`
  when a new schedule does not say): what a time does when the schedule's previous run is
  still going. `skip` records it; `wait` holds it and starts it as soon as the previous run
  ends — **one** time waits at most, a further one is recorded as skipped; `parallel` starts
  it alongside, in a session (or workflow run) of its own; `replace` cancels the previous run
  for real (its line ends `cancelled`, "stopped: the next run of this schedule replaced it"),
  then starts.
- **"Run now" is never held back and stops nothing**, whatever `overlap` says: a person asked
  for a run now. Its run does count as "the previous run" for the schedule's next time.
- **`ScheduleRun.waiting`** (required boolean): `true` for the time held back by `wait`; its
  `status` is `queued`. A restart that ends the run it waited for applies `run_if_missed` to
  it, measured from its own time: on time or (option on and within 24 hours) it starts when
  the hub is back; otherwise it is recorded as missed. A time still waiting when its schedule
  is paused does not start.
- **Hermes's schedules have neither** (both `null`): Hermes's scheduler fires them and has no
  per-job setting for either. It runs a missed job once by a profile-wide
  `cron.catch_up_missed` (on by default, with a grace window of half the job's period, between
  two minutes and two hours) and always skips a job whose previous run is still going (read in
  Hermes's MIT sources at the pinned tag, `cron/jobs.py` and `cron/scheduler.py`). A write
  that sets either on a Hermes schedule is `409 conflict`, `details.reason =
  hermes_run_options`, `details.field`; `schedules.create` and `schedules.update` now document
  their `409`.

Rejected: mapping `run_if_missed` onto Hermes's `cron.catch_up_missed` (it is one setting for
every job of a profile; changing it from one schedule would change all of them), and a
separate `skipped` status (the contract already says a time not run is `cancelled` with the
reason, §35).

## 41. Telegram is linked by a bot token; a channel's own settings are options the hub describes

2026-09-24, the owner: «ابي تربط التليجرام … لانه ما سويت الا واتساب وانا احتاج تليجرام», then
«التليجرام فيه خصائص كثيره … يطلع ثينكينج … في اكثر من شغله».

- **`agents.linkChannel`** (`POST /agents/{agent_id}/channels/{platform}/link`, body
  `ChannelTokenLink {token, allowed_users?}`, `200` with the channel) is not `agents.loginChannel`:
  nothing is paired interactively and there is no job. The person makes the bot with @BotFather;
  the hub checks the token's shape, asks Telegram `getMe`, and stores the token in the selected
  profile's own Hermes `.env` — never in `config.yaml`, never returned. Hermes's own onboarding
  can make a bot through an outside service; the hub does not use it. Refusals are named:
  `token_invalid`, `token_rejected` (Telegram's words in `details.message`),
  `telegram_unreachable` (`503`), `token_in_use` with the `profile` that has the bot (Telegram
  lets one process poll a bot), `link_not_supported`, `hermes_not_supervised`.
- **`Channel.login` gains `token`**, and **`ChannelLink` covers Telegram**: `account_id` is the
  bot's id, `account_name` its name, the new `account_username` its @username (null for
  WhatsApp); `account_phone` is null. For Telegram `configured` is `link.linked`.
  `agents.unlinkChannel` covers Telegram: the token goes, the channel is switched off, the
  allowlist and the settings stay.
- **Linking switches pairing on explicitly** (`platforms.telegram.unauthorized_dm_behavior:
  pair`): Hermes treats strangers as "ignore" by default as soon as an allowlist exists, which
  would make the optional allowed-users field silently turn pairing off.
- **`agents.getChannelSettings` / `agents.updateChannelSettings`** describe a channel's options
  rather than fix them in the schema: `ChannelSetting {key, section, kind, value, default,
  choices, min, max, shared, source}`. Hermes adds options between releases; a schema property
  per option would need a contract change each time, and clients would still need their own
  words for each. The key is stable, clients key their label and help on it, and `value: null`
  (read or written) means "Hermes's default", which `default` states — including a profile-wide
  value the option falls back to. `shared: true` marks an option kept once for the profile
  (speech-to-text, voice replies) that changes every channel there. Only `telegram` today
  (`409 settings_not_supported` otherwise). A write is all or nothing; a wrong value is `400
  validation_failed` with `details.field = values.<key>`.

Rejected: a job for linking (it takes one HTTP call), the token in `config.yaml` (Hermes reads
the environment first, and `.env` is where #90 keeps a profile's secrets), and exposing every
Hermes key verbatim (a list of internals, some of which no person should touch — the change
record lists what was left out and why).

## 42. The contract says Core Hub; the names it had as Majlis are still accepted where a client could send them

The product is Core Hub (ADR 0017, owner 2026-09-24). What changes in the contract:

- **`info`**: `title: Core Hub API`, the contact URL `github.com/twuijri/core-hub`.
  The event schemas' `$id` are under `https://github.com/twuijri/core-hub/blob/main/packages/contracts/events/`.
  `meta.get` answers `name: "Core Hub"`.
- **Webhook signature header**: `X-CoreHub-Signature: sha256=<hex>` (the hub sent
  `X-Majlis-Signature`; the webhook schema's description said `X-Hub-Signature`, which the hub
  never sent — it now names the header the hub sends). Webhooks send only the test delivery
  today (forwarding is not built), so no receiver depends on the old header; it is renamed
  without a period of sending both.
- **Pairing QR payload**: `type: "corehub.pairing"`. A client **accepts** `majlis.pairing` too,
  since a code shown by a hub from before the rename may still be on a screen.
- **Profile archive with providers**: the file is `<profile>/corehub-providers.json`, format
  `corehub-providers`. An import also accepts `majlis-providers.json` / `majlis-providers`.
- **Access tokens**: signed with issuer `corehub`; a token signed with issuer `majlis` is still
  accepted, so the rename signs nobody out.
- No endpoint, field or status is added or removed. The generated Swift package is
  `CoreHubClient`; the Kotlin artifact `corehub-client` (package `hub.core.client` unchanged).

## 43. A conversation reads as its trajectory: timed steps and only the metrics the hub has

The owner asked for a "Trajectory" view of every conversation (2026-09-25, `docs/inspirations/trajectory.md`).
`sessions.getTrajectory` (`GET /sessions/{id}/trajectory`) answers a `Trajectory`: the person's
inputs, the model's turns, the reasoning shown and every tool call, in order, each with
`started_at` / `ended_at` / `duration_ms` (milliseconds kept) where the hub recorded them, and
`TrajectoryMetrics`. The same document with `download=true` is the **session log** file
(`Content-Disposition: attachment; filename="session-<id>-log.json"`); it is read with the same
access as the transcript it describes.

- **A model turn is inferred from the stream** (the hub cannot see an agent's own model calls):
  it opens when the run starts and whenever the last running tool ends, and closes when a tool
  starts, a person is asked something, or the run ends. Each run's turns are stored on the run
  (`runs.timing`, migration `0015`) with offsets into its text and reasoning, so a turn's words
  are cut from the finished message, and with how many tool calls had started before it, so
  steps are ordered by what happened rather than by a clock two events can share; a live run
  is read from the engine.
- **Nothing is invented.** A metric with no data is `null` and clients leave it out: tokens only
  when a provider reported usage, `cache_hit_pct` only when it reported cache reads, times only
  for runs recorded with their turns. `timing` says `full`, `partial` (older runs sit next to
  recorded ones) or `none`; untimed steps have `null` times and no place on a time axis.
- **Tool time** is wall-clock time with at least one tool running (parallel calls count once).
  **Tokens/s** is output tokens over the model time of the runs that report both.
- **Input tokens exclude the cache.** Adapters report `inputTokens` as the prompt tokens not read
  from or written to the cache (Anthropic's convention); the OpenAI-compatible and Google
  adapters, whose prompt totals include the cached part, now subtract it — which also stops the
  cost estimate charging a cached token twice. Hermes's TUI gateway reports its live session's
  running totals; the adapter records each turn's difference.
- No realtime event changed: a client reads the document again as `/rt/sessions` events arrive.

Rejected: building the trajectory in each client from the transcript (every client would
re-derive turns it cannot see, and the log would differ from the view), per-turn usage (no
agent reports it), and showing `0` for a metric nobody measured.

## 44. A profile's name is Hermes's display name; its id never changes where Hermes runs it

The owner asked whether Hermes lets the default profile be called anything (2026-09-25). Hermes
(`hermes_cli/profiles.py`, v2026.9.14) keeps a presentation-only `display_name` in a profile's
`profile.yaml`, at most 64 characters, shown beside the id and never used to find the profile.
`hermes profile rename default <name>` sets exactly that — `default` is reserved and stays the
id. For any other profile, `rename` moves the folder, stops its gateway and rewrites its alias
and Honcho host.

- **`name` is the display name, on both sides.** `auth.updateProfile` with `name` works for every
  profile, `default` included. Where the hub mirrors Hermes profiles (ADR 0014) it writes the
  name to Hermes first: `hermes profile rename default <name>` for `default`, `display_name` in
  `profiles/<slug>/profile.yaml` for a named profile (other keys kept, an empty name removes the
  key, as Hermes does). A name equal to the slug clears it. Hermes refusing leaves both sides
  unchanged: `409`, `details.reason = hermes_refused`, Hermes's words in `details.message`.
  `auth.createProfile` and `auth.importProfile` write the new profile's name the same way, best
  effort (the profile exists by then; a refusal is logged and the next rename writes it again).
- **The id stays.** Where the hub mirrors Hermes, a slug change is refused before anything is
  written (`409`, `details.reason = profile_id_fixed`): the slug is the Hermes folder that
  channels, schedules and chats find the profile by, and moving it is not safe while any of
  them is running. `default`'s slug never changes, as before. Without Hermes a named profile's
  slug may still change.
- **`ProfileName`**: trimmed, 1–64 characters (was 1–80), for `ProfileCreate`, `ProfilePatch`
  and `ProfileImport`. `Profile.name` in answers keeps 80, for rows written before.
- **An export's file** is named `<profile name>-<YYYYMMDD-HHMMSS>.tar.gz` (was `<slug>-…`): the
  name without path separators, `:*?"<>|`, control and direction marks, or the slug when nothing
  is left.

## 45. First-run setup says whether it is open without the token, and until when

ADR 0019 (owner, 2026-09-25) opens first-run setup to whoever arrives first for
`COREHUB_SETUP_OPEN_MINUTES` (60) after the hub starts with no owner; after that the claim token
of ADR 0011 is required again. What changes in the contract:

- **`Meta`** gains two required fields: `setup_open` (boolean — `auth.completeSetup` needs no
  token right now) and `setup_open_until` (date-time or `null` — when the window ends; `null`
  whenever `setup_open` is false). `setup_required` keeps its name and is the "needs an owner"
  bit: true before first setup and again after `COREHUB_RESET_OWNER` disabled the owner. It is
  not renamed to `needs_owner`, so no client breaks; a second field saying the same would be
  two answers to one question.
- **`SetupRequest.token`** is no longer required. Inside the window it may be left out (and is
  ignored if sent); after it, a missing token is `401 unauthorized` with the message key
  `auth.setup_token_required`, a wrong one stays `auth.setup_token_invalid`.
- `auth.getSetup` still answers `{ required }` alone: the window is `meta.get`'s, which every
  client already calls before it signs in.
- Racing setups: exactly one creates the owner; the other is `409` (the existing answer for
  "already set up").

Rejected: a `setup_mode` enum (`open` / `token`) — the two booleans and the end time say the
same and the time is what the screen counts down; the server's remaining seconds instead of an
end time — it goes stale the moment it is sent.

## 46. The global agent is one standing conversation per person per profile

The navigation map has had a `Global agent` destination since the start — no menu entry,
reached from search and from the pending-actions bar — and the contract already named the
source (`Session.source = global_agent`) and refused archiving it, but nothing could make such
a session. The docs said what it is not (a chat in the list) and where it is reached from; they
did not say how many there are or who owns one. Proposed here — owner to confirm:

- **One per person per profile.** `sessions.openGlobalAgent` (`POST /sessions/global-agent`,
  body `{agent_id}`) returns the caller's own global-agent conversation in the header's profile,
  `200`, or makes it with `agent_id` the first time, `201` (`session.created`). An existing one is
  returned whatever agent it was made with; `agent_id` is then ignored. Two first opens at once
  land on the same conversation (the older is kept, the younger removed).
- **Not in the chats list, never archived.** Clients leave `source: global_agent` out of the
  chats list; search still finds it and opens its page. `sessions.update` / `bulkUpdate` with
  `archived: true` on it is `409 state_invalid` (`details.field = archived`,
  `details.reason = global_agent`): with no list row, an archived one could not be restored.
  Deleting is allowed; the next open makes a new one. A fork of it is an ordinary `chat`.
- **What it can do is its agent's.** The hub gives it no powers across profiles: it runs in its
  profile like any conversation, with that profile's agent, tools and approvals. A wider
  "acts across profiles" agent would need its own ADR.

Rejected: a new `source` field on `SessionCreate` (a client could then make any number of
them, and would have to list-then-create with a race); `sessions.list?source=global_agent` as
the way in (the list is the profile's, not the person's, so it would hand one person another's).

## 47. A task works in its own git worktree, and `auto_start` starts it — a few at a time

Tasks stage 2 (2026-09-25). The contract already had `Project.working_dir`, `Worktree`, the three
worktree operations, `worktree.updated` and `Task.auto_start`; nothing made a worktree and nothing
read `auto_start`. What the fields now mean (descriptions only — no field, operation or event added):

- **`Project.working_dir` is a git work tree inside the profile's own folder**
  (`${DATA_DIR}/workspaces/<profile>`, the one folder that profile's sessions may work in). A
  relative path is taken from that folder. Checked on write: outside it, missing, through a
  symbolic link, or not a git work tree is `400 validation_failed` with `details.field:
  working_dir`, `details.reason` (`outside_root`, `not_found`, `symlink`, `not_a_git_repo`) and
  git's words in `details.message`. Written without `default_branch`, the branch checked out there
  becomes the project's base. Inside the profile because a task's session must be able to work in
  the worktree, and a session's folder never leaves the profile (sessions' `working-dir.ts`).
- **Starting a task of such a project makes a real `git worktree`** at
  `${DATA_DIR}/workspaces/<profile>/worktrees/<short id>-<slug>` on the branch
  `task/<short id>-<slug>` (short id = the project key and task number, `core-12`, or the end of
  the task id when the key is not ASCII; slug = the title's ASCII words). The row goes `creating`
  → `ready` (or `dirty`), or `error` with git's own message; the task's session is opened with the
  worktree as its folder, so every agent (Hermes and the ACP coding agents) gets it as its working
  directory. A worktree git refused stops the start: `409 conflict`, `details.reason:
  worktree_failed`, the task unchanged. Every git call is an argument array (`execFile`).
- **Removed, branch kept,** when the task is deleted or archived (including the weekly archive of
  Done), when its project is deleted, and by `tasks.deleteWorktree` — refused `409 task_running`
  while the task's run works in it. Made again (`tasks.createWorktree` or the next start) it comes
  back on the same branch. `tasks.createWorktree` refuses `409 no_repository` /
  `worktree_exists` before any job.
- **`auto_start`** starts a task on its own when it is `ready` and given to an agent — created so,
  assigned (without `start`), moved to `ready` by a person, or switched on while so. At most
  `COREHUB_TASK_AUTO_START_MAX` (default 2) runs started this way at once **per profile**; the
  rest wait, top of the Ready column first, and start as places free (a run ending, a restart).
  A person's "assign and start" is never held back. Stopping a task (board or chat) switches its
  `auto_start` off, so a stopped task does not start again by itself. A task that cannot start
  (unknown agent, worktree refused) goes to `blocked` with the reason instead of being retried.

Proposed, owner to confirm: the limit as an optional environment variable rather than a Settings
field (invariant 5 still holds — the hub starts without it); switching `auto_start` off on stop;
the `.corehub/` run-files line the hub adds to the repository's local `info/exclude` (never a
tracked file) so a run does not make its worktree `dirty`.

Rejected: running a repository task in the session's own folder when git refuses (the agent
would work on an empty folder and look successful); a per-project limit (the owner asked per
profile); a migration to make `worktrees.path` unique only among live rows — a task's removed
worktree row is reused instead, which also keeps one history per task.

## 70. The web terminal is the owner's, off by default, and every session is audited

The owner asked for a terminal in the web and said who it is for (2026-09-25): «الا خله للمشرف
الرئيسي بس» — the one account with role `owner`; not admins, not members. What the contract now
has (`terminal.get`, `/rt/terminal`, `terminal.output`, `terminal.exited`):

- **Off unless `COREHUB_WEB_TERMINAL=1`.** `GET /terminal` answers `403 forbidden` with
  `details.reason: terminal_disabled` — to the owner too — and every `/rt/terminal` handshake is
  refused the same way. A client shows the Terminal entry only on a `200`.
- **The owner, from a browser.** `x-roles: [owner]`: an admin or a member gets `403`
  (`required_role: owner`) and never connects. The owner's own app tokens (a paired phone, an
  integration) are refused too (`reason: web_session_required`): a leaked integration token must
  not be a shell. The handshake is authenticated like every namespace (the realtime auth scope of
  2026-09-24), and a role change or sign-out drops the socket.
- **A session is a shell on the hub's host, as the hub's own user,** in
  `DATA_DIR/workspaces/<profile>` of the profile the page is in, on a real PTY (`node-pty`) —
  or, where its binary does not load, a plain shell over pipes, which `pty: false` says. It
  inherits only a short list of variables (PATH, HOME, locale, Hermes's own), not the hub's
  environment. The image stays sealed: `/app` and `/opt/hermes` are read-only to that user.
- **It belongs to the owner, not the socket.** A reload or a dropped connection attaches again
  (`attach`, with the recent output to repaint), until nobody has typed for
  `COREHUB_WEB_TERMINAL_IDLE_MINUTES` (15) — output alone is not activity. At most three run at
  once; the fourth `open` is `conflict` with `reason: terminal_limit`.
- **Typing goes over the socket** (`input`, `resize`), the one exception to "mutations over HTTP"
  besides `typing`: a keystroke is not an action with an idempotency key.
- **Every start and end is in the audit log**: `terminal.opened` (who, the folder, the shell, the
  address) and `terminal.closed` (why: `closed`, `exited`, `idle`, `shutdown`; how long), which the
  Logs report lists. What is typed is not recorded.

Proposed, owner to confirm: the idle timeout as an environment variable; refusing app tokens;
three sessions hub-wide (there is one owner); not recording keystrokes (a password typed into
`sudo` or a `.env` would land in the database).

Rejected: letting admins in behind a second switch (the owner said the main owner only); a
session per socket (a reload would kill the running command); running the shell as another,
weaker user — the image has one unprivileged user, and a second one would need root to switch to.

Number taken while 36 PRs are being integrated: this may need renumbering.
