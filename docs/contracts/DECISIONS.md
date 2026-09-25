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

## 48. A conversation's files are listed and read inside its working folder, and previewed in a sandbox

The owner asked to see the conversation's files in the conversation (2026-09-25: «وبذات اني اقدر
استعرض الملفات بالمحادثه»). Two operations (§46 is the global agent's, and the open task-worktree change also numbered its decision §46 and
moves to §47 when it lands, so this is §48):

- `sessions.listFiles` (`GET /sessions/{id}/files`) answers a `SessionFileList`: one `SessionFile`
  per file, newest first, from three places — the paths the conversation's **tool calls** named
  (Hermes's arguments or its one-line preview for a file tool; an ACP agent's `rawInput`, now
  recorded as the call's arguments, with its `locations` and `diff` paths), the session's
  **working folder** (read to four levels and 2000 entries, 200 files listed, `truncated` when
  a cap is hit; hidden entries and `node_modules` skipped unless a tool call named the file), and
  the **attachments** of its messages. Each entry says how a client previews it (`preview`,
  chosen from the name) and up to what size (`preview_max_bytes`).
- `sessions.readFile` (`GET /sessions/{id}/files/content?path=`) sends one file of the working
  folder, read-only. The path is resolved against the folder's real path and every segment is
  `lstat`ed: outside the folder, a symbolic link anywhere on the way, or not a regular file is
  `400 validation_failed` (`details.reason`), and the file is opened with `O_NOFOLLOW` and sized
  on the open descriptor. A preview over its kind's limit is `413`; `download=true` has one
  limit of its own (100 MB). The type comes from the name (code as `text/plain`), never sniffed,
  and every answer carries `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and
  `no-store`. Attachments keep `sessions.downloadAttachment`.
- **The folder is the boundary**, not the profile: a conversation reads only its own folder. A
  task's session works in its task's folder (its git worktree when it has one), so that is
  covered by the same rule without a second root.
- **HTML is never shown in the client's origin.** Clients render it in an
  `<iframe sandbox="allow-scripts">` from `srcdoc` (no `allow-same-origin`: an opaque origin),
  behind a policy that lets the page run its own script and load scripts, styles, pictures and
  fonts over https — so a report that draws with a CDN library still draws — but calls nothing
  (`connect-src 'none'`), submits nothing, and frames nothing. "Open in new tab" opens a frame
  around the page, sandboxed the same way, never the page itself as a blob of the client's origin;
  an SVG is not opened in a tab at all.
- **Office files are read in the browser**, bounded: the ZIP's directory is checked first (at most
  5000 entries, 30 MB a part, 120 MB in all, as the archive declares them) and only the parts a
  preview needs are inflated, each into a buffer of exactly its declared size. Sheets and
  documents become tables and text a client draws itself (nothing is turned into HTML); a deck is
  an outline of its slides' titles and text, and says so.
- No realtime event was added: a client reads the list again when a tool call or a run ends on
  `/rt/sessions`; a changed `modified_at` or `size_bytes` means an open file changed.
- **Next: the files each run changed.** `fileRefsOf` keeps every ref with its run, so a
  per-run answer (`GET /sessions/{id}/runs/{run_id}/files`, with a diff) filters the same refs
  and adds what the run's start looked like; nothing in the two operations above changes for it.

Rejected: a token in the file URL so a frame or a tab could load it directly (the contract keeps
bearer tokens out of URLs), serving the agent's HTML from the hub's origin with a relaxed policy,
a third-party renderer for DOCX/PPTX that inflates without limits, and listing the whole profile
folder (another conversation's files are not this one's).

## 49. A run's changed files are recorded when it ends, from git or from a snapshot of its start

The owner wants to see what a run did to the files (2026-09-25, the next task §48 named). Proposed
— owner to confirm. (§47 is the open task-worktree change's and §48 the file preview's, so this
is §49.)

- **Three operations, no event.** `sessions.listChanges` (`GET /sessions/{id}/changes`) pages the
  runs of a conversation that changed a file, newest first, each a `RunChanges`: its files with
  what happened to them (`added`, `modified`, `deleted`, `renamed` with `old_path`) and their
  added/removed line counts, and the totals. `sessions.getRunChanges`
  (`GET /sessions/{id}/runs/{run_id}/changes`) is one run's; `sessions.getRunChangeDiff`
  (`…/changes/diff?path=`) is one file's unified diff, as text a client draws itself. A client
  reads the list again when `run.completed` / `run.failed` / `run.cancelled` arrives: the changes
  are written before that event is sent. The path §48 sketched (`…/runs/{run_id}/files`) became
  `…/changes`, so it does not read as a second file list.
- **Recorded, not recomputed.** The run's start is taken before the agent is handed the turn and
  compared with the folder when the run ends; the result — the files and their diffs — is stored
  with the run (`runs.changes`, `run_file_changes`). The answer is what *that run* did, whatever
  later runs or the person did to the files. A run that recorded nothing (no working folder, or
  from before this) has no entry and no card; one that changed nothing has an empty entry.
- **Git when the folder is in a repository or worktree.** The folder is written to a git tree
  through a *copy* of the index (`GIT_INDEX_FILE`), at the start and at the end, and git compares
  the two trees (`--numstat`, renames with `-M`, one patch per file). Tracked changes and untracked
  files count, ignored files and the hub's `.corehub` run folders do not; the person's index,
  branch and stash are never touched. An untracked file over 2 MB is not hashed into the
  repository (it would bloat `.git` on every run): it is compared by size and time and its diff
  is `too_large`. A folder the repository ignores is read as a plain folder. Every git call is an
  argument array with a 20-second timeout and an output cap, `core.fsmonitor` off.
- **A snapshot without git.** The folder is read at the start to 8 levels and 10 000 entries
  (`complete: false` beyond), and text files up to 256 KB are kept in memory to diff against
  (8 MB a run, plus 4 MB for files a tool call names during the run that the start did not keep).
  The hub diffs them itself (Myers, 3 lines of context; above 50 000 lines a side or 2000 edits
  apart it only counts). A file with no kept copy is still listed as changed, with
  `diff: unavailable` and no counts; a rename is recognised when a deleted file's exact bytes
  reappear under another name.
- **Caps.** 200 files kept per run (the first by path; the totals count every one, `truncated`
  says so), 256 KB of diff per file (cut at a line, `truncated`), 2 MB of diff per run (files
  past it are `too_large`), 1 MB the largest file diffed without git. Binary files (a NUL byte in
  the first 8000, git's test) are `binary`, without counts.
- **Clients.** A compact card under the last reply of each run that changed something —
  «غيّر N ملفات (+a −b)» / "Changed N files (+a −b)" — lists each file with its counts; a file
  opens its diff in the file panel of §48 (unified, with line numbers; side by side on a wide
  screen), with a button that opens the file itself. Code is left-to-right inside a right-to-left
  page.

Rejected: recomputing a diff on request from the two trees' ids (unreferenced git objects are
pruned by `git gc`, and a plain folder has no second copy), relying on the diffs ACP agents send
with a tool call (Hermes sends none, and a shell command that writes a file sends nothing),
committing to the person's branch or a hidden ref at each run (it would change their
repository), and a realtime event per change (the run's end already tells a client to look).

## 50. Usage and Skills usage are typed reports aggregated on the hub; a number only where one was measured

`audit.getReport` answered Usage with an open `data` block over a rolling window, and `skills`
with `501` because nothing recorded skill use. The Usage page now needs a period choice,
summary cards, a daily chart, per-model and per-agent shares and filters, and Skills usage needs
data at all. Proposed here — owner to confirm:

- **Two typed operations.** `audit.getUsage` (`GET /audit/usage`, `UsageReport`) and
  `audit.getSkillUsage` (`GET /audit/skills`, `SkillUsageReport`), with the same parameters:
  `days` (1–365; clients offer 7, 30, 90 and 365), `profiles=all` (every profile the caller may
  enter, ADR 0016; the header must still name one), `agent_id`, and `utc_offset_minutes`. Both are
  aggregated in SQL grouped by calendar day over the ledgers' time indexes and a new
  `runs (workspace, created_at)` index — never shipped as raw rows. `audit.getReport` stays for
  the other kinds; its `skills` now answers the Skills usage body for the header's profile.
- **A day is the caller's calendar day.** `days=7` is today and the six days before it in the
  calendar `utc_offset_minutes` east of UTC; `by_day` has every day, zeros included. A fixed
  offset rather than a time zone name, because the hub's SQLite cannot convert zones; a period
  across a daylight-saving change is off by that hour at most.
- **Only what was measured is a number.** The ledger stores an unreported cache as `0`, so a
  period with no cache read (or write) at all answers `null` for it and for `cache_hit_rate`
  (Hermes reports no cache today). `cost` is `null` where nothing was priced. An agent that ran
  but reported no usage (coding agents over ACP) is listed with `reports_usage: false` and `null`
  tokens, and its runs are `unreported_runs`. `total_tokens` is input + output + cache reads +
  cache writes; `cache_hit_rate` is cache reads over (fresh input + cache reads), because input
  tokens exclude cached ones (decision §43). "Conversations per day" is the mean over the
  period's days of the conversations active that day.
- **A skill use is a skill a run loaded.** Read from Hermes's MIT source (v2026.9.14): Hermes
  loads a skill with the `skill_view(name, file_path?)` tool and counts a successful call as a use
  (`tools/skills_tool.py`, `bump_use`). The hub records one `skill_uses` row per run and skill when
  such a call completes — a linked file of the same skill, or loading it again in the same run, is
  the same use; a failed call and `skill_manage` (an edit) are not uses. Coding agents over ACP
  name a tool call by title and kind only, so their skill use is not counted. Past use cannot be
  rebuilt: the migration writes this install's start into `audit_counters`, and the report says
  `counting_since`.
- **Never used** is the enabled skills of the hub's Hermes in the covered profiles that no run
  loaded in the period, `null` when the hub cannot see those skills (an external Hermes, a profile
  Hermes lacks). The daily chart carries the six most used skills of the period and the rest as
  `other`.
- **"Show cost"** on the Usage page is the existing `Preferences.show_cost`, the same one the chat
  uses; no new preference.

Rejected: keeping `data` open on `getReport` (three clients would read a shape nobody declared);
reading Hermes's own `skill_usage` counters (one number per skill with no profile, agent, session
or day, and invisible for an external Hermes); a stored day column (it would freeze one calendar
for every reader).

## 51. Logs and Performance are live: log rings in memory, and processes measured when asked

`audit.getReport` answered Logs with the audit trail and job events, and Performance with a
minute-by-minute row the hub wrote about its own memory. Neither showed what an owner opens those
screens for: what the hub and Hermes just said, and what is using the machine now. Proposed
here — owner to confirm:

- **`audit.listLogLines`** (`GET /audit/logs/lines`, owners and admins, global) reads bounded
  rings kept **in the hub's memory**: one for the hub and one per Hermes profile's gateway
  (`tui` for the TUI gateway every profile shares), 5000 lines each. Not the database and not a
  file: a log screen is for what just happened, the container's stdout already keeps the whole
  history, and a ring cannot fill a disk. A ring per source so a chatty gateway cannot push the
  hub's last error out. A restart empties them, and the screen says so.
- Filters are the hub's: `source` (`all`, `hub`, `hermes`, `errors` — every source's `error`
  lines), `profile`, `level` (the least severe shown), `q` (case-insensitive text), `limit`
  (the newest 1–5000, returned oldest first) and `after` (only lines with a larger `seq`; one
  counter across the rings) for a live tail. The screen offers 200 · 1000 · 5000.
- Only a line's message (and an error's message) is kept, never the log call's other fields: the
  ring is filled before pino's redaction. Fastify's per-request access lines are left out — the
  screen polls, and its own requests would fill the ring. A Hermes line's level is the word in the
  line (`ERROR`, `WARNING`, a traceback), not the pipe it came through.
- **`audit.getLivePerformance`** (`GET /audit/performance/live`, owners and admins, global)
  measures **when asked**, with nothing on a timer: the host (CPU, memory used/total, load), the
  hub process (CPU, RSS, heap, mean event-loop lag, uptime), each Hermes process the hub runs
  (TUI gateway, `hermes serve`, each profile's messaging gateway: pid, state, CPU, RSS, uptime)
  and each profile's unfinished runs, conversations not archived and connected clients. CPU is
  the share between two samples: the first look takes two, 250 ms apart. `history` is the samples
  taken while somebody looked, at most 72 (six minutes at the screen's five seconds), for the
  sparklines. Viewers two seconds apart share one sample.
- Linux reads `/proc`; elsewhere the host comes from Node's `os` and the Hermes processes are
  listed with `null` numbers, never zeros. Process CPU is of one core, like `top`.
- Clients poll (5 s for Performance, 3 s for the Logs tail) and stop while the tab is hidden; no
  realtime event is added.
- The Logs screen becomes **owners and admins only**, like Performance (it was `member`): the
  hub's and Hermes's own lines are not a member's business.

Rejected: a database table of log lines (write amplification for lines nobody reads); a
background sampler every 5 s (work while nobody watches); a new realtime namespace (a poll every
few seconds of one small document is simpler and pauses by itself). `audit.getReport` keeps its
`logs` and `performance` kinds unchanged for the CLI and older clients.

## 52. A workflow is drawn against the hub's own check, and a run says what each step produced

The web gets a canvas for workflows (the Workflows section of the Schedules page). A canvas
needs three things the contract did not have. Proposed here — owner to confirm:

- **`schedules.validateWorkflow`** (`POST /workflows/validate`, body `WorkflowWrite`) runs the
  check `createWorkflow`/`updateWorkflow` apply on a drawing that is **not saved** and answers
  `200 WorkflowValidation { valid, problems, warnings }`. Nothing is written or announced. Each
  finding is a `WorkflowIssue { code, node_id, edge_id, detail, message }`: a stable `code` a
  client translates (the list is in the schema), the node or edge it is about so an editor can
  mark it, and `message` — the same English words `409 workflow_invalid` has always carried in
  `details.problems`, which is unchanged. `problems` are what saving would refuse; `warnings`
  (no steps, no start, several starts, an agent step with no agent) are saved anyway. A client
  that meets a code it does not know shows `message`. The client never re-implements the check.
- **`schedules.listWorkflows` takes `profiles=all`**: every profile the caller may enter (the
  server's rule, as `schedules.list`, §32), each workflow with its own `profile`, newest first.
  Without it the list is the header's profile, as before. The Schedules page shows every
  profile (ADR 0016), so its Workflows section uses it; acting on a workflow is a call in that
  workflow's `profile`.
- **`WorkflowStep` gains `output` and `route`** (both required, both nullable). `output` is what
  the step produced as text — the agent's answer, the notice's words, a condition's
  `true`/`false`, a delay's seconds, an approval's answer — capped at 20 000 characters; `route`
  is which edges it follows (`success`/`failure`; `always` edges follow either), written by the
  engine when the step ends. A condition's "no" is a `succeeded` step with `route: failure`, which
  is why the client cannot infer the route from the status alone. Steps finished before this
  read their route from their status. The `step.waiting` event carries the same two fields.
- **An agent step's own `model`/`provider` now reach its turn.** The node always had the fields;
  the engine ignored them. Null still means the agent's model.
- **Positions and direction.** A node's `position` (already in the contract) is **logical**: `x`
  is the distance along the reading direction. The web canvas mirrors itself in a right-to-left
  language, so a flow drawn in Arabic runs right-to-left and the same workflow opened in English
  runs left-to-right; no second layout is stored. Other clients should do the same.

Not added: recipients for `notify` (a notice reaches the inbox of whoever the run belongs to)
and a timeout for `approval` (it waits until answered) — the engine has neither, and a form
field that does nothing would be a promise. Rejected: validating in the client (two rules that
drift), and a separate `layout` object (positions already live on the nodes).

## 53. A workflow run has limits; a schedule's next times can be asked before it is saved

Two small additions to `schedules`. Proposed here — owner to confirm:

- **`WorkflowLimits`** — `max_duration_seconds` (time budget, at most a week),
  `max_cost` (`Money`, USD only, above zero) and `step_timeout_seconds` (at most a day), each
  `null` for no limit. `Workflow.limits` is required (no limits = three `null`s);
  `WorkflowWrite.limits` replaces the whole object. A run can set its own:
  `WorkflowRunRequest.limits` (`WorkflowLimitsOverride`) — a field given replaces the workflow's
  for that run, `null` lifts it, absent keeps it; the older `timeout_ms` is the same time
  budget in milliseconds, and `limits.max_duration_seconds` wins over it. A cost in another
  currency, or not above zero, is `409` with `details.reason = limit_invalid` and
  `details.field`. `schedules.createWorkflow` now documents its `409` (it already answered
  `workflow_invalid` with it).
- **What a run shows**: `WorkflowRun.limits` (the ones it ran under — a rerun from a step keeps
  those of the run it repeats), `WorkflowRun.cost` (`Money`, the sum of the hub's per-turn
  estimate — the same one `Usage.cost` carries — over its agent steps; `null` while none had a
  price) and `WorkflowRun.stopped_by` (`max_duration` | `max_cost` | `step_timeout` | `null`).
- **How they stop a run.** The time budget and the cost budget stop the run at once: the step
  working then is cancelled (an agent's run is stopped the way the chat's Stop does; a delay
  ends), its status is `cancelled`, and the run is `failed` with `stopped_by` and an `error` that
  says the limit ("stopped: the run went over its cost limit of $1.00 (it cost about $1.25)").
  The cost is read while an agent step works (every two seconds) and when it ends; a budget
  already used up stops the run before its next step. A step past `step_timeout_seconds` is
  cancelled and **fails like any failed step** ("timed out after 30 s"), so a `failure` edge can
  take it; only a timeout nothing handles ends the run, with `stopped_by: step_timeout`.
- **Waiting for a person is not work.** Time a run waits at an approval counts toward neither
  the time budget nor a step's timeout; what the run used before the wait is written down with
  its place and carried on after the answer (and after a restart).
- **A turn with no price counts as nothing.** The hub only knows what its estimate knows; a
  model it has no price for cannot trip a cost budget. The run view says "no priced turn yet".
- **`schedules.previewTrigger`** (`POST /schedules/preview`, body `{trigger, count}`) answers the
  next `count` times (3 by default, at most 10) a trigger would fire, from now, in UTC, with the
  trigger's `timezone` to show them in — the same check and the same calculation that set a
  saved schedule's `next_run_at` (`cron.ts`), each next time counted from the one before as the
  scheduler does. A trigger saving would refuse is refused the same way (`409 cron_invalid`,
  `timezone_unknown`, …). A schedule in Hermes's scheduler is timed by Hermes; a five-field cron
  reads the same there. Nothing is written.

Rejected: limits as columns (they live in the workflow's `definition` and the run's
`definition_snapshot`, where the drawing already is — no migration, and a run keeps what it ran
under); cost budgets in any currency (the hub has no exchange rate); a step timeout that ends
the whole run (a timeout is a failure a drawing may want to handle, like any other); counting
the wait at an approval (a budget protects against runaway work, not a slow person); computing
the next times in the browser (a second cron reader that could disagree with the hub's).

## 54. A turn moves down the profile's fallback chain when the provider, not the request, failed

`ModelDefaults.fallbacks` was declared from the start ("tried in order when the chosen model
fails") and stored, but nothing tried it: a `503 auth_unavailable` from the owner's proxy ended
the whole run (2026-09-25). What it means now — proposed, owner to confirm:

- **When it moves on.** Only on an error another model could get past: the provider is
  unavailable (any 5xx, or a body saying `auth_unavailable`), rate limited (429), timed out
  (408, or no answer in time) or could not be reached at all. Never on another 4xx — a request
  the provider refused as invalid (400, 404 unknown model, 413, 422) would be refused by the
  next one too — and not on 401/403, which say this provider's key is wrong, something the
  person must fix rather than something to hide. Never once the model has started answering:
  a second model finishing the first one's half-sentence would read as one voice.
- **Which chain.** The profile's, with its chat model (inherited from `default` together with
  it, §37). Every agent of the profile uses it after the model that agent runs on — the one
  chosen in the composer, the agent's own, or the profile's; a model already tried is skipped.
  A per-agent chain is not in this decision.
- **Where it runs.** For Hermes, in Hermes: the hub writes the chain as `fallback_providers`
  in the profile's `config.yaml` (Hermes's own failover, MIT source
  `hermes_cli/fallback_config.py`), the key the hub then owns wherever it owns the model
  selection; which errors move on is then Hermes's own classification of them. For the hub's
  own `direct` agent, in the hub, by the rule above.
- **What a client sees.** `Run.fallback` (absent or `null` when the chosen model answered) lists
  the models that failed, in order, with the contract's error code and the provider's words;
  `Run.model` / `Run.provider` then name the model that answered. The first `turn` step of that
  run in the trajectory carries the same `fallback`, and every `turn` step its `model`. Hermes
  does not say why it switched, so its attempts have `code: null`.

Rejected: a new `run.fallback` realtime event (the switch happens before the first word, and
`run.completed` already carries the run); retrying the same model first (Hermes already does;
the direct agent's providers answer an outage for longer than a retry waits).

## 55. A provider signed in to by device code is signed in through Hermes, where Hermes can

`models.startProviderSignIn` / `getProviderSignIn` / `completeProviderSignIn` were declared and
answered `501` because no provider in the catalogue used a sign-in. Hermes can sign in to four
by device code from its own server (MIT source `hermes_cli/web_routers/oauth.py`): Nous Portal,
a ChatGPT/Codex subscription, xAI Grok (SuperGrok / Premium+) and MiniMax. Proposed, owner to
confirm:

- **Those four are presets with `sign_in: true`** (`ProviderPreset.sign_in`, new, required):
  added with no key, `auth.kind = oauth`, `signed_in` false until a sign-in is approved. No
  other provider offers a sign-in, so a client shows the button only for these. Anthropic's
  subscription is not one of them: Hermes deliberately keeps it to its terminal, and the hub
  follows it.
- **Hermes does the sign-in and keeps the credential**, through its server (ADR 0015): the hub
  starts it for the provider's scope — a shared provider in Hermes's root (the `default`
  profile), a profile's own provider in that Hermes profile — shows Hermes's code and link, and
  answers each poll with Hermes's state. No token passes through the hub. So the hub offers it
  only where it supervises Hermes (`409 state_invalid`, `details.reason = hermes_not_supervised`
  elsewhere), and a signed-in provider is used by Hermes alone: the `direct` agent refuses it by
  name, and its models are the ones Hermes lists for it.
- **`ProviderSignIn`** gains `failed` (the sign-in could not finish) and `error` (why, in
  Hermes's words). `accepts_code` is false for every one of them, so `completeProviderSignIn`
  is `409 state_invalid` (`details.reason = code_not_accepted`). A sign-in the hub no longer
  holds — its code ran out, or the hub restarted — is `404`.

Rejected: the hub running the device-code exchange itself (it would hold subscription tokens
Hermes then has to be handed, and Hermes's refresh logic per provider is not ours to copy);
offering the sign-in where the hub does not supervise Hermes (the credential would land in a
home it does not write to).

## 56. Subagents are part of their conversation; the Background panel is everything working for a person

The owner asked for what Claude shows as its background tasks: the subagents an agent is running,
and everything else working in the background. Hermes delegates to subagents with its
`delegate_task` tools and reports them on its TUI gateway (`subagent.start`, `subagent.tool`,
`subagent.complete`; `subagent.list`, `subagent.interrupt`, `subagent.steer`, `subagent.tail` —
read in Hermes's MIT source, `tui_gateway/` and `tools/delegate_tool*.py`). Proposed here — owner
to confirm:

- **A subagent belongs to its conversation, not to a run.** Hermes can keep a subagent going
  after the turn that started it (asynchronous delegation), so `Subagent.run_id` is only the run
  that was going when it started. `sessions.listSubagents`, `sessions.interruptSubagent`,
  `sessions.steerSubagent` and `sessions.tailSubagent` are per conversation, and the three events
  `subagent.started`, `subagent.updated`, `subagent.completed` on `/rt/sessions` are profile-wide
  (like `approval.*`) so the Background panel hears them wherever the person is. `subagent.*`
  carries the whole `Subagent`, never a delta.
- **What an agent supports is declared, not guessed**: `Agent.subagents` is `full` (Hermes: live,
  Stop, Steer while `accepting_steer`, the output's tail), `observe` (Claude Code and OpenCode:
  their ACP stream names a delegation — Claude Code's `Task` tool, OpenCode's `task` tool with a
  `subagent_type` — and its end, and no more: no tools, no stop, no steer) or `none` (Gemini CLI
  and Codex: their ACP bridges send a delegation as an ordinary tool call with nothing that marks
  it; the hub's own `direct` agent does not delegate). A client shows only what `support` allows.
  A subagent's own tool calls are attributed to it only where the agent's stream says so
  (`ToolCall.subagent_id`); Claude Code's bridge flattens them into the parent's stream without a
  parent id, so they stay the parent's tools.
- **Finished subagents stay on the conversation**: the last 50, with their goal, model, times,
  tool count, their last 50 tools and their last words, kept in the session's `metadata` (no new
  table). One recorded as running when the hub restarted reads `interrupted`.
- **The trajectory draws them in a lane of their own** (`TrajectoryLane.subagents`): one
  `subagent` step per subagent from start to end, and every tool call that carries a
  `subagent_id`.
- **The Background panel is the person's own work** (`background.list`, `background.stop`): their
  chat runs, task runs, schedule runs (a schedule of theirs that fired), workflow runs, jobs and
  their conversations' subagents, across every profile they may enter with `profiles=all`.
  Running first (oldest first), then what finished in the last 24 hours (newest first, at most
  50). Another person's run in a shared profile is not in it: it is work for them, not for the
  one looking. Stop is the item's own stop, reached through one operation so every client stops
  every kind the same way. A subagent that finished before the hub last started is not listed
  as finished there (it stays on its conversation).

Rejected: one run-level list (it would lose a subagent that outlives its turn); guessing Claude
Code's subagent tools from "whatever ran while one Task was open" (parallel Tasks would be
mis-attributed); a new table for subagents (the conversation already has a place for adapter
data, and a migration would collide with the open usage-analytics one).

## 57. The composer's `/` commands are the agent's own; compression is a session operation with a meter

An observer report said the older product had slash commands and a context meter. Hermes has
both behind its TUI gateway (MIT, read at tag v2026.9.14, `tui_gateway/methods_tools.py`,
`methods_session.py`, `session_compression.py`, `hermes_cli/config_defaults.py`), so the hub
carries Hermes's own mechanisms rather than inventing its own. Proposed here — owner to confirm:

- **A command is offered only when the session's agent can do it.** Six `AgentCapability`
  values say so: `compress`, `steer`, `goals`, `plans`, `learn`, `skill_commands`. Hermes has
  all six; no other agent in the catalogue has any. Hub shortcuts (`/new`, `/fork`,
  `/archive`, `/model`, `/clear-screen`) need no capability: they are the client calling
  operations it already had. Any other `/text` is an ordinary message (`role: command`, §1).
- **`/goal`, `/plan`, `/learn` and `/skill <name>` are messages.** The hub stores them like any
  message and the adapter hands them to Hermes's `command.dispatch`; what Hermes answers — a
  prompt to run (`send`, `skill`) or a line of output (`exec`) — becomes the run's turn. The
  transcript shows what the person typed, never the expanded prompt Hermes builds (Hermes's own
  rule: "UIs render `display`, never `message`"). No new operation was needed.
- **`sessions.compress`** (`POST /sessions/{id}/compress`, optional `{focus}`) is Hermes's
  `session.compress`: only between turns (`409 already_running` otherwise), answers
  `SessionCompression` with Hermes's before/after counts. It runs on the session's turn chain,
  so a message sent meanwhile waits for it instead of racing it.
- **`sessions.steerRun`** (`POST /sessions/{id}/runs/{run_id}/steer`, `{text}`) is Hermes's
  `session.steer`: the text reaches the agent after its next tool call, the run is not
  interrupted and nothing is added to the transcript. `rejected` tells the client to send the
  text as an ordinary message — Hermes's own fallback.
- **`context.compression`** (`/rt/sessions`) says `started` / `finished` / `failed`, with
  `trigger: manual` for `sessions.compress` and `auto` when Hermes compresses during a run
  (its `status.update` of kind `compressing`/`compacting`). `context.updated` follows.
- **The meter reads Hermes's own count.** `ContextUsage` gains `estimated`. Hermes reports the
  window it uses and how full it is with every finished turn (`context_used`, `context_max`,
  `context_estimated`); the hub keeps the last report on the session, so `Session.context` is
  no longer always `null`. Where an agent reports nothing, a client may still estimate from
  the last run's input tokens against the catalogue's window — and must label it an estimate.
- **Automatic compression is the profile's `compression` settings, written to Hermes.**
  `ProfileSettings.compression` already had Hermes's keys under our names; it now also has
  `context_length` (`model.context_length`), and where the hub supervises Hermes a read comes
  from the profile's `config.yaml` and a write goes there (`compression.enabled`, `threshold`,
  `target_ratio`, `protect_first_n`, `protect_last_n`). Hermes re-reads them at the start of
  the next turn, so no restart.

Rejected: a hub-side command table the server executes (`POST /sessions/{id}/commands`) —
it would have to create messages and runs that do not match what the person typed, and would
duplicate what Hermes already decides; a per-agent `commands` list instead of capabilities —
one more field to keep in step with the catalogue; putting compression settings on the agent's
settings form — those values are stored by the hub and never reach Hermes today, which is the
defect this entry exists to avoid repeating.

## 58. Hermes's settings are Hermes's own keys, per profile; staged memory and skill writes are reviewed in the hub

Hermes's Settings page showed four sections (`agent`, `memory`, `session`, `gateway`) that the
hub stored in its own table and nothing read — a turn limit of 40 that Hermes never saw, an
approvals mode, a gateway URL. The profile settings carried `proxy` and `privacy.redact_pii`
that nothing applied either. Read in Hermes's MIT source (v2026.9.14) and proposed here — owner to
confirm:

- **The adapter's form is Hermes's own keys in the selected profile.** `agents.getSettings` /
  `agents.updateSettings` for Hermes read and write the profile's `config.yaml` (edited in place,
  comments kept) or its `.env`: `agent` — `agent.max_turns`, `agent.run_budget_seconds`,
  `agent.tool_use_enforcement`, `agent.reasoning_effort`; `memory` — the two character budgets;
  `approvals` — `approvals.mode`, `memory.write_approval`, `skills.write_approval`; `network` —
  `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`; `privacy` — `privacy.redact_pii`. Nothing is stored by
  the hub. The old four sections are gone (the gateway URL is the registry's, not a setting).
- **`SettingsField` says what it does and what Hermes does without it.** Optional `help`,
  `default` (Hermes's own; `value: null` means nothing written, and sending `null` puts it back)
  and `default_text`; `Choice.labels` in both languages; `SettingsSection.applies`
  (`next_message` | `restart`) and `note`. All additive.
- **When a value applies.** Hermes reads these when it builds a session's agent, so saving retires
  the TUI gateway the way a key change does: every conversation takes them from its next message.
  A named profile's messaging gateway is restarted at once; the default profile's waits for
  Restart. The proxy is process-wide: in the default profile saving runs Hermes's Restart as a
  job (`restart_job_id`), because the one TUI gateway serves every profile from the root home —
  so the default profile's proxy is the one every conversation uses, and a named profile's reaches
  only its own gateway. **The proxy is Hermes's only; the hub's own requests do not use it.**
- **`redact_pii` is wired to Hermes, the hub's field deprecated.** The Privacy page's switch is
  Hermes's `privacy.redact_pii` in the profile (WhatsApp, Telegram, Signal, BlueBubbles; re-read
  per message). `ProfileSettings.privacy` and `ProfileSettings.proxy`, which nothing read, are
  `deprecated` and kept so no client breaks; removing them is a later breaking change.
- **Review of staged writes.** With a write gate on, Hermes keeps each memory or skill write in
  `pending/<memory|skills>/<id>.json`. `agents.listPendingWrites`, `agents.approvePendingWrite`
  (Hermes's own `apply_memory_pending` / `apply_skill_pending`, run with Hermes's Python against
  the profile's home; a write Hermes refuses stays, `409` with Hermes's words) and
  `agents.rejectPendingWrite` (the record removed, which is Hermes's reject).
- **Not built, because Hermes does not have it:** an automatic session reset after idle time or at
  an hour (`SessionResetPolicy` is an inert type; "time never does" replace a conversation).

Rejected: keeping the hub-stored form (it changed nothing); writing through `ProfileSettings`
(the same keys would have two homes, and the agent form is where ADR 0002 puts an agent's
settings); a hub-side store for pending writes (Hermes already keeps them, and its `/memory` and
`/skills` commands answer the same records); removing `ProfileSettings.privacy` outright (breaks
generated clients for no gain now).

## 59. Webhooks receive a catalogue of the hub's events, queued, signed and retried

2026-09-25, with `notify.redeliverWebhookDelivery`. Until now a webhook received only the test
delivery (§42 named the header; nothing sent events). Proposed here — owner to confirm:

- **The catalogue is in the contract, and it is a choice, not every realtime event.**
  `WebhookEventName` lists fourteen events — `run.completed`, `run.failed`, `run.cancelled`,
  `approval.requested`, `approval.resolved`, `task.created`, `task.moved`, `task.assigned`,
  `schedule_run.completed`, `schedule_run.failed`, `workflow_run.completed`,
  `workflow_run.failed`, `step.waiting` (a workflow waiting for a person) and `notice.created` —
  and its `x-webhook-events` gives each one's realtime source, description (ar/en) and content
  fields. `notify.listWebhookEvents` serves exactly that (it used to serve every `x-rt-events`
  name, deltas and typing included); `WebhookWrite.events` refuses any other name (`400`). A
  stored name from before is kept on the webhook and never fires.
- **The body is `WebhookPayload`**: `{id, event, profile, occurred_at, content_included, data}`,
  where `data` is the realtime event's `payload` as its schema in `events/` defines it. `id` is
  the event at this webhook and stays the same on every retry and redelivery, so a receiver can
  drop a repeat. Headers: `X-CoreHub-Signature: sha256=<hex>` (with a secret), `X-CoreHub-Event`,
  `X-CoreHub-Delivery` (the delivery id). The top-level `webhooks.hubEvent` describes the request.
- **Content is left out by default.** With `include_content: false` (the default) the paths the
  catalogue lists are removed from `data` — the final message of a run, an approval's title,
  description, command, choices and answer, a task's title, description, summary and reasons, a
  scheduled run's output, a workflow run's input, a notice's title and body — so ids, states,
  times and usage remain. With it on, `data` is the payload whole and valid against its schema.
- **Who receives what.** A webhook's `profiles` lists where its events come from; empty means
  every profile **its creator may enter**, and that is checked at each event, so a webhook is
  never a way to read a profile its creator cannot open. Naming a profile the caller cannot enter
  is `400 bad_request` with `details.reason = profile_not_allowed`.
- **Delivery is a queue in `webhook_deliveries`.** An event writes one `queued` row per webhook
  and returns; a timer sends what is due, up to ten at a time. A failed attempt (anything but a
  `2xx`, a redirect, no answer within 10 s, or an address that now resolves somewhere private) is
  `failed` with `next_attempt_at` set, retried after 30 s, 60 s, 120 s … doubling, at most one
  hour apart, `max_retries` times (default **5**, 0–10); then it is `dead`. The row is leased
  (its `next_attempt_at` pushed past the deadline) while it is sent, so a hub that stops mid-send
  retries it after starting; what was due at a restart is sent after it.
- **The address is checked at every attempt** and the socket connects to the address that was
  checked (DNS rebinding), not to a second lookup; redirects are not followed.
- **Redelivery**: `POST /notify/webhooks/{id}/deliveries/{delivery_id}/redeliver` queues a new
  delivery with the same body and answers it (`202 WebhookDelivery`); only a `dead` one or a
  `failed` one with no retry pending (`409 state_invalid` otherwise). `WebhookDelivery` gains
  `next_attempt_at`. The test delivery takes the same path, once, without retries, with an empty
  `data`.

Not done here: a per-webhook timeout (the 10 s is the hub's; a setting would need a column), and
`task.moved` from the board's move route still carries only `task` (its schema also requires
`from`, `to` and `actor`) — a tasks fix of its own.

Rejected: forwarding every realtime event (a webhook subscribed to `message.delta` is a flood,
and a generic list could not say which fields are content); a generic key blacklist for content
(it would miss fields and remove harmless ones); retrying in memory only (a restart would lose
what was waiting).

## 60. A session category is the profile's, shared like its conversations; moving is a session patch

The contract has declared `session_categories` since the start (`SessionCategory`, four
operations, `Session.category_id`, `sessions.list?category_id=`), but no module built them and
every call answered `501`. It did not say whose a category is, what `position` does when two
categories want the same place, or what `session_count` counts. Proposed here — owner to
confirm:

- **The profile's, not the person's.** A category belongs to the profile it was made in and
  everyone who may enter that profile sees, uses, renames and deletes it — the same rule as the
  profile's conversations, which are not per person either. `owner_id` is who made it. A
  category per person would need `Session.category_id` to differ per viewer, and the contract has
  one field on one shared session: two people filing the same conversation would overwrite each
  other. Whether a group is **collapsed** is the viewer's own and stays in the client.
- **Moving is `sessions.update` / `sessions.bulkUpdate`** with `category_id` (a category of the
  session's own profile) or `null` (out of any). A category the profile does not have — another
  profile's, a deleted one, a made-up id — is `404 not_found` (`details.resource =
  session_category`), never a silent drop. `sessions.create` checks the same. A fork keeps its
  parent's category.
- **Order is `position`, always `0…n-1`.** Create puts a category last, or at `position` when
  given; `updateCategory` with `position` moves it there (past the end is the end) and renumbers
  the rest; deleting closes the gap. Clients reorder with one patch per move.
- **Names are unique per profile** (trimmed, case ignored): a second «الإطلاق» is `409
  conflict` on create and on rename — `updateCategory` now documents its `409`. A profile holds
  at most 100 (the list is not paged), the 101st is `409`.
- **`session_count` counts the conversations in it that are not archived** — what the list
  shows by default.
- **Deleting keeps the conversations**: each one in it, archived ones too, loses its category and
  is announced with `session.updated`, so every open list moves it back among the rest.
- **Across profiles** (ADR 0016): `listCategories?profiles=all` lists every profile the caller
  may enter, each profile's categories in its own order, each naming its `profile`. A client
  showing every profile at once offers a conversation only the categories of its own profile.

Rejected: a `session_category.*` realtime event (another person's new category shows at the next
fetch, which is enough for a rare change; the moves themselves already travel as
`session.updated`); a separate `moveSession` operation (the patch already carries the field, and
`bulkUpdate` moves many at once); per-person categories (above).

## 61. Channel conversations are Hermes's, read through its server, never copied into the hub

Telegram, WhatsApp and the other messaging channels reach the agent through Hermes's gateway,
and Hermes keeps those conversations in its own session store (`state.db` of each profile); the
hub never sees them. The chats list had groups «تيليجرام» / «واتساب» (§60) with nothing to put
in them. Proposed here — owner to confirm:

- **Read, not copied.** Two operations read them from Hermes's internal server (ADR 0015) the
  way Hermes's own desktop app does — `GET /api/sessions?profile=&sources=…&order=recent` and
  `GET /api/sessions/{id}/messages` (`hermes_cli/web_routers/sessions.py`, `v2026.9.14`):
  `sessions.listChannelConversations` (`GET /channel-conversations`, `profiles=all` across every
  permitted profile as ADR 0016, `channel=` to narrow) and `sessions.listChannelMessages`
  (`GET /channel-conversations/{id}/messages`). They are **not** `Session`s: a new
  `ChannelConversation` (Hermes's id, profile, platform, the other party's name and id, chat
  type, the latest message, Hermes's preview, count, times) and `ChannelMessage` (the person's
  and the agent's text; tool calls, tool results and system text left out). Copying them into
  the hub's tables would make two stores of one conversation that drift, and the hub cannot
  write to Hermes's side anyway.
- **Read-only.** Nothing writes to Hermes; the reply is made on the channel. The web opens one as
  a transcript in the chat's look, with «محادثة من تيليجرام — للقراءة فقط؛ الرد يكون من
  تيليجرام» where the composer would be.
- **Which sources are channels**: `telegram`, `whatsapp` (and `whatsapp_cloud`, shown as
  `whatsapp`), `discord`, `slack`, `signal`, `matrix`, `mattermost`, `email`, `sms`,
  `dingtalk`, `feishu`, `wecom`, `weixin`, `bluebubbles`, `qqbot` — Hermes's messaging
  platforms. The TUI the hub's own chats run in, `cli`, `api_server`, `webhook`, `cron` are not,
  so a hub chat is never listed twice, and asking for one by id here is `404`.
- **Up to 100 per profile**, Hermes's own page cap, most recent first; Hermes's archived ones are
  left out, and the list shows them in the active and "all" views, not in the archive.
- **Where they cannot be read, the list says why** — still `200`, with `unavailable[]` per
  profile: `hermes_not_managed` (the hub does not supervise Hermes, so there is no server to
  ask), `profile_not_in_hermes`, `hermes_unreachable` (with Hermes's words; what was read before
  is still listed). Opening one then is `503 service_unavailable`.
- **Kept briefly, asked again when Hermes's store changed.** The hub keeps what it read per Hermes
  profile and asks again only when that profile's `state.db` / `state.db-wal` changed size or
  time since, never sooner than 5 s, and at the latest after 5 minutes; with no store to compare,
  after 20 s. The latest message of each conversation is read once per change (20 per call at
  most; the rest show Hermes's preview meanwhile). So a list polled while it is open costs Hermes
  nothing while nothing happens, and Hermes's server still stops after its 10 idle minutes.
- **Polling, not an event.** Hermes announces nothing when a channel message arrives (its
  `/api/events` is the dashboard chat's own channel), so the web asks every 45 s while the list is
  on screen and the tab visible, and every 30 s while a transcript is open.

Rejected: a realtime event fed by the hub polling Hermes in the background (a server loop for
every profile whether or not anyone is looking); reading `state.db` directly (Hermes's private
schema, which ADR 0015 chose not to depend on); showing them as `Session`s with `source: channel`
(every operation on a session — rename, archive, run, delete — would have to refuse them).
Not built: "Continue in Core Hub" (a hub chat seeded with the transcript as context) — proposed
as the next step.

## 62. "Continue in Core Hub" is a new chat whose first message carries the transcript

§61 left a channel conversation read-only and named "Continue in Core Hub" as the next step.
Proposed here — owner to confirm:

- **`sessions.continueChannelConversation`** (`POST /channel-conversations/{id}/continue`, body
  `{agent_id, note?}`) reads the conversation from Hermes as `listChannelMessages` does (the
  latest 500 messages), keeps its transcript as a Markdown attachment of the caller's, and makes
  an ordinary `chat` session in the same profile with that agent, titled "<channel>: <the other
  party>" (a title the agent's own naming does not replace). It answers `201` with the
  `session` and `first_message`. The channel conversation is not touched.
- **The context is the first user message, not a system message.** An agent only ever receives
  the prompt of the turn it is running (`AgentRunRequest.prompt`) and its own session; a system
  or context message written into the hub's transcript without a run would never reach it. So
  the first message is a `text` block — a factual summary in the caller's language (the channel,
  the other party, how many messages, over what time, "the full transcript is in the attached
  file; read it first"), then the person's note — and a `file` block with the transcript, which
  the hub puts in the run's input folder like any attachment.
- **The hub does not send it; the client does.** A run started by the hub before the client
  watches the chat would stream to nobody (a new chat's first message waits for the
  subscription for the same reason), so the answer carries `first_message` and the client sends
  it as the chat's first run as soon as it is listening. A client that never sends it leaves an
  empty chat, as a new chat nobody typed in does.
- **The summary is facts, not a model's summary** — no extra turn to pay for, nothing to get
  wrong; the agent reads the whole transcript in that first turn.
- **The web picks the profile's Hermes** (the agent the channel was talking to), or the first
  agent that can answer; the dialog takes an optional note ("what should the agent do with it?").

Rejected: copying the messages into the new chat's transcript (the agent would not see them, and
the chat would claim turns nobody ran); a system message (the same, and the contract has no
system role a client could send); forking into Hermes's own channel session (the hub cannot write
there, §61); starting the first run on the hub (lost opening deltas).

## 63. Voice in the web: dictation through the hub's STT, replies read through its TTS

`models.transcribe` was declared since the first contract and answered a documented `501`,
because the hub had no multipart reader where the models module could use it. It has one now
(the `knowledge` module's), so the operation is built. Proposed here — owner to confirm:

- **The recording is never kept.** `models.transcribe` reads the `audio` part (≤ 25 MB,
  Whisper's own ceiling; `413` above it) and the optional `language`, `provider_id` and — new
  and additive — `duration_ms` fields in whatever order the client wrote them, sends the audio
  to the profile's chosen STT provider (its own row of the same slug over a shared one, as the
  speech tabs resolve `ready`) and answers `Transcription`. `duration_ms` is the provider's own
  figure when it reports one, else the client's, else 0.
- **Every failure is named.** No provider chosen: `422 agent_unavailable`,
  `details.reason: no_stt_provider` (the web links to Models → Speech to text). A provider
  switched off: `provider_disabled`. The provider refused or answered nothing usable: its
  reason (`unauthorized`, `unreachable`, `http_error`, `no_key`, `unsupported`) with its own
  words in `details.detail`. A silent take: `400 validation_failed`, `details.reason: no_speech`.
- **One protocol for now: the OpenAI-shaped `audio/transcriptions`** (OpenAI, Groq, and any
  self-hosted OpenAI-compatible speech server). A custom endpoint added as a speech provider
  needs no key — it is asked without one, like a custom chat endpoint (§26) — for both
  transcription and `models.synthesize`.
- **No streaming.** Neither side streams: the web's voice mode is turn by turn (record → one
  transcription → the run streams its reply → the reply is spoken sentence by sentence as the
  text arrives) and says so on the stage.
- **Where the web's voice settings live: `Preferences.voice`, unchanged.** The web keeps
  `dictation_language` (`auto`, `ar`, `en`) and `auto_speak` there. It uses the hub's STT and
  TTS whenever the profile has them ready and falls back to the browser's own recognizer or
  voice only when it does not, marked as such on screen; `input_mode` / `output_mode` stay the
  phones' switch — a browser's recognizer is often a cloud service of the browser's vendor, so
  calling it "on the device" would mislead.

Rejected: a streaming transcription socket (no provider in the catalogue streams through an
OpenAI-shaped surface, and the phones do not need it yet); storing the recording as an
attachment first (a dictation is not a file of the conversation, and would outlive the words).

## 64. Messaging platforms are declared once; linking one is its credentials, checked where the platform can say

2026-09-25, the owner: link more messaging platforms from the Channels page, like Telegram (§41).
Proposed here — owner to confirm:

- **`agents.listChannelPlatforms`** (`GET /agents/{agent_id}/channel-platforms` →
  `ChannelPlatformList`) is the hub's catalog: for each platform its `login` (`qr`, `token`,
  `credentials`), the `credentials` it takes keyed by the environment variable Hermes reads,
  the allowlist variable, and flags a client needs to draw the dialog honestly — `validates`
  (the hub asks the platform first), `pairs` (linking switches pairing on), `allowlist`
  (Hermes drops strangers, so nobody is answered until listed), `settings`, `exclusive`,
  `packages` (`image`, `first_use`, `none`), `inbound` (needs a public address). Labels and
  setup steps are the client's, keyed by platform and variable, as §41 does for settings.
  `support: full` platforms (Telegram, WhatsApp, Discord, Slack, Matrix, Mattermost, Email) are
  checked, named and have settings; `generic` ones are stored as given.
- **`agents.linkChannel` takes `credentials`** beside Telegram's `token` (`ChannelTokenLink`:
  `token` is no longer required; one of the two is). Refusals are named:
  `credentials_invalid` (a required variable missing, a wrong shape or an unknown one;
  `details.field = credentials.<KEY>`), `credentials_rejected` (the platform refused;
  `details.field`, `details.platform` and its words in `details.message`),
  `platform_unreachable` (`503`, `details.platform`), and §41's `token_in_use` with
  `details.platform` for the platforms one process may hold. `allowed_users` items are the
  platform's own ids (`^[^,\s]{1,320}$`), checked per platform by the hub.
- **`Channel.login` gains `credentials`**, and `ChannelLink` covers these platforms: the account
  the platform named when it was linked (`account_username` is the handle without an @: the
  Discord, Slack or Mattermost bot's user name, the Matrix user id; for Email `account_name` is
  the address). A variable replaced by hand is never named after the account it replaced: the
  hub's note is kept with a digest of the credentials and used only while they match.
- **`agents.unlinkChannel` and the settings operations** cover them: unlink removes the variables
  the platform declares and switches the channel off, keeping the allowlist and the settings;
  `getChannelSettings` / `updateChannelSettings` describe Discord's, Slack's, Matrix's,
  Mattermost's and Email's options with §41's `ChannelSetting` shape, and the same `key` means
  the same thing on every platform.

Rejected: a schema per platform in the contract (Hermes adds platforms and variables between
releases; §41's reasoning); letting the hub create Discord or Slack apps (their consoles require
the person's own account); and pretending Discord and Email pair — Hermes's adapters drop a
stranger there before the gateway could send a code, so the client asks for the allowlist up
front instead.

## 65. A profile's working files are managed inside its folder only, by its owner and admins

Agents work in `${DATA_DIR}/workspaces/<profile>/…` — a folder per conversation, one per task —
and until now a person could not see those files from a client. Proposed here — owner to confirm:

- **Eleven operations under `knowledge`** (`/workspace-files…`): list a folder, download a file,
  download a folder as a zip, read text, save text, upload, new folder, move (rename is a move
  in the same folder), copy, delete, and attach a file for a chat. `knowledge` already owns files
  and the attachment registry the last one writes into. Owner and admin only (`x-roles`), in the
  profile of `X-Hub-Profile`. A file manager, not a shell: nothing here runs a program.
- **Paths are relative to the root, `/`-separated, `''` the root.** An absolute path, a NUL byte,
  a `..` that climbs out, or a symlink — on the way or as the entry — that leads outside the root
  is `400 validation_failed` with `details.reason` (`absolute`, `invalid`, `outside_root`,
  `symlink_outside`). Work happens at the real path; a link inside the root is read through, a
  link is deleted and moved as a link, never written through (`reason: symlink`). Files are
  opened `O_NOFOLLOW` and the descriptor's path is re-checked. The root cannot be deleted or
  moved (`reason: root`), a folder not into itself (`into_itself`).
- **Caps, in `WorkspaceFileLimits` on every listing:** upload and attach 25 MB (the one-shot
  attachment ceiling), text editing 1 MiB of UTF-8 (`415` for a binary or non-UTF-8 file), zip and
  folder copy 200 MiB of file bytes or 20 000 entries, refused `413` before anything is written or
  sent. A listing shows at most 5000 entries (`truncated`).
- **Save conflicts by etag.** `readWorkspaceText` answers a strong etag (a hash of the bytes, not
  the mtime); `writeWorkspaceText` must send it back and is `409 conflict`
  (`details.reason = changed`, `details.etag` = the current one) when the file changed, writing
  nothing. `etag: null` creates a file and is `409` (`exists`) when one is there.
- **Nothing an agent wrote is served as a page.** `downloadWorkspaceFile?disposition=inline`
  shows only pictures (not SVG), PDF and plain text in place; everything else goes out as
  `application/octet-stream` with `nosniff` and a `sandbox` CSP.
- **Attach copies.** `attachWorkspaceFile` makes an ordinary attachment (`purpose: message`,
  `meta.workspacePath`); later edits to the working file do not change it.
- **Every write is audited** (`workspace_file.created|written|uploaded|folder_created|moved|copied|deleted|attached`, and `zipped`).

Rejected: a generic "file system" endpoint taking absolute paths (the boundary would be the
client's); letting members in (a member's conversations are in the same folder as everyone's in
the profile, so per-person visibility would need per-session folders owned by people — a later
ADR if wanted); following links out "because the agent made them" (a link to `/data/keys` is
exactly what must stay closed); an mtime etag (two writes in one second would look the same).

## 66. Push is the devices module's: Web Push with the hub's own keys, FCM and APNs when the owner gives credentials

The phone and desktop apps poll because nothing could push to them: all seventeen `devices`
operations answered `501`, and quiet hours were stored but silenced nothing. Proposed here —
owner to confirm:

- **notify decides whether, devices decides how.** A notice written to the inbox is handed to
  the push port unless the kind's `push` switch is off or the moment is inside the person's
  quiet hours (the `*` preferences row). `devices` sends it to every linked device of the
  person with a push registration and answers per device; `notify` records one
  `notification_deliveries` row each. Neither module imports the other: the composition root
  lends the port (`auth` already imports `devices`, so `devices` takes its guards and token
  revocation the same way). The `push_credentials` table moves from `notify` to `devices`
  (same table, no migration): the credentials belong to the senders.
- **One payload for every client**: `{ type: "notice", notice_id, kind, title, body, profile,
  resource }` — the Web Push body (encrypted), the APNs payload beside `aps`, and FCM `data`
  (strings: `resource_kind`, `resource_id`). A client opens `resource` the way the inbox does.
- **Web Push needs nothing from anyone.** The hub makes a P-256 VAPID key pair on first use in
  `${DATA_DIR}/keys/vapid.json` (0600, beside the data key) and never rotates it — replacing it
  orphans every subscribed browser. `devices.getPushConfig` gives the public key.
  Encryption is RFC 8291 `aes128gcm`, written from the RFC and checked byte for byte against its
  Appendix A; VAPID is RFC 8292 with a 12-hour token and `COREHUB_PUSH_CONTACT` (or the Settings
  `subject`, default the project's URL) as `sub`.
- **FCM (HTTP v1) and APNs (HTTP/2, provider token)** are built and tested against fakes, and
  stay off until the owner gives credentials: in Settings (`devices.setPushSender`, sealed with
  the data key, read back as `[stored]`) or the environment (`COREHUB_FCM_SERVICE_ACCOUNT`,
  `COREHUB_APNS_KEY_ID` / `_TEAM_ID` / `_BUNDLE_ID` / `_KEY` / `_ENVIRONMENT`), which wins —
  Settings then answers `409`. `devices.listPushSenders` names what each one is missing.
  `registerPush` for a sender that cannot deliver is `409 sender_not_configured`.
- **A token is forgotten only when the service says it is dead** (Web Push 404/410, FCM
  `UNREGISTERED`, APNs 410 `Unregistered`). APNs `BadDeviceToken` / `DeviceTokenNotForTopic`
  are reported and kept: both also follow from a wrong environment or bundle id in the hub's own
  settings, and wiping every phone's token over that would be worse.
- **A browser is a device.** `devices.register` (`POST /devices`) registers a client that is
  not a paired app — a browser, the desktop app signed in with a web session — under a
  `device_key` it keeps; the same key is the same row. A paired app answers `409` (it is
  already a device), and a browser cannot take a paired app's key. Push to a paired device is
  registered by that device's own token only; a browser's by its owner.
- **Who may act on a device**: its owner, the device itself, or an admin (the contract said
  "the device itself, or an admin" for `update`; renaming your own phone from the web is the
  common case). Someone else's device is `404`, not `403`.
- **Web Push endpoints are checked like webhooks** (notify's address rule): `https` and not a
  private address, at registration and again before each send.
- `notify.sendTestNotice` writes a real `system` notice through the same path (preferences
  included; `409` when the person turned `system` off), and `devices.testPush` sends to one
  device and says what the service answered — the two ways an owner checks a sender.

Rejected: a third-party Web Push library (a dependency for about a hundred lines the two RFCs
specify; the RFC's own test vector is the proof); keeping push credentials only in the
environment (ARCHITECTURE invariant 5: the rest is set from the UI); ntfy in this change — it
needs a new `push_provider` value and so a migration, while every open PR is racing for
`0016`; it is the next step if the owner wants a no-Google Android path.

## 67. The hub serves its own tools to its agents over MCP, as the person whose run it is

An agent in Core Hub could not drive the hub: it did not see the board, could not schedule, read
its profile's conversations or tell the person anything. The hub now offers itself to its agents
as an MCP server, in groups — `tasks`, `schedules`, `conversations`, `notifications`,
`workflows`, `files` — switched per profile on the agent's MCP page ("Core Hub tools").
Proposed here — owner to confirm:

- **Streamable HTTP on the hub's own port, not a stdio command.** `agents.hubMcp`
  (`POST /api/v1/hub-mcp`) takes one JSON-RPC message and answers it as `application/json`
  (a notification: `202`, no body). Hermes runs beside the hub (ADR 0008), reaches it on the
  loopback, and already speaks HTTP MCP with headers; a `corehub mcp` stdio command would need
  Node and the CLI in every agent's environment and a process per connection, and would still
  have to call the hub's HTTP API to act. No session id, no server stream: the hub pushes
  nothing, and every call stands on its own.
- **Written into the profile, marked as the hub's.** Switching it on writes one block named
  `corehub` into the profile's Hermes `config.yaml` (`url`, `headers.Authorization: Bearer
  ${COREHUB_MCP_TOKEN}`, a comment above it saying whose it is) and a fresh key into the
  profile's `.env`; Hermes fills the header from that profile's own `.env`, so the key is never
  in the config a profile export carries. The block is put back at every boot if it drifted
  (a new key when the old one is gone), removed when switched off (the key then stops working),
  and the generic MCP routes refuse to edit or delete it (`409`, `details.reason = mcp_managed`).
  A coding agent over ACP gets the same server in `session/new` when it says it can reach an
  HTTP MCP server (`agentCapabilities.mcpCapabilities.http`).
- **The key names the profile; the live run names the person.** Hermes keeps one MCP
  connection per profile and says nothing on a call about which conversation made it, so no
  per-conversation token can ride on the wire. Instead every run the hub starts opens a lease
  and mints a **run token** for its owner, revoked when the run ends; `initialize` and
  `tools/list` need only the key, `tools/call` needs a live run in the key's profile and goes
  through the hub's own routes with that run's token — the same validation and permission
  checks as REST. With runs of several people live at once, the run whose agent just announced
  a call to one of the hub's tools (`mcp__corehub__…`, or through Hermes's `tool_call` bridge)
  decides; still unclear after two seconds, the call is refused (`hub_tools_run_ambiguous`)
  rather than guessed. No live run (a message arriving from a channel, the hub's title question)
  is refused too (`hub_tools_no_live_run`). A refusal is a tool result with `isError: true` and
  the hub's code, never an HTTP error, so the agent reads why.
- **That person, that profile, never an admin.** A run token enters only its run's profile
  (a header naming another, or `profiles=all`, reaches no further), holds the scopes `read` and
  `write`, and its role is `member` whatever the person's — every admin-only route refuses it.
  The person is re-read on every call: disabled, or no longer a member of the profile, and it
  stops. `notifications.notify` (no REST operation) writes only to the run owner's inbox; the
  `files` tools stay under `${DATA_DIR}/workspaces/<profile>` and follow no link out of it.
- **Off by default; on, read only.** Nothing is offered until an admin switches it on. On, every
  group reads and none writes; each group's writes (create/move/assign/comment a task, create,
  pause or run a schedule, notify, run a workflow, write a file) are a second switch. A group
  switched off is refused at the call at once; Hermes's tool list follows when its next
  conversation starts (the hub retires the TUI gateway so the next one reads the block afresh).
- **The last calls are shown, not audited.** The newest 200 calls per profile are kept (tool,
  outcome, the hub's code, the person and conversation acted for); the card shows 20.

Rejected: a static per-profile key acting as the admin who switched it on (an agent would act
beyond the person whose conversation it is); a key per conversation in the header (Hermes shares
one connection per profile, so it would be the first conversation's for all); acting as the
least-privileged of several live people (right permissions, wrong name on everything it made);
the `browser`, `devices` and `usage` groups the observer mentioned as possible (no operation to
map them onto yet — a later group, not a gap in this one).

## 68. Catalog agents are checked against the registry every six hours; the pin stays the tested baseline

ADR 0006 made the catalog's pin the only version the hub installs, and `latest_version` was
that pin, so "update available" could only ever mean "older than the pin". A curated catalog
that moves only when a pull request moves it leaves every installed agent months behind its
own fixes. Proposed here — owner to confirm:

- **The pin is the tested baseline.** A fresh install still takes exactly the catalog's pin.
  `AgentInstall.pinned_version` (new, required) names it; `null` for Hermes and the hub's own
  agent.
- **The registry is asked, never installed from on its own.** Every six hours, and on
  `agents.checkUpdate`, the hub reads the newest stable version of each agent it installed —
  npm's `latest` dist-tag or PyPI's JSON; a pre-release someone tagged `latest` is not
  offered — and records it as `latest_version`, never older than the pin.
  `update_available` compares versions numerically. `checkUpdate`'s result gains
  `pinned_version`; an unreachable registry fails the job (`service_unavailable`) instead of
  answering "up to date".
- **An update installs an exact version.** `agents.upgrade` installs `latest_version` as
  `package@x.y.z`, never the moving tag; an agent with a companion package (Pi's ACP adapter)
  moves it to its own newest release. `AgentInstall.newer_than_tested` (new, required) is true
  when the hub-installed version is past the pin, and clients say «أحدث من النسخة المختبرة» /
  "Newer than the tested version".
- **Auto-update is per agent, off by default** (the existing `auto_update`). It takes an
  update only while no run of the agent is in flight, retrying a busy agent ten minutes
  later; it is filed as a job under the default profile and audited as `system`. While any
  update runs, a turn asked for waits for it (at most 15 minutes) instead of starting on a CLI
  being replaced, and the agent's open sessions are closed afterwards so the next turn starts
  the new CLI.

Rejected: installing `latest` on every install (a new release would reach every box untested,
the day it ships); a global switch (the per-agent `auto_update` already exists and an agent
that breaks on updates should not hold the others back); pausing new runs by refusing them
(`409`) during an update (a person would have to retry by hand what a short wait answers).

## 69. A room is its members'; a message that names nobody goes to the lead seat

Proposed — owner to confirm (rooms were "later"; built on the owner's «كمل كل الشغل», 2026-09-25).

- **Who sees a room.** A room lives in one profile and belongs to its members: the person who
  made it (`role: owner`, who manages it — `can_manage`, the invite code, seats, archive,
  delete) and whoever joined by its code. Anyone else, an admin included, gets `404`, the same
  answer as for a room that does not exist. `rooms.list` lists only the caller's rooms.
  Rejected: every room of a profile visible to everyone in it — a room is a conversation, and
  people expect a conversation they were not invited to to stay closed.
- **Invite codes.** Eight characters of `[A-Z2-9]` without `I`, `O`, `0`, `1`; the link is
  `<hub>/join/<code>` (§23). A code opens a room only for someone who may already enter its
  profile; for anyone else it reads like no code at all. A code never grants a profile.
  Joining twice answers the room again (`200`), not an error; an archived room refuses
  joining and posting with `409 state_invalid`. `room.created` goes to its maker's sockets
  only, because a new room carries its invite code.
- **Who answers.** The seats a message mentions (structured `mentions`, §23), every seat for
  `@all` when `can_mention_all` (`400` otherwise), and **the room's lead seat when it mentions
  nobody** (`Room.lead_seat_id`: the first seat added, changeable, `null` = nobody). This
  replaces the earlier description ("every seat when `can_mention_all`") — a room with three
  agents that all answer every sentence is noise; one default responder is what a chat with
  one agent already does.
- **Archiving** is `RoomPatch.archived` (and `rooms.list?archived=true`), not a new
  operation; the transcript stays readable.
- **A seat** is an agent with its own name (unique in the room ignoring case, `all`
  reserved), role (`description`), instructions and model, and a conversation of its own in
  `sessions` (source `room`, origin the seat) opened when the seat is added — so an agent that
  cannot take turns is refused before the seat exists (`404` / `422`), and the chats list
  leaves those conversations out. A removed seat leaves the room; its past messages keep its
  name. A room message is the one `Message` (§1): a person's or the hub's message carries the
  room's id as `session_id` (a room is not a session), a seat's reply its seat's session.
- **The web** draws the person's own messages on the right and everyone else — people and
  agents — on the left, each named, because in a room "the other side" is several speakers.
- **Agents in the room (part 2).** A turn is a run in the seat's own conversation, and its
  prompt is the room as that seat has **not** seen it: who it is, its role and instructions,
  the other agents and people, how to pass the turn, the room's summary, and the messages
  after its last turn from anyone but itself — at most the newest 30 and about 12,000
  characters, saying how many older ones were left out (the seat's conversation already holds
  what it was shown and said before). The reply is a room message opened at once
  (`status: streaming`, so the room shows who is about to answer) and filled from the seat
  session's stream, re-emitted on `/rt/rooms` against that message (`message.delta`,
  `reasoning.delta`, `tool.*`, `approval.*`; `run.*` with `room_id` set). `Seat.status` says
  `queued`, `thinking`, `running` or `waiting_approval` while it works.
- **Handoffs.** An agent writes text, not structured mentions, so its reply is read for
  `@Name` of another seat — whole names, longest first, never inside code, never itself — and
  the first one found takes the next turn when the room allows handoffs. A chain starts with
  the first pass after a person's message; `depth` counts the passes made. The guard stops it
  (`status: stopped`) at a loop — the same pass (from → to) twice in one chain — or when the
  next pass would exceed `max_depth` (`null` = no cap; the default is 3). A stopped chain may
  go one more round, once (`continueHandoff`, `409` after that). A chain completes when a reply
  passes nothing on and fails when a turn fails.
- **Stop and forget.** `stopSeat` cancels the seat's running and queued turns and stops its
  chains as `interrupted`; the reply says `interrupted`. `clearContext` keeps the messages,
  gives every seat a fresh conversation (the old one archived) that is shown nothing before
  this point, and resets the summary and `total_tokens`. A restart closes replies it left
  streaming and stops chains it left active.
- **The room's summary (part 3).** Every seat turn carries the room's summary; it is rewritten
  when `summary_policy.every_turns` finished messages are not yet covered by it (`0` = never on
  its own), when the manager asks (`refreshMemory`, a job of kind `run` whose ending arrives as
  `memory.updated`; `409` while one is running), or by hand (`putMemory`). **The lead agent
  writes it**, asked one question outside any run (the surface that names a chat), with the
  summary's model when the room names one; when that agent has no such surface, gives up or
  fails, **the hub writes it itself** — the previous summary and one line per new message,
  keeping the newest 4,000 characters. `summarized_turn_count` counts the messages it covers.
- **Task progress in the project's room** (ROADMAP Phase 1). A project whose
  `report_room_id` names a room gets a line from the hub (`author.kind: system`) there when one
  of its tasks' runs starts and when it ends — finished with the agent's last words, blocked
  with the reason, or stopped — in the language of the person who started it. Nothing is said
  into a room that is gone or archived. The web links a project to a room from the room's
  settings.
