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
marked `x-scope: global` and ignore the header (the notify webhooks read it when sent: §115).

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

> The second entry numbered 26 here — *Changing a conversation's agent is a fork; changing its model is a patch*, with *The hub names a session, unless a person did* — is now **§92** (renumbered 2026-09-27; code and records that say “§26” for forking or naming mean §92).

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
  name, and its models are the ones Hermes lists for it. (Amended by §118: the `direct` agent now
  borrows the sign-in from Hermes for one turn.)
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
  needs no key — it is asked without one, like a custom chat endpoint (§27) — for both
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

## 71. Core Hub ships its own skill library, installed into every profile and never written over an edit

Bundled skills (2026-09-25). The owner: «اهم المهارات الرئيسية ولزم يكون فيه شي خاص بالصور».
Core Hub carries a library of its own skills (`packages/server/skill-library/`, Apache-2.0, part of
Core Hub) and installs it into every Hermes profile as the category folder `skills/core-hub/`, which
Hermes lists like its own categories (#91). Added: `SkillSource: library`, `Skill.library`
(`current` | `edited` | `null`), `SkillLibrary` in the `agents.listSkills` answer,
`agents.updateSkillLibrary` (`PATCH /agents/{agent_id}/skill-library`) and `agents.restoreSkill`
(`POST /agents/{agent_id}/skills/{skill_key}/restore`).

- **When:** at every boot, for `default` and every named profile Hermes has (so a new image
  updates what it wrote, and a profile made outside the hub gets the library), and right after a
  profile is made, copied or imported through the hub.
- **Only what the hub wrote is ever updated.** A manifest in the profile,
  `skills/.core-hub-library.json`, records the SHA-256 of every file the hub put there. A file whose
  bytes still equal the record is replaced by the new version; a file that differs is the
  person's, and the skill is `library: edited` — left exactly as it is, by every later boot, until
  `agents.restoreSkill`. A library skill the person deletes is remembered and not brought back. A
  folder of a library skill's name that the hub did not write is never touched.
- **On by default, off per profile.** The switch is in the same manifest, in the profile, so a
  copy or an export carries it. Off removes the skills still exactly as the hub wrote them and
  releases the edited ones as the person's own (no badge, never updated); on installs the whole
  library again, deleted skills included. Admins only, like writing a skill.
- A library skill is otherwise an ordinary skill: it can be opened, edited, switched off, pinned
  and deleted from the Skills page.

Proposed, owner to confirm: the twelve skills and their names (`image-generate`, `image-edit`,
`image-describe`, `image-convert`, `summarize`, `report-writer`, `data-to-chart`, `research-brief`,
`translate`, `slides-html`, `schedule-helper`, `proofread`); the image skills preferring Hermes's
own `image_generate` / `vision_analyze` tools and falling back to a script whose key comes from
`COREHUB_IMAGE_API_KEY` (Hermes hides its own provider keys from the terminal); background removal
limited to plain backgrounds (no segmentation model in the image); the switch on the Skills page
rather than in Settings.

Rejected: a copy per skill in the hub's database (two truths that can disagree); overwriting on
upgrade (loses the person's edits); marking library skills read-only like Hermes's built-ins (a library
skill is meant to be adapted, and the edit kept); a flag file per skill (one manifest is one atomic write).

## 72. The image model is a role on the chat providers, and the hub hands it to Hermes and the skills

The Models page (2026-09-25). The owner: «موديلات تحويل النص لصوت والصوت لنص تنتقل لتبويباتها ما
نخليها هنا», and an Images tab («الصور») with no image providers of its own: the image model is
picked from the chat providers that already offer one (for example `gemini-3.1-flash-image` behind
cli-proxy-api). Added: `ModelCapability: image_output`, `ModelDefaults.image` and
`ModelDefaultsWrite.image` (`ModelRef` or `null`), and `image` among `ModelDefaults.inherited`.

- **A role, like the chat model.** Stored as the `image` role of the profile's model defaults; a
  profile that chose none uses the `default` profile's — the same model on the provider of the same
  slug this profile uses (§37) — and `null` goes back to inheriting. Only a model with
  `image_output` on a chat provider the hub can draw with is accepted (`400` otherwise): not a
  provider signed in through Hermes (its credential is Hermes's), not Anthropic or Ollama.
- **`image_output`** is the provider's word where it gives one (OpenRouter's output modalities) and
  otherwise the model's id (`image`, `dall-e`, `imagen`, `flux` …), so a catalogue fetched before
  this decision offers its image models too.
- **How it is spoken to** follows the provider and the model: Google's own API (`gemini`); an
  OpenAI-compatible endpoint with an Images-API family — gpt-image, DALL·E, Imagen, FLUX —
  (`compatible`, `/images/generations` and `/images/edits`); any other model that draws on an
  OpenAI-compatible endpoint (`chat`, `/chat/completions` with `modalities: ["image","text"]`, the
  picture in `message.images`).
- **Where it goes.** Into every Hermes home the hub writes (the root for the default profile, each
  named profile's own where it differs), as four variables the hub owns —
  `COREHUB_IMAGE_PROVIDER`, `COREHUB_IMAGE_BASE_URL`, `COREHUB_IMAGE_MODEL`,
  `COREHUB_IMAGE_API_KEY` (the chosen provider's key) — removed when no model is chosen. The image
  skills declare them, which is how Hermes hands them to the terminal; nobody types a key.
- **Hermes's own `image_generate` tool** draws through a backend the hub installs,
  `plugins/image_gen/corehub-images/`, listed in `plugins.enabled` and named in
  `image_gen.provider` (Hermes's MIT source, v2026.9.14: a user plugin loads only when listed; the
  tool calls the backend `image_gen.provider` names). None of Hermes's own backends takes an
  arbitrary OpenAI-compatible address, key and model. The backend runs the same `image_api.py` as
  the skills, reading the four variables through Hermes's secret scope, so the tool and the skills
  never draw with different models. With no model chosen the hub takes back only what it wrote —
  a backend somebody picked in `hermes tools` stays.
- **The picture comes back on the reply** (2026-09-26, found in the first real Hermes turn). Hermes
  saves what `image_generate` draws in its own `cache/images/`, outside the run's output folder, so
  the conversation only had the model's words. The Hermes adapter reports a successful
  `image_generate` answer with a local path as `file.produced`, and the runner copies that file into
  the run's output folder, where the engine attaches it to the reply as an `image` part like any file
  the agent left there. A copy (Hermes's cache stays), never a link, a folder or a file over 25 MB;
  a URL answer (a backend that returns a link) is left to the model's words. No contract change.
- **…and is seen there** (2026-09-26, the owner's «سوي صورة قط يطير» on 1.1.0: `image_generate`,
  then `execute_code` copying the picture into the output folder as `flying_cat.png`, a reply that
  printed `/data/workspaces/…/.corehub/runs/<run>/out/flying_cat.png`, and no picture). The hub had
  attached it; the web never drew a reply's attachments. Now a picture on a message is drawn in it
  (fetched with the bearer header, as every private file is) and any other file is its name, both
  opening the file beside the chat (§48). As the turn ends, the runner removes its own copy of a
  drawn picture when the agent left the same bytes in the output folder under another name, so
  the picture is on the reply once. The prompt's output-folder line asks the agent to name a file
  there by its name only, never by a path; and the web draws a run-folder path in a reply's words
  (`<…>/.corehub/runs/<run>/<in|out>/<file>`, outside fenced code) as `<file>`, which the reply's
  file mentions link — the stored words are untouched. No contract change.
- **Background removal** through the model: `image-edit remove-bg` asks a gpt-image model for
  transparency outright and any other model for the subject on a flat colour, which the bundled,
  model-free `image-convert transparent-bg` then clears. No local model is added to the image.

Proposed, owner to confirm: the id patterns that make a model an image model and pick its protocol;
removing the Providers tab's "Show" filter (with only chat providers left it filtered nothing);
the speech tabs' add button inside the tab rather than in the header (NAVIGATION §3 keeps the
header's two actions on Providers); pure green as the default flat colour for a cut-out; asking
the agent for file names and drawing a run-folder path as the file's name (both, rather than
rewriting the stored reply); removing the hub's copy of a picture the agent kept under its own name.

Rejected: image providers of their own (the owner: there are none — the chat providers have the
models); pointing Hermes at its bundled `openai`/`openrouter` backends (they reach only their own
service, so cli-proxy-api and custom endpoints would not work); a second copy of the image
protocols inside the backend (two implementations drift); keeping `OPENAI_API_KEY`/`GEMINI_API_KEY`
as fallbacks in the skills (Hermes hides them from the terminal, and they would draw with a model
nobody chose).

## 73. The Journey is Hermes's own learning graph, read in the selected profile

`agents.getJourney` was a 501 with a schema for "skills and tools it has used". Hermes already
draws this: its learning graph (`agent/learning_graph.py`), shown by `hermes journey`, its TUI's
`/journey` and its desktop panel, served by its own server as
`GET /api/learning/graph?profile=` (ADR 0015). The hub reads that and renames the fields;
Hermes decides every node, edge and cluster.

- **What a node is**: a skill of the profile that the agent wrote or has used (Hermes leaves out
  its bundled skills and ones nobody used), or one entry of `MEMORY.md` / `USER.md`. So `kind` is
  `skill | memory` — `tool` and `plugin` were never returned and are gone from the enum (no
  implementation or client ever used them). Added, all Hermes's: `state` (its curator's
  `active | stale | archived`), `agent_created`, `memory_source` (`memory | user`; Hermes calls
  `USER.md` `profile`, the hub's memory model calls it `user`, §12) and `learned_at` (Hermes's
  epoch seconds as ISO time).
- **Ids are Hermes's**, unchanged (a skill's name, `memory:<memory|profile>:<n>`), so a later
  edit or delete can name a node the way Hermes's own `/api/learning/node` does.
- **Only where the hub supervises Hermes**, like plugins and pairing: `409 state_invalid`
  `hermes_not_supervised` elsewhere, `journey_is_hermes_only` for another agent,
  `hermes_profile_absent` for a profile Hermes does not have, `503 hermes_api_unavailable` when
  Hermes's server does not answer.

Proposed — owner to confirm: read only. Hermes can also edit and delete a node (a skill is
archived, a memory entry removed); the hub's memory and skills pages already do both, so no
second way is added here. No web page yet: `navigation.json` has no Journey destination, so
drawing the graph is a navigation decision for the owner (Hermes declares the `journey`
section, and the data is there).

Rejected: running `hermes journey --json` (Rich's console printer, and a Python start per
request); the hub computing a graph from its own run history (Hermes already has the answer, and
the numbers would disagree with Hermes's own screens).

## 74. A capability request reaches one device, is answered once, and its result stays in the request

The four `/device-requests` operations were 501; §14 had fixed their shape (a job, fixed error
codes, one location shape) and ADR 0022 sends a hub on a server through them to reach the
person's own computer. What they now do, proposed — owner to confirm:

- **Only the device's own person may ask it**: their web session, or a token of theirs with the
  `device` scope (a run token has only `read`/`write`, so an agent cannot ask yet — that is the
  MCP `devices` group, not built). Anyone else's device, an admin's included, is `404`: an admin
  may not ask someone's phone where it is.
- **One device hears it**: `request.created` goes only to the addressed device's sockets (they
  join `device:<id>` on `/rt/devices`); `request.completed` goes to the person, whose sockets
  include the device's. A device catches up with `listRequests?status=pending`.
- **A capability the device did not declare, or switched off, is declined by the hub** at once
  (`denied`, `unavailable`); the device is not bothered.
- **Answered once, by that device only** (its own token; anyone else `403`); a request that is
  no longer pending is `409 request_not_pending`. `fulfilled` must carry its capability's shape
  (`location`: `latitude`, `longitude`, `accuracy_m`, `captured_at`), else `400`.
- **The job follows the request**: `succeeded` when fulfilled, `failed` when declined
  (`forbidden`), failed, or unanswered by `expires_at` (`timeout_ms`, default 30 s; the request
  becomes `expired`/`timeout`), `cancelled` with the job. **The job carries only
  `{request_id, status}`**: every member of the profile sees its jobs, so a location stays in the
  request, which only the person and the device read.
- **The table is `device_requests`** (migration `0022`), the contract's shape; it replaces
  `device_commands`, a design that was never written to.
- `message.created` is no longer listed on `respondRequest`: nothing writes the answer into a
  conversation yet. When an agent can ask (the MCP `devices` group), the answer goes back to it
  as the tool's result.

Known limit: a hub that restarts while a request is pending leaves that request's job
`running` (the runner has no restart recovery); the request itself still expires on its next
read. No push wakes a device that is not connected; it sees the request when it next connects.

## 75. `audit.getReport` loses its `logs` and `performance` kinds

Since §51 the web's Logs and Performance read `audit.listLogLines` and `audit.getLivePerformance`,
and §51 kept the old kinds "for the CLI and older clients". On 2026-09-26 the Android and iOS apps
moved to the live endpoints too (Android had no Logs or Performance screen; iOS read the old
kinds). Nothing in the repository asks for `logs` or `performance` any more — not the web, the
CLI, the desktop shell or either app — and the apps only talk to hubs of their own version.
Proposed here — owner to confirm:

- **`audit.getReport` answers `usage` and `skills` only.** The `kind` enum (path and
  `AuditReport.kind`) is `[usage, skills]`; asking for `logs` or `performance` is `400`. Both
  kinds are a profile's own, so `X-Hub-Profile` is now the required `Profile` parameter, as on
  every scoped operation. The `q` and `level` query parameters, which only the logs kind read, are
  gone.
- **The minute-by-minute sampler stops, and `performance_snapshots` is dropped** (migration
  `0024`). Its rows fed only the old performance kind; Performance is measured when asked (§51).
  The audit trail and job events the logs kind merged are unchanged — they are still written and
  still read by everything else that reads them.
- Swift and Kotlin clients are regenerated from the contract; the iOS Usage page is the only
  caller left and passes its profile, as it did.

Rejected: keeping the kinds deprecated (a shape nobody calls is a shape nobody tests); keeping the
sampler for a future history screen (history is the live endpoint's `history`, and a table that
fills itself for nobody is waste).

## 76. An agent's picture is a file beside the people's and profiles', one per agent for the hub

`agents.getAvatar` was 501 and `agents.update` refused any `avatar` "until attachments exist"
(Phase 4, done). People and profiles already keep an uploaded picture as a file
(`<DATA_DIR>/avatars/<kind>/<id>`, PNG or JPEG, 512 KB, a data URL in, `docs/domain/auth.md`).
Agents now do the same, proposed — owner to confirm:

- `agents.update` with `avatar: {kind: image, data_url}` stores `<DATA_DIR>/avatars/agents/<id>`
  with `auth`'s own rule (the same decoder); `generated` or `null` removes it. A bad picture is
  `400` and nothing else in the patch is applied.
- The agent reads `avatar: {kind: image, url: /api/v1/agents/<id>/avatar}`, and
  `agents.getAvatar` serves the bytes (`image/png` or `image/jpeg`; the contract's
  `image/svg+xml` is gone — the hub never draws one, the client draws a generated avatar from
  `seed`); without a picture it is `404`.
- **No column, no migration**: whether there is a picture is whether the file is there, and its
  type comes from its first bytes. The registry row is the hub's (global), so the picture is one
  per agent for every profile — as its name is.

No web control to set it yet (no planned surface: the agent card has no edit sheet); the API,
the CLI and the phones can. Rejected: a knowledge attachment (attachments are profile-scoped and
an agent row is not); an `avatar_mime` column (a migration for what the file already says).

## 77. The platform catalog says when a platform needs a program the image lacks; five more platforms

2026-09-25, the owner: one «ربط منصة» button and a picker of every platform Hermes supports,
instead of a long list under the linked channels. Checking every platform against the pinned
Hermes (v2026.9.14, MIT) for the picker found five it has that §64's catalog did not list.
Proposed here — owner to confirm:

- **`ChannelPlatform.program`** (`string | null`, required): the outside program Hermes runs for
  the platform that neither Hermes nor the hub's image carries — Raft's `raft` (its
  `raft agent bridge`) and Buzz's `buzz` CLI. A client says so before the person links it.
  `null` everywhere else. Additive: older clients ignore it.
- **The catalog gains** `photon` (iMessage via Photon: `PHOTON_PROJECT_ID`,
  `PHOTON_PROJECT_SECRET`; its Node bridge is installed with npm on first start, so
  `packages: first_use`), `wecom_callback` (WeCom Callback: corp id and secret, agent id,
  token and AES key; a webhook on port 8645, so `inbound`; `defusedxml` on first start),
  `yuanbao` (Yuanbao: app id and secret; its own access list, so `allowed_users_key` is
  `YUANBAO_DM_ALLOW_FROM`), `raft` (`RAFT_PROFILE`) and `buzz` (`BUZZ_RELAY_URL`,
  `BUZZ_PRIVATE_KEY`), all `generic`. `exclusive` is now true where the adapter takes Hermes's
  platform lock on its identity: LINE, QQ, Yuanbao and Buzz as well.
- The picker's grouping, order and names are the client's (the catalog stays unordered beyond
  `full` first): popular first — Telegram, WhatsApp, Discord, Slack, Email, Teams, Google Chat,
  Signal — then the rest alphabetically in the reader's language.

Left out on purpose: Hermes's `api_server`, `webhook`, `msgraph_webhook` and `relay` (the hub's
own API, webhooks and an experimental connector — not a place people message the agent) and
`a2a` (agent-to-agent; it declares no required variable, so there is nothing to link).
## 78. A coding agent's own config files are edited from the web: one set for the hub, where the agent reads them

The owner, 2026-09-25 (asked in `docs/changes/2026-09-26-twuijri-close-501-stubs.md`, (b)):
«تم» — build one admin page for coding agents' config files, one set shared by every profile, in
the hub user's home where the agents read them. `agents.listConfigFiles`, `getConfigFile` and
`putConfigFile` were 501. Approved by the owner; the details marked *proposed* are ours.

- **Which files: what the pinned version really reads**, checked in each package (the change
  record quotes the evidence), two per agent — its instructions and its settings: Claude Code
  `CLAUDE.md` and `settings.json` under `CLAUDE_CONFIG_DIR` or `~/.claude`; Codex `AGENTS.md`
  and `config.toml` under `CODEX_HOME` or `~/.codex`; Gemini CLI `GEMINI.md` and `settings.json`
  under `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`; Qwen Code `QWEN.md` and `settings.json` under
  `QWEN_HOME` or `~/.qwen`; Kimi Code `AGENTS.md` and `config.toml` under `KIMI_CODE_HOME` or
  `~/.kimi-code`; Pi `AGENTS.md` and `settings.json` under `PI_CODING_AGENT_DIR` or
  `~/.pi/agent`. OpenCode is not listed (not verified). The agent's own variable is honoured
  from the environment the hub hands its agents. The keys are `instructions` and `settings`
  for every agent. A new capability, `config_files`, says an agent has them.
- **An allow-list, not paths.** A `file_key` names one entry of the agent's list; no request
  carries a path. A file or a folder on the way that is a link is followed only while its real
  path stays inside the agent's folder or the home (a dotfiles folder works; a link towards
  `/data/keys` is `409 symlink_outside`, read or written).
- **Owners and admins only** — all three operations (`x-roles`), reading too: a settings file
  can hold keys.
- **Writes are careful**: optimistic concurrency by `revision` (a hash of the bytes; `null`
  creates) — a stale one is `409 changed` with the current revision and writes nothing; JSON
  must parse (comments allowed for Gemini CLI and Qwen Code, which strip them) or `400
  invalid_json` with the parser's sentence; at most 1 MiB of UTF-8 (`413`; `415` for a file
  that is not UTF-8 text); the previous bytes kept under `<DATA_DIR>/backups/agent-config/
  <agent>/<key>/` (the newest ten); written to a temporary file and renamed, keeping the mode
  (`0600` when new); every write audited (`agent_config_file.written`, with both revisions).
  TOML is not checked (no parser in the hub): the agent reports its own error.
- **Proposed — owner to confirm: the image's home moves into the volume.** `HOME=/data/home` in
  the image (made on the first boot of an older volume), so what is edited here — and whatever
  else the coding agents keep in their home — survives an upgrade that replaces the container,
  as every other written file does. npm's cache stays outside the volume
  (`NPM_CONFIG_CACHE=/tmp/.npm`). On the desktop and a native install the home is the person's
  own, unchanged.
- **Web** (proposed): «ملفات الإعداد» / "Config files", an agent-level page (web and desktop,
  not the phones) before Settings, one tab per file with the Files page's editor (Markdown in
  the reading font with each line's own direction, JSON and TOML left to right in monospace),
  Save and Revert, and a note that the files are shared by every profile.

Rejected: a home per profile (the agents do not know profiles; a per-profile `HOME` would split
their logins and caches too, and the owner chose one set); arbitrary paths under the home (the
boundary would be the client's); editing Hermes's files here (its settings, memory and files have
their own pages, §58, §65).

## 79. A message on a channel acts for the person who proved that account is theirs, and for nobody else

The owner, 2026-09-25: «اوافق» to option (b) — a person links their own Telegram and/or WhatsApp
identity to their hub account; a message from a linked identity runs with that person's
permissions, so the hub's MCP tools (§67) act as them; an unlinked sender gets no hub tools and
the agent still chats as today; linking is proven, not typed; unlinking from the person's
settings; an admin sees and removes links. Approved; the mechanism below is ours, proposed —
owner to confirm.

What was observed in Hermes (MIT, v2026.9.14, ADR 0012), in our words: its messaging gateway
loads gateway hooks from the active profile's `hooks/<name>/` (`HOOK.yaml` with the events,
`handler.py` with `handle(event_type, context)`) when it starts. `agent:start` is awaited before
the agent runs a turn, with the sender as the platform named it (`platform`, `user_id`,
`chat_type`, `session_id`); `agent:end` follows the turn and `agent:step` each tool loop. A slash
command Hermes knows fires `command:<name>` after Hermes's own authorization, and a handler
answering `{decision: handled, message}` makes the gateway reply that instead. `/start` is such a
command (a Telegram bot link `?start=<code>` sends it). The sender id is the same one Hermes's
allowlists and pairing use: Telegram's numeric user id, WhatsApp's chat id. MCP headers in
`config.yaml` are filled from the process environment when the profile's `.env` does not name
the variable.

- **The hook is the hub's**, written beside the `corehub` block when the tools are switched on
  (`hooks/corehub/`, marked, removed when off, put back at boot) and the profile's messaging
  gateway restarted to load it. It speaks to `agents.hubChannelEvent`
  (`POST /api/v1/hub-mcp/channel-events`) with the profile's own hub-tools key, read from the
  `.env` of the profile it lives in.
- **Linking is proven with a one-time code.** `auth.createChannelLinkCode` gives the person
  `corehub_XXXXXXXXXX` (ten minutes, once, one per person, in memory, hashed); they send
  `/start <code>` to the bot from the account. The hook hands the code and the sender to the hub,
  which links that account and has Hermes reply in the person's language. The bot must already
  answer the sender (Hermes drops strangers before any hook). An account linked to somebody else
  is refused, not taken over. Telegram and WhatsApp only (`ChannelIdentityPlatform`).
- **One link per account for the hub** (not per profile): a person is the same person in every
  profile, and their memberships already say where they may act. A linked sender's turn in a
  profile they may not enter (or while disabled) acts for nobody (`hub_tools_sender_no_access`).
- **A turn is a channel lease.** `turn_started` opens a lease for the linked person (a run token
  for that person in that profile, as §67's runs have) or for nobody with the reason;
  `turn_ended` closes it; `turn_step` keeps it alive; fifteen quiet minutes end it.
- **A call says which process made it.** The block gains `X-Corehub-Origin:
  ${COREHUB_MCP_ORIGIN}`, and the hub sets that variable in each Hermes process it starts —
  `hub` where its own conversations run (and in a coding agent's `session/new`), `gateway` in
  every messaging gateway. A gateway's call is only ever one of its turns', a hub process's only
  one of the hub's runs': a stranger's message can never borrow a person's live chat, which
  before this change it could (a gateway turn's call while a chat was live was that chat's
  owner's). Unknown origin (a Hermes the hub did not start) may be either, and then a live
  channel turn beside a different person makes the call ambiguous.
- **Refused, never guessed**: a stranger (`hub_tools_sender_not_linked`), a group or forum chat —
  others steer that conversation too (`hub_tools_group_chat`), two different senders' turns live
  in one gateway at once (`hub_tools_run_ambiguous`: a gateway announces no tool calls to tell
  them apart). The agent reads the refusal as a tool result, as in §67.
- **Managing links**: `auth.listMyChannelIdentities`, `auth.deleteMyChannelIdentity` (Settings →
  Account, «حسابات المراسلة»), `auth.listChannelIdentities` and `auth.deleteChannelIdentity` for
  owners and admins (Settings → People). Table `channel_identities` (migration `0025`), removed
  with its person. `last_used_at` is when a message from it last acted as the person.

Rejected: typing an account id (anyone could claim anyone's); per-profile links (the same person
proving the same phone once per profile); acting as the profile's owner for every channel
message (a stranger would act as the owner); guessing among concurrent senders.

## 80. The relay, presets and hub peers stay in the contract, parked

The owner, 2026-09-25, on the rest of the 501 inventory:

- **Relay** (`devices.getRelay`, `devices.setRelay`): «يبقى في العقد، مؤجّلًا». The desktop app is
  to work both ways — connected to a server, or local — and a desktop-local person without a
  server may later want their phone to reach it from outside. That is what the relay is for.
  Options when it is built: the person's own Cloudflare Tunnel, or Tailscale. Not a service run
  for them. Not built now; the operations stay 501. *Built on 2026-09-27: §95.*
- **Presets** (`agents.listPresets`, `getPreset`, `deletePreset`, `activatePreset`) and **hub
  peers** (`devices.listPeers`, `requestPeer`, `updatePeer`, `deletePeer`, `createPeerInvite`):
  «خلها بعدين اخاف تفتحلنا ثغرات» — later; the owner is wary of the security surface they open
  (a preset swaps an agent's whole configuration; a peer is another hub reaching into this one).
  Not built and not deleted; they stay 501 until a decision says what they may do and what they
  may not. *Built on 2026-09-27: presets §100, hub peers §101 (ADR 0026).*

## 81. A device says what it is and what stops its push; a name a person gives it stays

The owner (2026-09-25): a pill that said only "Paired: iPhone" told two phones apart by nothing,
and since iOS 16 every iPhone calls itself "iPhone". Proposed — owner to confirm:

- `Device` gains `os_version` (string or null), `paired_at` (when the row was last paired or
  registered; nullable only so an app reading an older hub still decodes the device) and
  `push_blocker` (`PushBlocker`: `none`, `not_in_build`, `permission_pending`,
  `permission_denied`, or null when the device never said — an older app, a browser).
  `DeviceRegistration` (pairing, `devices.register`) takes `os_version` and `push_blocker`;
  `DevicePatch` takes `brand`, `model`, `os_version` and `push_blocker` beside `app_version`. All
  optional: an app older than them sends none and the row keeps what it had.
- `model` is the model's marketing name when the device knows it (iOS maps `utsname.machine`,
  `iPhone17,1` → `iPhone 16 Pro`; an identifier newer than the app's table is sent as it is).
- Apps send them when pairing or registering and again at each launch with `devices.update` —
  **never the name** there. A name set with `devices.update` is the person's (`renamed_at`,
  migration `0026`): pairing or registering the same device again keeps it; unlinking forgets it.
- `last_seen_at` also counts the calls of the sign-in that registered a device with
  `devices.register` (`seen_session_id`, same migration) — a phone signed in with a password, a
  browser — at most once a minute per sign-in, as a paired device's calls already counted.
- The hub offers its own app's bundle id (`APP_IDS.apple` in `packages/contracts/src/product.ts`,
  `com.twuijri.corehub`) as the APNs sender's default, so `bundle_id` is no longer missing on a
  new hub; it checks an APNs key signs an ES256 token (an EC P-256 key) before storing it, and
  names `google-services.json` when it is given one for FCM.

Rejected: a separate `reported_name` beside `name` (two names on one card for a rare case);
a heartbeat call for `last_seen_at` (any authenticated call is already a sign of life); asking
Apple to verify an APNs key on save (Apple answers only a real push to a real token —
`devices.testPush` does that).

## 82. FCM and APNs without credentials go through the Core Hub push relay

Proposed — owner to confirm (the relay itself is the owner's decision, ADR 0024). A hub with no
FCM or APNs credentials of its own reaches the official apps through a relay the owner runs,
which alone holds his keys. (This push relay is not §80's message relay for device connections,
which stays parked.) The contract's part:

- `PushSender.source` gains `relay`: the sender has no credentials here and delivers through the
  relay. Every `fcm` and `apns` row carries `relay` (`PushRelayStatus`, null on `webpush`) even
  when local credentials win, so a settings screen can show the switch and private push:
  `state` (`ready`, `not_registered` — the hub registers itself on first need —, `unreachable`,
  `blocked` by the relay's owner, `rate_limited`, `off`, `no_url`), `enabled`, `forced_off`
  (`COREHUB_PUSH_RELAY=off`), `private_push`, `url`, `hub_id` (not a secret), `last_error`,
  `checked_at`. A relay that blocked the hub makes its rows `state: error` and takes FCM/APNs out
  of `devices.getPushConfig`'s `providers`, so the apps stop registering.
- `PUT /push/relay` (`devices.setPushRelay`, owner/admin) takes `enabled` and `private_push` and
  answers the status. Private push sends only a generic «إشعار جديد في كور هب» / "New notice in
  Core Hub", the notice id and its kind; the app reads the rest from its hub.
- `PushRegistration.relay_proof` (optional): the app's signature over its token with a key it
  made once per install, forwarded unread; it lets the relay move a token from the hub that
  holds it to this one. No app sends it yet.

Local credentials always win; nothing changes for a hub that has them. Rejected: a separate
`relay` row in the senders list (`PushProvider` names services a device registers with, and a
device never registers with "relay"); a `GET /push/relay` (the senders list already carries it).

## 83. A model list is what the provider offers the account, never a list kept in code

**Approved by the owner (2026-09-26)**, in his words: «كل الموديلات خله هو يسحب الي يقدمه المزود ما
يخترع من نفسه» — every provider's models are what the provider's API returns for that account, not
a list the hub or Hermes keeps.

What was observed: a provider with a key was already asked by the hub's own adapters
(`adapters/`: `GET /models`, Anthropic's and Google's lists, Ollama's tags). A provider signed in
through Hermes (§55) was listed from Hermes's picker (`/api/model/options`), which asks the provider
when it can and otherwise **silently** answers a list from its code: for the ChatGPT subscription a
curated eight plus `-900k` names Hermes makes up itself (a large-context switch it strips before the
request — no model the backend lists); for Nous Portal only its curated agentic list. The owner's Pro
account was shown nine models without the `gpt-6-*` family the backend offers it.

- **Signed-in providers are asked directly** (`live-models.ts`): Hermes's own Python, in the Hermes
  home the provider was signed in to, resolves the account's token with Hermes's resolver (refreshed
  when it is about to expire, and once more after a `401`) and calls the provider's own models
  endpoint — the ChatGPT subscription's `GET …/backend-api/codex/models?client_version=0.0.0` with
  the account id from the token (`ChatGPT-Account-Id`; hidden models left out, the backend's
  order kept), every other one the OpenAI-shaped `GET {base}/models`. The token never leaves that
  process; the hub reads only the ids. The list is per account, so it is per plan.
- **A list kept in code is only a labelled fallback**: when the provider cannot be asked (no
  supervised Hermes, the sign-in lapsed, the endpoint failed or listed nothing), Hermes's list is
  used and `Provider.catalogue.source` is `fallback`, with `fallback_reason`; a client says so on
  the provider. `source: provider` is what the provider returned. "Refresh models" asks again.
- **Display names and hiding stay the person's**: aliases and the visible list apply on top of
  whatever the list is, as before.
- Where it is kept: `providers.capabilities` (JSON) carries the source and reason, so no migration.

Not changed here: the speech providers (ElevenLabs lists voices, not models; its default model id
is a setting, not a list) and the presets' default model settings. The hub's adapters for key
providers already ask the provider; none keeps a list.

**Amended 2026-09-26 (the list was still short on the owner's Pro account).** The Codex backend
reads `client_version` as the asking Codex CLI's version and leaves out every model whose
`minimal_client_version` is newer; `0.0.0` now answers a frozen older list (`gpt-6-astra`, the
5.6 trio, `gpt-5.5`) without `gpt-6-sol` / `gpt-6-luna`. The hub asks as the latest Codex CLI
release, as the Codex CLI itself does with its own version (`CODEX_CLIENT_VERSION` in
`live-models.ts`, 0.157.0 = openai/codex `rust-v0.157.0`; bump it to the newest `rust-v*` tag, or
set `COREHUB_CODEX_CLIENT_VERSION` in the hub's environment), and asks `0.0.0` once more only when
that version is refused or lists nothing. CLI Proxy API's longer list is not the backend's: its
Codex list is a static catalogue per plan kept in its code, `gpt-oss-120b-medium` is another
provider's (Antigravity) in the same "GPT" group, and `gpt-image-1.5` / `gpt-image-2` are image
names its own Images endpoint maps onto the Codex image tool. None of those is added here;
`gpt-image-1.5` stays out until it is seen drawing through a real subscription (§84).

## 84. The ChatGPT subscription draws through the Codex backend's image tool

The owner (2026-09-25): his CLI Proxy API instance on the same ChatGPT account offers `gpt-image-2`
and draws; a friend signed in only through Core Hub gets no images. Observed: the Codex backend
lists no image model; it draws when a chat model it serves is given the Responses API's
`image_generation` tool with an image model named in it (Hermes v2026.9.14 ships the same as its
own `openai-codex` image backend, MIT; OpenAI's Codex draws with `gpt-image-2` for signed-in paid
plans, not Free, against the plan's Codex usage). Proposed, owner to confirm:

- **One model is added to the subscription's list**: `gpt-image-2` with `image_output` — the only
  model the hub adds to a provider, because there is no other way to choose it; a client labels it
  «الصور عبر اشتراك ChatGPT» / "Images via your … subscription". `Provider.draws_images` says
  which providers the Images role may take a model from; the subscription is the one signed-in
  provider that does, and only with that model (§72 is amended: it refused every signed-in one).
- **The skills and Hermes's tool draw with it** through `image_api.py`'s new `codex` protocol:
  `POST {base}/responses`, streamed, the chat model `gpt-5.5` carrying the tool (`model`,
  `size`, `output_format: png`, `background: transparent` for a cut-out), no `tool_choice` (the
  backend reads it as a function name and refuses it), the source images as `input_image` parts
  for an edit; the picture is the last finished `image_generation_call` result. The PNG lands in
  the run's folder like any other (§72).
- **No key is written**: `COREHUB_IMAGE_PROVIDER=codex`, the base URL and the model only; the
  script asks Hermes's resolver for the token at the moment it draws, retries once with a refreshed
  one after a `401`, and never prints it. A plan without images (`402`/`403`, or the backend saying
  so) is `image_not_in_plan`; a used-up limit is `usage_limit`.
- **Allowed?** OpenAI publishes no rule for third-party clients of the ChatGPT sign-in either way;
  Hermes ships both chat and images on it and identifies itself with its own headers, which the
  script reuses. Images are part of Codex on the same endpoint and count against the same plan
  limits, so they are covered exactly as far as chat is.

Rejected: an OpenAI-Images-API shim in the hub (CLI Proxy API's shape — the hub would hold the
token); pointing Hermes at its own `openai-codex` image backend (the skills would then draw with a
different implementation than the tool, which §72 rejected).

## 85. A WhatsApp number is linked as the agent's or as the person's own, asked, and answers at once

The owner (2026-09-26, live hub 1.1.0, reported — not a proposal): he re-linked WhatsApp in the
default profile with his **personal** number; the Channels card read «مربوط» but «غير متصل», and
the agent answered neither him nor a friend who linked his own number the same way.

Observed (ADR 0012; Hermes v2026.9.14, MIT): Hermes's WhatsApp has two modes, set by
`WHATSAPP_MODE` in the profile's `.env` and handed by its adapter to the bridge. In `bot` the
number is a separate one for the agent: other people message it, a new sender gets a pairing
code, and what the account owner types from the phone is dropped. In `self-chat` the number is
the person's own: only what the owner writes in their own "Message yourself" chat reaches Hermes,
replies go to the same chat with a short signature, and the bridge drops everyone else's messages
before Hermes sees them, so nobody else gets an answer or a pairing code. The hub always wrote
`bot`, so a personal number never answered its owner. Separately, the hub never restarted the
default profile's gateway after a link (it carries the API server, so every change there waited
for Restart): that gateway kept running without WhatsApp, which is the `offline`. Proposed,
owner to confirm:

- **Asked, never guessed.** `agents.loginChannel` takes `mode` (`bot` | `self-chat`); a client
  asks «بوت (رقم مخصص للوكيل)» / "Bot (a number for the agent)" or «أنا (مراسلة نفسي)» / "Me
  (Message yourself)" with neither chosen. Without `mode` the hub links `bot`, as before, and
  links made before keep `bot` (their `.env` says so). For `self-chat` the linked number is added
  to `WHATSAPP_ALLOWED_USERS` — what Hermes's own onboarding writes — so the gateway takes the
  owner as allowed and does not pair them in their own chat; whoever else is listed stays.
- **Changed in place.** `agents.setChannelMode` (WhatsApp only; `409 mode_not_supported`
  elsewhere, `409 not_linked` with no phone) rewrites the mode with the profile's gateway held down
  and started again. `ChannelLink.mode` reads it (no `WHATSAPP_MODE` is Hermes's `self-chat`).
- **A link answers at once, in every profile.** After a link and a mode change the hub restarts
  the gateway that serves the profile — the default one too, held down for a moment like a hub
  tools change (§79). ~~Other channel edits in the default profile still wait for Restart.~~
  **Amended the same day** (the owner: «التيليقرام المفروض يسوي رستارت بعد» — a Telegram linked
  in the default profile stayed silent): every channel change — link, settings save, switching on
  or off, clearing, unlinking, mode — restarts the gateway serving the profile, the default one
  included, and `ChannelGateway.applies` is always `now` from this hub (`on_restart` stays in the
  enum for older hubs). Changes a second apart are gathered: one restart after the last of a
  burst (a trailing debounce per profile, 1 s), and while one waits, a channel the running gateway
  does not name yet reads `unknown` rather than `restart_needed`.
  `Channel.restart_needed` is true when a running gateway does not name a switched-on, linked
  channel (Hermes names every platform it starts with), and a client offers Restart there; a
  platform Hermes reports `connecting` reads `unknown`, and the web reads again until it is not.
- **Approvals in one place** (the owner, same day): the web's waiting senders and approved
  senders leave the bottom of the Channels page for one «الموافقات» / "Approvals" button in its
  header with the count, opening a panel grouped by platform; the «بانتظارك» inbox approves or
  denies a waiting sender itself. No contract change.

Rejected: guessing the mode from the number, which cannot be known; Hermes's own `…/apply`,
which runs `hermes gateway restart` and in a container starts a second gateway inside the
dashboard process.

The header over self-chat replies: §86.

## 86. The header over WhatsApp self-chat replies is the agent's name, or a typed title

The owner (2026-09-26, hub 1.1.1, approved: «ممتاز»): in «أنا (مراسلة نفسي)» every reply of the
agent starts with Hermes's «☤ *Hermes Agent*» over a rule; it should name the agent.

Observed (ADR 0012; Hermes v2026.9.14, MIT): in `self-chat` the owner and the agent write from one
number, so Hermes's WhatsApp bridge puts a header over every reply (`bot` replies carry none).
`WHATSAPP_REPLY_PREFIX` in the profile's `.env` replaces Hermes's own, a written `\n` being a line
break. Hermes's Python side reads an empty value as "no header", but its adapter drops an empty
variable from the bridge's environment and the bridge then sends its own default header — tried
on the real Hermes in the image, with its adapter and the bridge's own formatting code. Proposed,
owner to confirm:

- **`agents.setChannelReplyHeader`** (WhatsApp only; `409 reply_header_not_supported` elsewhere,
  `409 not_linked` with no phone): `use: agent_name` — the agent's name as the hub shows it
  (`Agent.name`), read when written — or `use: custom` with a `title` (one line, 1–64 characters).
  The hub writes `*<title>*`, Hermes's rule, a line break: the shape of Hermes's own header with
  another title. The gateway serving the profile follows like any channel change (§85).
  `ChannelLink.reply_title` reads it back; null while nothing usable is written (Hermes's own).
- **The default is the agent's name**, written when a number is linked in `self-chat` or switched
  to it and nothing is written yet. Links made before are not rewritten when the hub starts: they
  keep Hermes's header until someone saves the setting or changes the mode. A value written by hand
  is kept and reads as its text.
- **No "no header"**: with Hermes v2026.9.14 an empty value still sends Hermes's header, and a
  header is what tells the owner's messages from the agent's in one chat. If Hermes's bridge takes
  an empty value one day, `use: none` can be added.
- Renaming the agent later does not rewrite the header (it then reads as a typed title).

Rejected: `reply_prefix` in the platform's `config.yaml` — the adapter hands it to the bridge only
while the environment variable is also set, so it adds nothing; faking "no header" with a
zero-width prefix (Hermes's own code notes WhatsApp renders those as stray characters) or a
blank-line prefix.

## 87. A model that only draws is never offered as a chat model

The owner, testing hub 1.1.1 (2026-09-26): the ChatGPT subscription's `gpt-image-2`, OpenAI's
`gpt-image-1` and the like appeared in the chat model pickers, and choosing one as a chat model
failed the turn. Proposed, owner to confirm:

- **`Model.image_only`** (optional boolean; absent from an older hub means `false`). The hub says
  it for the families that answer only with pictures — the Images-API ones it already speaks to
  through `/images/generations` (`gpt-image-*`, DALL·E, Imagen, FLUX, Stable Diffusion, Seedream,
  Recraft, Ideogram …), the subscription's image model among them. A model that draws **and**
  chats (`gemini-*-image`, `gpt-5-image`) keeps `image_output` and is not image-only.
- **Clients leave image-only models out of every chat-model picker**: the composer, the chat and
  auxiliary defaults, the fallback chain, a provider card's default and a workflow step. They stay
  on the Images tab (§72), which lists `image_output` models as before.
- The hub does not refuse an image-only model that a profile already chose as a chat model: a
  refusal would break a saved setting without a way to see why. Hiding it is enough to stop new
  mistakes.

- **The add-provider dialog's Fetch says it too** (amended 2026-09-27): each model of
  `models.probeProvider`'s answer carries `image_only` by the same rule, since nothing is stored
  yet that could carry capabilities, and the dialog's default-model picker leaves those out.

Rejected: a new `ModelKind` value (`image`), which widens an enum the native clients decode and
changes what every existing row of the catalogue is; a capability "text output", whose absence
would have made every older row image-only.

## 88. A channel conversation is hidden per person, and deleted from Hermes by an admin

The owner could neither hide nor delete a Telegram conversation in the chats list: they are
Hermes's and read-only (§61), and he had to run `hermes sessions delete` inside the container.
Proposed, owner to confirm:

- **Hide** (`sessions.hideChannelConversation`, `PUT /channel-conversations/{id}/hidden`, and
  `sessions.unhideChannelConversation`, its `DELETE`): the caller's own list stops showing it.
  The hub keeps the mark — per person and per profile, keyed by Hermes's session id — and
  touches nothing else: other people's lists, Hermes and the channel stay as they were.
  `sessions.listChannelConversations` leaves hidden ones out unless `hidden=include`, which lists
  them marked `hidden: true`, so a client can offer "Show hidden chats" and "Show again".
- **Delete from Hermes** (`sessions.deleteChannelConversation`,
  `DELETE /channel-conversations/{id}`, owners and admins): what `hermes sessions delete` does,
  asked through Hermes's internal server (ADR 0015). What Hermes does, observed in its MIT source
  at `v2026.9.14` (`hermes_cli/web_routers/sessions.py`, `hermes_state_sessions.py`) and said in
  our words: `DELETE /api/sessions/{id}?profile=<p>` removes the session row and its messages,
  deletes the delegate children with it and keeps branch children by clearing their parent, and
  answers `{"ok": true}` — or `{"ok": true, "already_absent": true}` when there is nothing to
  delete. It resolves an id it does not know as the one session that id is a prefix of. So the
  hub first reads the row by the exact id (`GET /api/sessions/{id}`) and deletes only a
  conversation from a messaging channel whose id is exactly the one asked for; anything else —
  the hub's own chats, which Hermes keeps too, or a prefix — is `404`. The hub drops what it had
  read of that profile, forgets every person's hidden mark on it, and writes an audit line
  (`sessions.channel_conversation_deleted`). It is permanent; clients ask first and say so.

Rejected: deleting through the `hermes` CLI from the hub process (the dashboard is already how
the hub reads these, and it answers per profile); hiding for everyone (that is a different
person's list); a soft delete in Hermes (Hermes has archive, but an archived conversation is
still in its store, which is not what the owner asked for).

## 89. An agent's run may ask its person's own computer for files and programs; a computer says what its helper offers

A hub on a server could not reach the person's computer: a run token had no way to make a device
request, and nothing described what the computer's helper offered (ADR 0025, the owner's scope of
2026-09-26). Proposed — owner to confirm where the owner did not name it:

- **`Device.helper`** — the folders the person shared (the app's own `~/Core Hub` marked
  `default`), whether opening is allowed, and the programs switched on with the profiles each one
  serves and its tools (`DeviceHelper`, `DeviceProgram`, `DeviceProgramTool`). Only the device
  itself reports it (`devices.update` with its own token; anyone else `403 not_this_device`); the
  hub stamps `reported_at`. `null` while the helper is off.
- **`Device.profiles`** — the profiles whose agents may ask the device; `null`, the default, is
  every profile of its person. Only that person, from a sign-in of theirs, changes it (the device's
  own token, a run token or an admin: `403 not_the_devices_person`). A request made in a profile
  it leaves out is `403` with `details.reason = device_not_in_profile`.
- **A run token may create `files` and `apps` requests** to its own person's device, and nothing
  else (`location` and the rest still need the `device` scope); the request carries the run's id.
  This is how the hub's `devices` tools ask (§67's group, built here).
- **`files`** params `{tool, arguments}` (the helper's tools and `send_file`, which uploads into
  the request's profile with the resumable upload); result `{content, is_error}` or
  `{attachment_id, name, mime, size_bytes, kind}`. **`apps`** params `{op: call, program, tool,
  arguments}` or `{op: status, call_id}`; result `{state: done, content, is_error}` or
  `{state: running, call_id, progress}` — anything else is `400 not_a_program_result`.
- **Waits per capability** when the asker gives none: `files` 60 s, `apps` 120 s, everything
  else 30 s. **Offline at once**: a `files`, `apps` or `screen` request to a device with no live
  `/rt/devices` socket is `failed` with `unavailable` and says the device is offline, instead of a
  wait nobody would answer (a phone's capabilities keep §74's catch-up).
- **The `devices` group of the hub's tools is off until an admin switches it on**, even in a
  profile whose tools were on; its reads are `list`, `list_folder`, `read_file`, `fetch_file`,
  `run_status`; its writes `write_file`, `open`, `run`.
- **What a device sends for the chat goes on the reply** of the run that asked
  (`devices.fetch_file`); the file is an attachment of the profile like any other.

Migration `0029` adds `devices.profiles` and `devices.helper`.

Rejected: per-program tools in the hub's tool list (Hermes lists a profile's tools before a run
names a person); a raw pipe per program through the hub (no per-call consent, logging or timeout,
and it would not fit §74's one-answer request).

## 90. A video plays from a one-attachment stream ticket

A reply can now carry a video (a render from the person's computer). The web fetched every file
with the bearer header into a blob, so a 40 MB video played only once all of it had arrived; a
media element cannot send the header, and the contract keeps the bearer out of URLs. Proposed —
owner to confirm:

- `sessions.createAttachmentStream` (`POST /attachments/{id}/stream`) gives a path with a random
  64-hex ticket (`/api/v1/attachment-streams/<ticket>`), valid for one hour, for that attachment
  only; `sessions.streamAttachment` serves it with `Range` like the download, without a bearer,
  `Cache-Control: private, no-store`.
- The ticket is not the bearer and grants nothing else. It is checked on every read: the person
  who asked must still be active and able to enter the profile. Tickets live in memory; a restart
  forgets them and the page asks again.
- The web plays a `video/*` or `audio/*` file of a message in place from it; the name stays under
  it and opens the preview as before.

Rejected: the bearer in the URL (it would reach logs and history); a service worker that adds the
header (one more moving part, absent on first load, and the push worker is optional).

## 91. A client asks for speech in a format it can play

The owner (2026-09-27): the iPhone cannot play the hub's Ogg speech and falls back to the phone's
own voice. `models.synthesize` had no way to say what the client plays, so each provider sent its
own format. Proposed, owner to confirm:

- **`SpeechRequest.format`** (`SpeechFormat`: `mp3`, `aac`, `wav`, `ogg` — Ogg Opus), optional.
  The hub asks the provider for it where the provider lets it choose (the OpenAI-shaped protocol's
  `response_format`, where Ogg Opus is `opus`); a provider that cannot choose sends its own format.
  The response `Content-Type` always says what came, and `audio/aac` joins the declared types.
- **Omitted or null is the provider's default**, as before: nothing changes for a client that does
  not ask.
- The iPhone and Android apps ask for `mp3`, which both play natively and every speech provider the
  hub drives can produce; the web keeps not asking.

Rejected: converting the audio on the hub (a transcoder in the image for one client's gap), and a
per-provider setting (the format is the listener's constraint, not the provider's).

## 92. Changing a conversation's agent is a fork; changing its model is a patch

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

The one-shot offers the model **no tools** and leaves nothing in the agent's
history (2026-09-26): a title is not worth a model writing a file or sending a
message on its way to six words. Hermes answers it with its own tool-free
`llm.oneshot` on the conversation's model (the open conversation lends it, or a
throwaway session in the same profile does, and no prompt is ever submitted);
an agent without such a call is not handed a turn — the conversation's model is
asked directly through the provider the hub knows, and without one the fallback
names it.

No field was added for it. A person's own title is one they sent in
`SessionPatch.title`, so the hub marks the row when the patch carries a
non-empty string and never overwrites it afterwards; `title: null` hands the
naming back and the hub names it again, emitting `session.updated` on
`/rt/sessions`. Rejected: a `title_source` enum on `Session`. Every client would
have to render a state nobody displays, and the one question a client actually
asks — "may I ask for a new title?" — is answered by sending `title: null`.

## 93. Tasks run in order: `auto_start` waits for dependencies, a quiet run is marked stuck, the archive is counted

Proposed — owner to confirm (2026-09-27, the night's "tasks run in order" batch). Four things the
Tasks section promised or needed, each with the smallest contract change that says it.

**Auto-start waits for what a task depends on.** A task with `auto_start` that is `ready` and given
to an agent does not start on its own while any task of its `depends_on` is not done, and starts
itself when the last of them reaches `done` (the move to `done` looks again, as a move to `ready`
already did). "Done" is `done`, or `archived` after `done` — the weekly archive keeps
`completed_at`; a task archived by hand has none and is not done. A person's "assign and start" is
**not** held back: the person decides, and the clients warn first, naming what is not done. So
that a card and its details can say what it waits for, `Task` gained `waiting_on`: the
dependencies not done yet, each `{ id, title, status }` (`TaskDependencyState`) — the ids alone
would leave a client to find titles among tasks it may not have loaded (the archive, another
profile's board). Rejected: blocking a manual start with `409` — the owner's rule is that a
person can always start a task by hand.

**A stuck-task watchdog, on the scheduler's clock.** A `running` task of the hub's own whose run
has shown no activity — no event on `/rt/sessions` that names the run: text, reasoning, a tool
call, a step — for `COREHUB_TASK_STUCK_MINUTES` (default **30, proposed**; `0` is off) gets
`Task.stuck_since` (the moment it last showed any) and its owner **one** notice ("A task seems
stuck", kind `task_moved`, opening the task; the person's "task moved" switch silences it). The
marker goes when the run speaks again or the task leaves `running`, and it is announced as
`task.updated`. Nothing is moved and nothing is stopped: a slow run is not a failed one, and the
person decides. A run waiting for a person's answer (`waiting_approval`, `waiting_input`) is not
stuck — it has already asked. The check runs on the hub scheduler's tick (`schedules` owns the
clock, `tasks` the rule, `notify` the words; they meet in the composition root), not on a timer of
its own. What a run last did is kept in memory: a restart ends every run and settles its task
(§47), so nothing about it has to outlive the process. Rejected: moving a stuck task to `blocked`
(it would undo work that was only slow) and an env var the UI cannot see being the only switch
forever — a setting can replace it later without a contract change.

**`task.moved` carries `from`, `to` and `actor`.** The event's schema always required them; the
move route sent the task alone, so webhooks forwarded an event without them. It now sends all
three, and a card put elsewhere in its own column is `task.updated`, not `task.moved`.

**The archive is counted, not sent.** Without `include_archived`, `tasks.getColumns` answers the
`archived` column with its real `count` (and `counts.by_status.archived`) and empty `tasks`;
`counts.total` counts only the columns whose tasks came along. The board is read again every few
seconds while a task runs, and the archive only grows, so clients read it with
`include_archived=true` only when a person opens it.

## 94. Speech providers: voices from the provider or its documentation, every language, long text in parts

The owner asked for Groq's voices (its Saudi Arabic voice among them, chosen by the person) and
the well-known speech services, each added in a click, with a voice picker and a preview; and,
as for everything in Core Hub, every language — "Arabic" means "Arabic too". Proposed — owner to
confirm:

- **Presets.** Groq speaks and transcribes with its chat key (`groq-stt`: Whisper over OpenAI's
  shape; `groq-tts`: Orpheus, English and Arabic-Saudi, WAV only, 200 characters a request, no
  default model or voice — the person picks). ElevenLabs gains Scribe (`elevenlabs-stt`).
  Deepgram (`deepgram-stt`, `deepgram-tts`: Nova and Aura) and Azure Speech (`azure-tts`,
  `azure-stt`, with a resource key; the address is the region's endpoint, asked for with
  `ProviderPreset.base_url_example`) are new families. Adding one row of a family adds its
  siblings, and a family that already holds a key in the chosen scope lends it
  (`ProviderPreset.key_on_file`): no key is pasted twice.
- **Voices** (`models.listVoices`): the provider's own list when it has an endpoint
  (`source: provider` — ElevenLabs `/v2/voices` page by page, Deepgram's `/v1/models`, Azure's
  region voice list); its public documentation when it has none (`source: documented` — Groq,
  OpenAI), kept in one editable file of the hub (`modules/models/speech/documented.ts`) with the
  page and the day it was checked; `source: none` otherwise. `model` narrows the list to that
  model's voices (`Voice.models`); `Voice.description` carries the provider's words (accent).
- **Models** of a speech row are its provider's own list filtered to the row's kind; a provider
  with no model endpoint (Scribe) answers its documented list with `catalogue.source: fallback`.
- **Preview**: `SpeechRequest.model` joins `voice` and `provider_id`, so the page speaks the model
  and voice on screen before they are saved.
- **Long text**: a provider whose request limit is below the text (Groq 200, Deepgram 2 000,
  OpenAI 4 096, ElevenLabs 5 000) is sent it in parts cut at sentence, then clause, then word
  boundaries, and the parts' audio comes back as one file (WAV samples joined under one header;
  MP3 frames concatenated).
- **Every language**: the web offers "Detect automatically", the popular languages, then every
  language (names from the browser in the interface language), and any id — model, voice,
  language code — can be typed by hand.
- **Hermes** hears the choice where it has a backend: `stt.provider` `groq` / `openai` /
  `elevenlabs` and `tts.provider` `openai` / `elevenlabs`, with the row's model, voice and
  language in that provider's block, written key by key. For Groq TTS (Hermes's OpenAI-shaped TTS
  asks for MP3 or Opus, which Groq refuses), Deepgram and Azure, Hermes's own voice is left as it
  is; the web and the phones speak through the hub's endpoints.

Rejected: Google Cloud Text-to-Speech and Speech-to-Text (their authentication pages name
Application Default Credentials and service accounts, not an API key, which the hub's one-key
provider model needs); Microsoft Edge's read-aloud voices (an undocumented endpoint reached by
presenting as the Edge browser, with no terms that grant a third-party server its use — Azure
Speech offers the same neural voices with a key); a static voice list for a provider that has a
list endpoint.

## 95. The way in from outside: the person's own Cloudflare Tunnel or Tailscale, run by the desktop app

The owner, 2026-09-26, on the relay parked in §80: «كل اللي قلت لك خلها بعدين… سوها». A person
who runs the desktop app in local mode, with no server, wants their phone to reach that hub from
outside the house. Proposed — owner to confirm:

- **Where it runs.** Only a hub the desktop app started (local mode) can open a way in. The hub
  runs nothing and keeps no secret: `devices.getRelay` / `devices.setRelay` ask the app over the
  child's IPC channel (`apps/desktop/src/shared/hub-ipc.ts`), and the app does the work. Any other
  hub answers `getRelay` with `available: false` and `setRelay` with `409 relay_unavailable`,
  rather than `501`.
- **Cloudflare Tunnel** (`route: cloudflare`). The person makes a tunnel in their own Cloudflare
  dashboard (Zero Trust › Networks › Tunnels), gives it a public hostname whose service is
  `http://localhost:<hub_port>`, and pastes its token. The app keeps the token sealed by the OS
  keychain (`safeStorage`, as the device token of §89), never returns it (`token_set` and the
  token's tunnel id only) and never logs it; the hub checks its shape (base64 of `{a, t, s}`)
  and passes it through once. The app downloads `cloudflared` from Cloudflare's GitHub releases
  on first use, at a pinned version (2026.9.3) whose SHA-256 is Cloudflare's published one for
  that file — any other file is refused — keeps it in `<app data>/tools`, and runs
  `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<free port> run` with the token in
  `TUNNEL_TOKEN` (never on the command line). `connected` comes from cloudflared's own `/ready`;
  the routes the dashboard gives the tunnel come from its log (`hostnames`, with `matches: false`
  for one that points anywhere but the hub's port). It restarts after a crash with a growing
  pause, but not for a token Cloudflare refuses (`token_invalid`).
- **Tailscale** (`route: tailscale`). When the computer is on a tailnet (an address in
  100.64.0.0/10; the MagicDNS name from `tailscale status --json` when the program is where its
  installers put it), the app listens on that address only, at the hub's port, and passes each
  connection to the hub on the loopback. Never on 0.0.0.0 or the LAN.
- **A stable port.** The hub of local mode asks for the port it used last
  (`COREHUB_DESKTOP_PORT`), so a tunnel's service keeps pointing at it; another one when it is
  taken, and the page then shows the route pointing elsewhere.
- **Pairing.** While the way in is open, a pairing made on that hub is `connection: relay` and
  its QR's `hub_url` is `relay_url` (`https://<hostname>`, or `http://<tailnet address>:<port>`),
  whatever was asked: that hub listens on its own computer only, so no other address would reach
  it. Asking for `relay` while it is closed answers `409 relay_not_connected`.
- **Security.** The hub keeps its normal sign-in; the way in carries the hub's port and nothing
  else. The page says, before anything is turned on, that the hub becomes reachable from the
  internet through the person's own tunnel. Nothing starts until the person turns it on, and it
  stops with the hub.

The contract changes: `Relay` loses `hub_id` and the `official` route (no service is run for
anyone, §80), and gains `available`, `hub_port`, `token_set`, `tunnel_id`, `hostname`,
`hostnames`, `tailnet`, `error` (a closed list) and `error_detail`; `RelayUpdate` is the body of
`setRelay` (`enabled`, `route`, write-only `token`, `forget_token`, `hostname`), which queues no
job. Rejected: a relay service run for people (§80); `cloudflared` bundled in every installer (tens
of MB for a feature few turn on, and a second program to keep current in every release); the
token on `cloudflared`'s command line (other users of the computer can read it); `tailscale serve`
(it needs HTTPS certificates turned on for the tailnet, and changes the person's Tailscale
settings rather than only the app's own listener).

## 96. Who is asking: `X-Forwarded-For` only from a proxy the hub trusts

Found on 2026-09-27 while opening a way in from outside (§95): the hub ran Fastify with
`trustProxy: true`, so it believed `X-Forwarded-For` from anyone, and `request.ip` was the
left-most address in it — the one the client writes. A client on the internet could send a new
address with every guess and never meet the per-address lockout of passwords, app tokens and
pairing codes. Socket.IO handshakes did the opposite: they counted the raw peer, so every
client behind a proxy shared the proxy's address and one person's mistakes locked everyone out.
Proposed — owner to confirm:

- **The rule.** Forwarded headers are believed only from a peer the hub trusts, and the client is
  the right-most address in `X-Forwarded-For` that is not a trusted proxy (proxy-addr's rule, the
  one Fastify applies). Fastify's `request.ip`, `request.host` and `request.protocol` and the
  Socket.IO handshake use one trust function (`packages/server/src/lib/client-address.ts`), so a
  failure over HTTP and over a socket counts against the same address. The web terminal's audit
  line (`terminal.opened`) records that address too.
- **The setting.** `COREHUB_TRUST_PROXY`, read in `app/config.ts` only: a comma list of IP
  addresses / CIDR ranges, `false` (nobody), or a hop count 1–10. Anything else stops the hub at
  boot with the reason (`ConfigError`), like every other variable.
- **The default.** Unset, the hub trusts `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16` and `fc00::/7`: a Caddy/Traefik container on the stack's Docker network and a
  `cloudflared` on the same machine connect from these, so every stack we deploy keeps working
  by replacing the image; a client on the internet does not, so what it writes is ignored.
  Tailscale's own addresses (`100.64.0.0/10`) are clients, not proxies.
- **The desktop app's Tailscale route** (§95) connects to the hub from loopback, which the
  default trusts, so it no longer passes bytes through: it forwards HTTP — requests, server-sent
  events and WebSocket upgrades — drops the peer's own `Forwarded`, `X-Forwarded-*` and
  `X-Real-IP`, and writes `X-Forwarded-For` with the tailnet peer's address
  (`apps/desktop/src/main/tailnet.ts`). A machine on the person's tailnet is counted as itself.

Known limits: under the default a machine on the same private network as a hub whose port is
published directly can still write its own address — such a stack sets `false` (docs/DEPLOY.md
§3d). Rejected: `false`
as the default (every client behind a proxy would share one address, and one person's failed
sign-ins would lock everyone out); a hop count as the default (a client reaching the port
directly could claim any address); reading `CF-Connecting-IP` or `X-Real-IP` (headers a client
can send as easily, and not what the reference proxies set).

## 97. An agent's incoming webhooks are Hermes's routes, reached through the hub's own address

W14 of the fork gap list: an outside service (GitHub, a form, a script) starts a run of the agent
with a prompt. Hermes has a receiver for it; the hub had only outbound webhooks. Proposed — owner
to confirm.

**What Hermes does**, observed in its MIT source at `v2026.9.14` (`gateway/platforms/webhook.py`,
`hermes_cli/webhook.py`) and said in our words. The receiver is a platform of the messaging
gateway, `platforms.webhook` in a profile's `config.yaml`: switched on, the gateway serving the
profile listens on `extra.port` (8644 when none is given) and `extra.host` (every interface when
none is given), answering `POST /webhooks/<route>` and `GET /health`. Routes come from
`extra.routes` in `config.yaml` (static; they win a name clash) and from
`webhook_subscriptions.json` in the profile's home (what `hermes webhook subscribe` writes, mode
0600), which is read again by its modification time on every POST — a new or deleted route needs
no restart, switching the platform on does. A route has a secret (required; one without is
skipped), a prompt template, the events it takes (empty: all), skills, and `deliver` (`log` keeps
the answer in Hermes's record of the run; a platform's name sends it to that platform's home chat).
A POST is capped at 1 MiB, checked against the secret (GitHub's `X-Hub-Signature-256`, GitLab's
`X-Gitlab-Token`, Svix and Standard Webhooks, Linear, or the generic `X-Webhook-Signature` and its
timestamped `-V2`), rate-limited per route (30 a minute), filtered by event (`X-GitHub-Event`,
`X-GitLab-Event`, or the body's `event_type`/`type`) and de-duplicated by its delivery id for an
hour. The prompt is rendered with `{a.b}` taken from the JSON body (a form body is read too),
`{event_type}` and `{__raw__}`; an empty prompt asks with the whole body. The POST is answered
`202 {status: accepted, route, event, delivery_id}` at once and the run starts; `200` says
`ignored` or `duplicate`; refusals are `401` (signature), `404` (no such route), `403` (a route
switched off), `413`, `429`. A route's `profile` must be `default` for a gateway that serves one
profile, which is how the hub runs them.

**What the hub does:**

- **Routes on the agent's Channels page** (`agents.listWebhooks`, `createWebhook`,
  `deleteWebhook`, `testWebhook`; owners and admins). A route the hub makes is written to
  `webhook_subscriptions.json` in Hermes's own shape with a new 32-byte random secret, and the
  profile's listener is switched on in `config.yaml`, **bound to `127.0.0.1`** on a port of its
  own (from 18650 up, one no other profile's listener has and nothing on the machine holds; one
  written by hand is kept). The profile's gateway starts or restarts to listen, as after any
  channel change (§85); deleting the last route switches the listener off again. Static routes are
  listed with `static: true` and are not deleted here. The page shows each route's full address
  and its secret (hidden until shown), each with a copy button; `deliver` is `log` or a channel
  switched on in the profile.
- **The hub is the public door** (`agents.receiveWebhook`,
  `POST /api/v1/hermes-webhooks/<profile slug>/<route>`, no bearer: the route's secret is the
  permission, checked by Hermes). The hub passes the body byte for byte, with the headers Hermes
  reads a signature, an event or a delivery id from, to the profile's listener on its own machine,
  and answers what the listener answered: a `2xx` as it came, a refusal in the hub's envelope with
  Hermes's words in `details.hermes_error`, `503` when nothing listens. So an outside service needs
  only the hub's address — **which must be reachable from the internet**, and the page says so,
  louder when the page itself was opened on a private address — and no port is opened on the host:
  a Docker upgrade keeps working by replacing the image alone.
- **Test** sends what `hermes webhook test` sends — a `test` event signed with the route's secret —
  from the hub to the listener, so the agent runs once with the route's prompt. It proves the route
  and the listener, not the public address.
- In the channels list the `webhook` platform is shown in this section, not as a card of its own.

Rejected: publishing Hermes's port on the host (a Compose change for every existing stack, and a
second address to secure); the hub checking signatures itself (Hermes has the full set, and two
checkers would drift); letting the page set a route's toolsets or skills (Hermes deliberately
keeps toolsets out of `hermes webhook subscribe`, so an agent-made route cannot grant itself tools;
skills can follow later); a route the hub serves with its own run instead of Hermes's (Hermes's
routes are what its CLI and agents already manage).

## 98. Media plays from byte ranges: conversation files and working files stream like attachments

W10 of the fork gap list: a video or a sound the agent made played nowhere, and a conversation's
files and the profile's working files were sent whole, with no ranges — only stored attachments
had them (§90 added their stream tickets). Proposed — owner to confirm:

- **One byte range** on `sessions.readFile`, `knowledge.downloadWorkspaceFile` and the stream
  addresses: `Range: bytes=a-b`, `a-` or `-n` answers `206` with `Content-Range`; a range that
  starts at or past the end (or `-0`) is `416` with `Content-Range: bytes */<size>`
  (`bad_request`, `details.reason = range_not_satisfiable`); anything else — another unit, several
  ranges, `b < a` — is ignored and the whole file sent, as RFC 9110 allows. `Accept-Ranges: bytes`
  on every answer. Stored attachments keep §90's behaviour.
- **`SessionFilePreview` gains `video` and `audio`**, decided from the name (`mp4`, `m4v`, `webm`,
  `ogv`, `mov`, `mkv`; `mp3`, `m4a`, `aac`, `wav`, `oga`, `ogg`, `opus`, `flac`, `weba`) or, for an
  attachment whose name says nothing, from its stored type. Their preview cap is 64 GiB: a player
  reads a range at a time, so size is not what stops it; a download of one is capped the same way.
- **Stream tickets for files** (§90's mechanism, one more kind of ticket):
  `sessions.createFileStream` (a file of the session's working folder, checked as `readFile`
  checks it) and `knowledge.createWorkspaceFileStream` (owners and admins) answer the same
  `AttachmentStream`; `knowledge.streamFile` (`GET /api/v1/file-streams/<ticket>`, no bearer) serves
  it with ranges, opening the file again by the working-file rules on every read. A ticket names
  one file, lasts an hour, lives in memory and stops when its person may no longer enter the
  profile (or, for working files, is no longer an owner or admin). Served in place only for video,
  audio, pictures (not SVG) and PDF; anything else as a download. `private, no-store`, `nosniff`,
  sandboxed.
- **The web plays them**: in the side file panel (a `<video>` or `<audio>` with its controls, from
  the ticket — the page never reads the file into itself; Download saves from the same address) and
  in a reply (an attachment whose type or name says video or audio). Whether the browser can decode
  the format is its call: when the element says it cannot, the reply shows the name and the panel a
  note with Download.
- **A reader that stops half-way is not an error.** A player drops the rest of a range it asked
  for as soon as it has what it needs; the hub answered that with an error after the headers, which
  threw out of the process (found by the journey that seeks; §90's attachment stream had the same
  path). A route that sends on its reply now waits for it to end and never turns a closed
  connection into an error (`lib/route.ts` §streamed).

Rejected: the bearer in the media URL (§90); several ranges in one answer (`multipart/byteranges`,
which no player asks for); a separate range route per module (one ticket route serves both kinds).

## 99. A room message carries pictures and files; a seat's question names its room

Proposed — owner to confirm (the phones' rooms, 2026-09-27: «reuse the chat composer … attachments
with the quality choice», and «the room's pending items appear in the phone's pending list»).

- **Files in a room.** `RoomMessageCreate.content` takes `image` and `file` blocks as well as text —
  words, files, or both — naming attachments uploaded into the room's profile the way a chat's are
  (`sessions.uploadAttachment`, `sessions.startUpload`). An id that names no attachment there is
  `404`; `audio` and `location` blocks are `400 validation_failed` with
  `details.reason: unsupported_block` (a phone sends a recording as a file). The stored message keeps
  each block with its attachment's name, type, size and address, so every member sees it. The files
  go with each seat's next turn as a chat's files go with its run (the seat's own run carries them
  as blocks; the hub copies them into the run's input folder), and the room's transcript as the seat
  reads it names them (`(attached: …)`). Rejected: a room's own upload — the profile's attachments
  already serve chats, and any member of the room may enter its profile.
- **A seat's question names its room.** An approval or question raised in a seat's own conversation
  carries `Approval.room_id` (it was always `null`), everywhere an approval is read: the pending
  list (`sessions.listApprovals`), the events, and `RoomDetail.pending_approvals`, which now lists
  what waits in the room's seats (it was always empty). The pending list opens such an item in its
  room. `sessions` learns a seat's room from `rooms` through the composition root
  (`registerRoomOfSeat`), so neither module imports the other.

## 100. A preset is a saved bundle of one agent's settings in a profile, applied through the existing saves

Proposed — owner to confirm. The owner parked presets on 2026-09-25 (§80) and lifted it on
2026-09-26 («كل اللي قلت لك خلها بعدين لا سوها ما عندي مشكلة»). The contract had put them under
agents for one agent (`dsh`) that is not in the catalog; they now mean something for every agent.

- **What a preset is.** A named bundle (`AgentPreset`) of one agent's settings in one profile:
  `content.model` — the profile's chat model with its fallback chain (`null` when the profile
  inherits the `default` profile's) and the agent's own model; `content.skills` — skill key →
  on/off (Hermes's built-in skills, which the hub does not switch, are left out);
  `content.mcp_servers` — server name → on/off (never a server's configuration); and
  `content.settings` — section → field → value, as `agents.updateSettings` takes them. A part the
  agent did not have when saved is `null` and is left alone on activation.
- **Never a secret.** Providers are named by id and MCP servers by name; a settings field of
  kind `secret`, and any text value carrying a user and password (`http://user:pass@proxy`), is
  not saved — and not written on activation, even from a preset stored before the rule.
- **Operations.** `agents.listPresets` and `agents.getPreset` (whoever may read the agent's
  settings), `agents.createPreset` (new: save the current settings under `name`; a name used by
  another preset of the agent in the profile is `409 conflict`, more than 50 is `409
  state_invalid`), `agents.deletePreset` and `agents.activatePreset` (owners and admins).
- **Activating goes through the existing operations, as the caller.** `models.setDefaults`,
  `agents.update`, `agents.updateSkill`, `agents.updateMcpServer` and `agents.updateSettings`,
  with the caller's own credentials, so every check, event and restart those make happens as from
  the pages. Only what differs from the agent's current state is written. What is gone since the
  preset was saved (a provider, a skill, a server, a section) comes back in
  `AgentPresetActivation.skipped` with the refusal's code, and the rest still applies;
  `restart_job_ids` are the restarts the settings asked for. Saving reads through the matching
  read operations the same way.
- The old `AgentPreset` shape (`trust`, `is_default`, `broken`, `content` as text) and
  `authorable` are gone: the operations were 501 and no client used them. `AgentSection.presets`
  stays declared and unused; the web shows presets as a card on the agent's Settings page.
- Rejected: storing a copy of Hermes's `config.yaml` (it holds keys and would bypass every
  check); a preset shared across profiles (the providers and skills differ per profile).

## 101. Linked hubs: invite, approve, signed calls, shared agents and one tool-free question

Proposed — owner to confirm; the threat model and the reasons are ADR 0026.

- **`Peer`** now says `hub_name`, `direction` (`inbound`: it used this hub's invite;
  `outbound`: this hub used its invite), `status` (`pending` for this owner, `waiting` for
  theirs, `linked`), `enabled`, `fingerprint` (SHA-256 of its Ed25519 key, 16 bytes in hex
  groups), `asks_per_hour` and `approved_at`. `inbound_status`, `outbound_status` and `online`
  are gone (the operations were 501; nothing used them).
- **Pairing.** `devices.createPeerInvite` answers `PeerInvite` (a single-use link valid 10
  minutes carrying this hub's fingerprint, and the fingerprint). `devices.requestPeer` redeems a
  link and answers `201 Peer` (`waiting`) — synchronous, no job: the refusals are
  `invite_refused`, `fingerprint_mismatch`, `peer_unreachable` (`409 state_invalid`) and
  `https_required`, `own_url_not_https`, `invite_url_invalid` (`400`). `devices.updatePeer`
  takes `PeerPatch`: `approve: true` (a `pending` peer only), `name`, `enabled`,
  `asks_per_hour`. `devices.deletePeer` revokes at once and is also how a request is refused.
- **Controls and log.** `devices.listPeerShares` / `devices.setPeerShare`: every agent of every
  profile with its share switch (off until switched on) and an optional description peers see.
  `devices.listPeerEvents`: the last 200 audit lines of a peer (`PeerEvent`), kept after it is
  deleted, never a question's words.
- **Using a link.** `devices.listPeerAgents` (the peer's shared agents: `PeerAgent`, whose id
  is the share's, not the agent's) and `devices.askPeerAgent` (`PeerAsk` → `PeerAnswer`).
- **Hub to hub** (not client APIs, `security: []`, signed per ADR 0026): `devices.peerJoin`
  (the invite redeemed; signed with the key it registers), `devices.peerNotice` (`approved` /
  `unlinked`), `devices.peerAgents`, `devices.peerAsk` (answered without tools within 120 s;
  `403` for an unshared or unknown agent alike, `429` past `asks_per_hour`, `422
  agent_unavailable` when the agent gave no answer).
- Every operation on this hub's side is for owners and admins, including asking.

## 102. Web follow-ups: memory entries and their budget, a live run's changes, the window by category

Proposed — owner to confirm (the fork gap list, batches B10 and B19, 2026-09-27: items the earlier
records left as "later").

- **A memory list comes with its entries and its budget.** `MemoryItem` gains `entries` (a list
  document's entries as Hermes reads them: split on a `§` line, trimmed, empty ones dropped),
  `char_limit` (Hermes's `memory.memory_char_limit` / `memory.user_char_limit`, else its defaults
  2200 / 1375) and `char_count` (code points of the entries joined, what the hub's
  `memory_too_long` measures). All three are `null` for `soul`, which is one text, and optional, so
  a client still splits `content` on an older hub. The web draws each entry on its own with edit and
  remove, adds one at the end, and shows the list against its budget (a bar that warns from 80 %
  and says "full" past it); a write that would grow a list past its budget is held back with the
  reason before the hub has to refuse it. Editing one entry sends the whole list, as before: no
  per-entry operation (Hermes's file has no ids, and a second writer would race it).
- **A run's changes while it is still going.** `sessions.getRunChanges` on a run in flight answers
  the working folder compared with the run's start **now**, `RunChanges.live: true`, instead of
  `404`: the same comparison the run's end records (§49), kept nowhere. One look is shared for two
  seconds, so several viewers cost one comparison. Its files carry no diff to fetch yet
  (`getRunChangeDiff` stays `404` until the run ends). The web draws it under the live reply as the
  same card with a "so far" mark, read again every four seconds and whenever a tool call ends, with
  rows that open nothing; the recorded card takes over at the end. Rejected: a realtime event per
  change (a run that rewrites a file in a loop would flood every viewer), and diffs while live (they
  would have to be computed per look).
- **The window by category.** `sessions.getContextBreakdown` (`GET /sessions/{id}/context`) answers
  `SessionContextBreakdown`: the categories Hermes counts with `session.context_breakdown`
  (observed in Hermes v0.21.3, the pinned image: `system_prompt`, `tool_definitions`, `rules`,
  `skills`, `mcp`, `subagent_definitions`, `memory`, `conversation`, each with its English label and
  a token count; Hermes's own CSS colour is dropped), `used_tokens`, `window_tokens`, `estimated`.
  It asks only a conversation the agent already has open and never opens one for it; with none
  open, or an agent that cannot tell, it answers `available: false` with no categories rather than
  an error. The web reads it only while the context meter's details are open, draws one bar of the
  window in the chart palette and a line per category (names it knows in the person's language,
  Hermes's label for any other), and says the per-category counts are the agent's rough estimate.
- **A category's colour** is picked from eight swatches or none (`SessionCategory.color`, already in
  the contract, now set from the chats list's category menu and drawn as a dot before its name). A
  fixed set rather than a free picker, so a colour reads as itself on light and dark alike.
- **The pending-actions sheet** counts, for an admin, the memory and skill writes Hermes's agent
  staged for review in the profile they are in (§58's `agents.listPendingWrites`) and answers them
  right there; and a room's question opens its room (`/rooms/<id>`, with `?profile=` when it waits in
  another profile, which the room page now honours).
- **A member whose remembered profile was taken** (or archived) but who still has others is moved
  to the first profile they were given, instead of pages that each answer "not found".
- **Workflow limits** live in the editor's side panel while no step is selected (the workflow's own,
  §53), and the Run button has a companion "run with limits" that opens on the workflow's limits
  and sends `WorkflowRunRequest.limits` for that run only.

## 103. Hermes-facing follow-ups: a card's history and bulk edits, Hermes's skill switch and platforms, names from Hermes, channel paging and pictures

B17 of the fork gap list. What Hermes does was read in its MIT source at the pinned `v2026.9.14`
and is said here in our words; each point was run against the real Hermes of the image
(`*.real.test.ts`). Proposed — owner to confirm:

- **A Hermes card's history.** Hermes's kanban answers a card with its event log (what happened:
  `created`, `claimed`, `edited`, `reprioritized`, `commented`, `review_requested`… with details
  and the attempt it belongs to) and its runs (each attempt of its dispatcher: the profile that
  worked it, its status and outcome, the worker's summary or error, when it started and ended)
  (`plugins/kanban/dashboard/plugin_api.py` §get_task, `hermes_cli/kanban_db.py` §Event, §Run).
  `TaskDetail.hermes` carries them, newest first, at most 100 events and 20 runs, texts cut at
  4 000 characters; `null` for a hub card and for a Hermes card Hermes did not answer just now.
  Hermes's own words: a client names the kinds it knows and shows any other as Hermes wrote it.
- **Bulk edits of Hermes cards.** `TaskBulkUpdate.patch.comment` says the same words on every
  task in the caller's name — on a Hermes card on Hermes first, then read back, as one comment is;
  `priority` was already set on Hermes first. A refusal is that task's `ok: false`, the others
  stand. The web board gets "Select": ticks on the cards, one priority or one comment for all,
  one request per profile the ticked cards are in. Rejected: Hermes's own `POST /tasks/bulk`
  (it takes no comment, and the hub keeps its per-card reflection in step one card at a time).
- **Skills: Hermes's own switch.** Hermes keeps "off" in the profile's `config.yaml`,
  `skills.disabled` (a list of names; a lone string is one name), written sorted by its dashboard
  and `hermes skills`; `hermes-agent`, its manual, is never off (`agent/skill_utils.py`
  §get_disabled_skill_names, `hermes_cli/skills_config.py`). The hub now reads and writes that
  list: a skill in it reads `enabled: false`, and `agents.updateSkill` puts a name in or takes it
  out, leaving the rest of the file as it was. That works for built-in skills too — the files are
  not touched — and `hermes-agent` is `409 skill_essential`. Switching on also renames back a
  `SKILL.md.off` an older hub left. Rejected: keeping the rename (Hermes and the hub would
  disagree about what is off).
- **Skills for another system are not listed.** A `platforms:` front matter (`[macos]`,
  `windows`, a block list) that leaves out the system the hub runs on means Hermes never loads the
  skill there (`skill_matches_platform`), so the hub leaves it out as Hermes's list does. A skill
  Hermes offers only inside one of its contexts (`environments:`, e.g. a kanban worker) is still
  listed: it is the profile's skill and may be switched off, though Hermes's dashboard hides it.
- **Names from Hermes.** A display name is `display_name` in a profile's `profile.yaml` (for
  `default`, in Hermes's home itself), shown beside the id and never used to find it
  (`hermes_cli/profiles.py` §read_profile_meta). Listing profiles now reads it: a Hermes profile
  the hub adopts takes it (its id when it has none), and a workspace whose Hermes display name
  was changed outside the hub takes the new one. A Hermes profile without a display name leaves
  the hub's name alone (a name Hermes refused is not undone). The name given at first-run setup
  is written as `default`'s display name.
- **Channel conversations: paging.** Hermes lists sessions 100 at a time with `offset` and a
  `total`, and pages a transcript back from the newest with `order=latest&limit&offset`
  (`hermes_cli/web_routers/sessions.py`). `sessions.listChannelConversations` takes `limit`
  (1–1000 per profile, 100 by default; the hub reads as many pages as that needs) and answers
  `has_more`; `sessions.listChannelMessages` takes `offset` and answers `next_offset`. The web
  offers "Older channel conversations" and "Load older messages".
- **Channel conversations: pictures.** Hermes's gateway saves a picture in the profile's image
  cache (`cache/images/`, or `image_cache/` on older installs), deletes it after 24 hours, and
  stores only a note naming the file — `[Image attached at: <path>]`, a `vision_analyze …
  image_url: <path>` note after describing it, or `[User sent an image: <path>]`
  (`gateway/run_inbound.py`, `agent/image_routing.py`, `agent/session_persistence.py`). The hub
  takes the picture's name out of those notes on a person's message (PNG, JPEG, GIF or WebP), drops
  the notes from the words shown, and lists it in `ChannelMessage.attachments` with `available`;
  the new `sessions.getChannelPicture` serves it by name from that profile's cache only
  (`private, no-store`, `nosniff`), `404` once Hermes has deleted it. The web draws it in the
  bubble, or says Hermes no longer keeps it.

## 104. A task's definition of done and constraints

B18 of the fork gap list (AB 1.1, 1.2). Proposed — owner to confirm:

- **Two lists on a task**, `Task.definition_of_done` and `Task.constraints` (`TaskCheckItem`:
  `text` 1–500, `checked`), at most 30 lines each, always sent. Written with `TaskCreate` and
  replaced whole by `TaskPatch` (`TaskCheckItemWrite`, `checked` optional); empty lines are
  dropped, texts trimmed.
- **Sent with the run.** The task's prompt gains "Definition of done — the task is done only when
  every one of these holds" and "Constraints — keep to these while you work", in the run's
  language, after the checklist.
- **Ticked at review.** `checked` is the reviewer's tick: the web enables the boxes only while the
  task is in review and saves them with the dialog's Save. **A new run clears every tick**: they
  were about the last attempt's work.
- **The board card** counts the ticked lines of the definition of done (`✓ 1/3`), with the full
  sentence on hover.
- **Hermes's cards take none** (`409 conflict`, `hermes_owns_card`, `action: definition_of_done`):
  Hermes's worker is briefed by the card itself, so lists it never sees would only look kept. A hub
  task handed to Hermes and started carries its lists into the Hermes card's brief.

## 105. An agent may ask its person's phone where it is; the phone asks the person first

Proposed — owner to confirm (2026-09-27, phone parity). §74 built the request and §89 let a run ask a
computer for files and programs; an agent still could not ask a phone for its location, and neither
app answered a request (the owner's B8).

- **A run token may create `location` requests** to its own person's devices, like `files` and
  `apps` (§89); every other capability still needs the `device` scope. Everything else of §74
  stands: only that person's device, the profile the device allows, answered once, by the device.
- **The hub's `devices` tools gain `devices.locate`** (read): the phone to ask is the one named, or
  else the one that declares `location` switched on and may be asked in the profile, connected
  first, then seen last; its answer is `{device, latitude, longitude, accuracy_m, captured_at}`. The
  agent says why in `why`, which becomes the request's `purpose` and is what the person reads. A
  refusal, no answer in 90 s (the default wait for `location` now, long enough to read and answer)
  or no phone that can tell is a tool refusal the agent reads (`device_denied`, `device_timeout`,
  `device_capability_off`).
- **The phones declare `location`** in their registration and answer pending requests (a
  `request.created` on `/rt/devices`, and `listRequests?status=pending` on connecting): a consent
  prompt the first time — «Allow every time», «Only this time», «Don't allow» — then the operating
  system's own location permission; «every time» and «never» are kept on the phone and changed under
  This device. A phone that is not connected answers when it next connects, within the wait.

Rejected: a standing permission kept by the hub (the person decides on the device that has the
location, where they can see it happen); a background location the phone keeps sending (the
request is one answer, as §74 says).


## 106. Catalog agents from a pinned release download; an agent signs in to its own account

Proposed — owner to confirm (2026-09-27, catalog recipes, B21). Every catalog agent so far was an
npm package. Goose and Grok Build ship as native binaries, and Kimi Code and Grok Build keep their
own vendor account rather than reading a provider key.

- **A catalog entry may install from a release download** (`install.kind = download`): one file per
  platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`), each an `https`
  URL that names the pinned version, its SHA-256, and how the executable is packed (`raw`, `gz`, or
  `tar.gz` with the executable's path inside). The hub fetches the file for its own platform into a
  staging folder beside the agent's, **refuses it unless the SHA-256 matches** (before unpacking or
  running anything), unpacks only the named executable into `bin/`, and only then replaces
  `<DATA_DIR>/agents/<id>` — so a refused or failed download leaves the previous install as it was.
  Still ADR 0006: the data volume, one folder per agent, no image or Compose change.
- **Such an agent is updated only by the catalog** (a pull request that moves the version and every
  hash together): there is no registry to ask, `install.package` is `null` and
  `auto_update_supported` is false; `pinned_version` is the release.
- **The catalog gains Goose 1.52.0** (Block / Agentic AI Foundation, Apache-2.0, `goose acp`) and
  **Grok Build 1.0.41** (xAI, Apache-2.0, `grok agent --no-leader stdio`), each hash checked against
  a fresh download of the vendor's own file (GitHub's published digests for Goose; the storage MD5
  for Grok Build, which publishes no checksum). Windows is not offered for either (Goose publishes a
  `.zip`, Grok Build a bare `.exe`). Goose needs `GOOSE_PROVIDER` and `GOOSE_MODEL`, set in its
  `~/.config/goose/config.yaml`, which the Config files page now edits (§78).
- **An agent may sign in to its own vendor account** (`agents.startSignIn`, `agents.getSignIn`,
  `install.sign_in`): the catalog names the agent's own device-code command (Kimi Code
  `kimi login --region global`, Grok Build `grok login --device-auth`); the hub runs it, answers
  with the link and code it printed as a `ProviderSignIn`, and follows the process — running is
  `pending`, exit 0 `approved`, a reported refusal `denied`, any other exit `failed` with its last
  line, a code past its lifetime `expired` (the process is stopped). The agent keeps the credential
  under the hub user's home, for every profile; no token passes through the hub. Admins only; one
  at a time per agent; kept in memory like a provider sign-in.
- **Kimi Code's region is `global` (kimi.ai)**; the mainland-China kimi.com account is not offered.
  Kimi Code's API-key route stays its `config.toml` on the Config files page.

Rejected: running a vendor's install script (`curl … | bash`: it takes "latest" and checks
nothing); following a "latest" link (the hash would stop meaning anything); unpacking the whole
archive into the agent's folder (only the executable the entry names is taken).

## 107. Push follow-ups: a browser's Web Push ends with its sign-in, dropped registrations are announced, the apps prove the device to the relay

Proposed — owner to confirm (2026-09-27, B16; docs/changes/2026-09-27-twuijri-push-followups.md).
No path or schema changes; `device.updated` names one more cause.

- **A browser's Web Push lives as long as the sign-in that registered it**, like a phone's
  (docs/changes/2026-09-26-twuijri-push-cleanup-mobile-logs.md): `devices.registerPush` records the
  sign-in for every provider, and every way a sign-in ends forgets the registration. A browser
  subscribed before this keeps its registration until it is turned off or unlinked.
- **The web hands the subscription back after a sign-in**, silently, only while the browser's
  permission is granted, it still holds a subscription, and the person signing in is the one who
  turned push on in that browser (remembered in the browser's storage). Another person signing in
  to the same browser is not subscribed; they turn it on themselves. Never on a page load that was
  already signed in (its registration stands) and never with a permission prompt.
- **`device.updated` when the hub drops a registration on its own** — the sign-in that made it
  ended, or the push service called the token dead — to the device's person, from the row as it is
  after the change (announced on the next turn, so a transaction that rolled back announces what it
  kept). A device revoked at the same time is announced by whoever revoked it (`device.unlinked`, or
  `device.updated` on a logout).
- **The apps send `PushRegistration.relay_proof`** (ADR 0024 §6) with every registration: a P-256
  key made once per install — a software key kept in the iOS Keychain (this device only, after first
  unlock), a Keystore key on Android whose private half never leaves it — signs
  `corehub-push-bind-v1`, the platform, the token and the unix time. No key, no proof: the
  registration goes on without one. The hub forwards it unread (unchanged since §82). A registration
  the relay could not bind at that moment is bound later without it: a proof is good for ten minutes.
- **The FCM installation id is not used**: neither ADR 0024 nor the push records depend on it; the
  hub and the relay address FCM registration tokens (HTTP v1 `message.token`), and the device proof
  already identifies the install to the relay.
- **iOS, signed out by the hub** (a 401 at launch or on a call): the app forgets the token it held
  and unregisters from APNs, so APNs refuses the old token to any hub or relay still holding it; the
  next sign-in registers again. The proof key stays (it is the install's). Signing out on purpose
  still tells the hub first and leaves APNs registered.

Rejected: subscribing a browser on sign-in without a subscription it already holds (that is the
person's choice on the Notifications page); the Secure Enclave for the iOS key (not in the simulator
the CI tests on, and the relay's risk model — ADR 0024 §6 — does not need a key that cannot leave
the phone).

## 108. The Android APK finds, downloads and installs a newer release from GitHub by itself

Proposed — owner to confirm (2026-09-26; the owner's request «خل الاندرويد … يكتشفون التحديث اذا نزل
تحديث»; docs/changes/2026-09-26-twuijri-android-updates.md). No path or schema changes.

- **The source is GitHub, not the hub's `updates` shelf**: `GET
  https://api.github.com/repos/twuijri/core-hub/releases/latest`, no token, only
  `CoreHub-Android/<version>` in the User-Agent — the same source as the desktop app (ADR 0023) and
  the download page. The phone no longer asks the hub's shelf; `updates.*` stays in the contract for
  the other clients and a later second source.
- **When**: each time the app comes to the front, at most once every **six hours** (the last check is
  kept on the phone), and whenever the person presses *Check for updates* on This device. A rate
  limit counts as a check; no network does not (asked again on the next return).
- **What counts**: not a draft, not a pre-release, a plain `X.Y.Z` tag newer than `versionName`
  (semantic order), carrying `Core-Hub-X.Y.Z-android.apk` under this repository's release downloads.
- **What the person sees**: a compact card on New chat (*Update* / *Later*), a row in Settings and a
  part of This device (installed version, the new one, *What's new* on GitHub, *Check for updates*).
  **Later hides that version's card until a newer one**; Settings and This device still offer it.
- **Update downloads and installs** (as the desktop `.exe`, macOS app and AppImage do since §109): the APK
  goes to the app's cache with a progress bar, is kept only when its size equals the release's (and
  its SHA-256 equals GitHub's `digest` when listed), then goes to Android's installer through the
  FileProvider, which asks the person. Without *Install unknown apps* the card opens that setting and
  says so in one line. An install needs the same signing key as the installed app.
- **No background notification**: the check only runs with the app in front, so nothing is posted;
  a notification for a release found while closed would need a background worker — not added.
- **Switchable per build for Google Play**: `-Pcorehub.selfUpdate=false` /
  `COREHUB_ANDROID_SELF_UPDATE=false` sets `BuildConfig.SELF_UPDATE = false` (never asks, never
  offers; This device says Play keeps it up to date) and removes `REQUEST_INSTALL_PACKAGES` from the
  manifest. The GitHub APK keeps it on by default.

Rejected: Play's in-app updates API (not for an APK outside Play); a silent install (Android always
asks, and the owner has not decided silent updates); checking on every return (GitHub allows 60
calls an hour per address without a token).

## 109. The desktop apps update themselves from the GitHub releases; the Store and the .deb do not

Proposed — owner to confirm (2026-09-26; owner: «خل الاندرويد والماك والويندوز واللينكس يكتشفون
التحديث اذا نزل تحديث»; docs/changes/2026-09-26-twuijri-desktop-updates.md). No path or schema
changes: the desktop app and the web page it shows only. Supersedes ADR 0023 §6 for the builds
below; §108 is the Android side.

- **How each copy updates** (`updateMode` in `apps/desktop/src/shared/updates.ts`): the Windows
  `.exe` (NSIS), the macOS app and the Linux AppImage **install**; the Linux `.deb`, a development
  run and a packaged app run from its folder only **notify**; the Microsoft Store build (MSIX,
  `process.windowsStore`) is **off** — the Store updates it and the app never asks GitHub. The
  AppImage is told by Electron's `APPIMAGE`, the `.deb` by electron-builder's
  `resources/package-type`.
- **Install** is electron-updater (MIT, bundled into the main process) with the GitHub provider on
  `twuijri/core-hub`, stable releases only (`allowPrerelease: false`, no downgrade). It reads the
  latest release's `latest.yml` / `latest-mac.yml` / `latest-linux.yml` from github.com without a
  token, downloads the new version in the background, and checks its SHA-512. It **never restarts
  on its own**: the page floats *Restart to update* / *Later* (a toast-like card, `UpdateNotice`),
  the menus and tray offer *Restart to update to X*, and a downloaded version is installed when the
  app quits. The OS notification says it once per version, only when no app window is in front.
  macOS updates from a zip of the same signed, notarised app (Squirrel.Mac takes only a zip and
  checks the signature); the unsigned Windows `.exe` is checked by its SHA-512 only. When the feed
  cannot be read, the releases API may still say a newer version is out (notify fallback).
- **Notify** asks GitHub's releases API (as before) and says *Core Hub X is available* with a
  button to the download page, https://twuijri.github.io/core-hub/. Nothing is downloaded.
- **When**: about ten seconds after start, then every six hours while the app runs, and whenever
  the person asks — *Check for updates…* in the app menu (macOS), Help (Windows, Linux) and the
  tray, or *Check now* in This device. The switch in This device (`desktop.json`
  `updates.auto`, on by default) turns the automatic looks off.
- **The release carries** `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, the blockmaps the
  build made, and `Core-Hub-X.Y.Z-arm64-mac.zip` beside the dmg. The files the feeds name are the
  release files under the very same names; `release-assets.mjs` refuses to publish otherwise, and
  the packaging jobs check each feed right after it is written. A tag whose code predates this has
  no feeds (`--without=updates`).
- **Copies of 1.1.2 and older have no updater**: their owners install 1.1.3 by hand once.

Rejected: restarting to install without asking (a restart is the person's choice);
self-installing the `.deb` (electron-updater would run `pkexec dpkg`, a root password prompt for
an update the person did not ask for); a check in the Store build (the Store delivers its updates; a
second path would fight it); our own feed or server (GitHub already serves the release files,
without a token); checking once a day as before (a fix could wait a day to be seen).

## 110. A shared models catalogue every hub reads, every GPT Image model, and the newest Codex CLI

The owner, testing hub 1.1.2 (2026-09-26): the chat models of his ChatGPT subscription now match
CLI Proxy API's, but CLI Proxy API offers five image models and the hub one; "there, the moment
ChatGPT added models they showed up; here not"; and many people do not pull a new image for
months, so a list built into the image goes stale — models missing, or gone and failing. He wants
one file in our repository that every hub reads, for every provider, not only ChatGPT's images.
Observed in CLI Proxy API (MIT, router-for-me/CLIProxyAPI, read only): the Codex backend lists no
image model, and CLI Proxy API keeps `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5`,
`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` in its code and hands the chosen one to the same
`image_generation` tool §84 uses; its catalogues are refreshed at run time from its own
repository. Proposed, owner to confirm:

- **`catalog/models.json`, read by every hub** from
  `https://raw.githubusercontent.com/twuijri/core-hub/main/catalog/models.json` at most every twelve
  hours when a list is asked for (waiting at most five seconds), no token, no new image. It holds,
  per provider (Hermes provider id for a signed-in provider, preset slug for a key provider):
  `models`, `image_models` and `client_version`. It is data only: names must look like model ids,
  image names like `gpt-image-…`, versions like X.Y.Z; the rest is ignored; a file that does not
  parse is as if absent. `COREHUB_MODELS_CATALOG_URL` points a hub at its own copy (`https://`
  only) or turns the reads off.
- **Which list wins**: a list the provider answers for the account always does (§83). The
  catalogue's `models` are offered only when the provider cannot be asked — instead of the list
  built into Hermes's image, which ages with it — still marked `fallback` with the reason.
- **Every image model the subscription's tool takes is offered** (amends §84's "one model"): the
  catalogue's `image_models` for `openai-codex`, else the built-in five, newest first, each with
  `image_output`; `COREHUB_CODEX_IMAGE_MODELS` adds names. A removed name disappears from every hub
  on its next refresh. Drawing accepts any `gpt-image-…` model already on the provider.
- **The subscription's list is asked as the newest Codex CLI** (amends §83): the latest `rust-v*`
  release of github.com/openai/codex (public API) read at most every twelve hours, or the
  catalogue's `client_version`, whichever is higher, never below `CODEX_CLIENT_VERSION`;
  `COREHUB_CODEX_CLIENT_VERSION` still pins it.
- The catalogue changes by pull request like any file; a test checks it parses.
- **A weekly watcher, and every provider filled** (added 2026-09-26, proposed — owner to confirm):
  the file holds a list per provider that has a fixed public one, read from the provider's own
  models and deprecations pages (change record `2026-09-26-twuijri-models-catalog-providers`); a
  test fails CI on a key a hub never looks up or an id a hub would drop. A speech preset's list is
  of its own kind, and replaces the documented list built into the image for a provider with no
  list endpoint (§94). `.github/workflows/models-catalog-watch.yml` compares the file every Monday
  with CLI Proxy API's public catalogues and keeps one issue (label `models-catalog`) of ids seen
  there and not here, and ids here no source lists any more; it never edits the file or pushes.

## 111. A turn's tool activity: a live window, then one folded row

The owner, with an iPhone screenshot (2026-09-26): every tool the agent used was its own big card
stacked above the answer (skill_view, vision_analyze, terminal, vision_analyze …) — noisy on the
web, worse on the phone. He wants it like an activity view: while the agent works only the latest
few steps, and when the turn ends one compact row that opens when the person wants to read them or
see what failed; the answer stays the main thing on screen. No contract change: every client reads
the `ToolCall`s it already has. Proposed, owner to confirm:

- **The live window is 4 calls on the web and 2 on a phone** (iOS, Android). A call still running or
  waiting for approval is always in view, and so is one that **failed**, until the turn ends — an
  error never scrolls out of sight while the agent carries on. The rest are one «+k خطوات سابقة» /
  "+k earlier steps" line that opens them and folds them back. A new step slides in and an old one
  leaves with a fade; nothing moves under reduced motion on any platform.
- **When the turn has ended** (the message is no longer streaming and no call runs or waits) every
  call folds into **one row**: how many steps, how long, how many failed (in the danger colour, only
  when some did) and the latest tools' names as small chips (three on the web, two on a phone). A
  click or tap opens the full list with the same cards as before. What is open is per message and
  never saved.
- **"How long"** is the wall-clock time from the first call's start to the last call's end when
  every call carries both; otherwise the calls' durations summed; otherwise nothing is shown.
  Under a minute it reads «42 ث» / "42s", from a minute «1 د 05 ث» / "1m 05s", never below one
  second.
- The rule is one pure function per client — `toolActivity` (web), `ToolActivity` (Android and
  iOS) — tested the same way on all three. The questions the agent asked (`clarify`) keep showing
  as they do (web: `AnsweredQuestions`).

## 112. The sidebar folds into a rail of icons; the Runtime card is one counted line; new speech-to-text rows start on gpt-transcribe

The owner approved three parked web items on 2026-09-26: a ChatGPT-style sidebar that folds to
icons, the Runtime checklist folded when there is nothing to read, and a successor for
`whisper-1`, which OpenAI shuts down on 2027-02-26 (`gpt-transcribe` replaces it). Proposed, owner
to confirm:

- **The rail (web and desktop).** On a window at least 48rem wide the sidebar folds to a rail of
  icons one large control wide, from a toggle in the brand row or `Ctrl+Shift+S` (`⌘⇧S` on a Mac —
  ChatGPT's own shortcut for this; matched on the physical S key so an Arabic layout works). The
  rail carries the same entries in the same order under the same keys — `rail`, then `chat` and
  `rooms` as two icons that unfold the sidebar on their list, and inside Settings or an agent their
  lists as icons — each row keeping its words as its accessible name and showing them as a tooltip
  toward the page. The footer becomes one button (the person's initial and the connection dot)
  whose menu holds Settings, the language, the theme, sign out and the version. The choice is this
  browser's (`localStorage`, read in try/catch), not the account's. The width eases over the motion
  token (instant under reduced motion), and in Arabic the rail is on the right. It adds no
  destination and no entry; the phone drawer never folds. No contract change.
- **The Runtime card.** When every check passes it is one line — «وقت التشغيل جاهز · الفحوص 4/4» /
  "Runtime ready · 4/4 checks" — and the whole line is the button that opens the list. When any
  fails it is open by itself, says how many passed («نجح 2 من 4 فحوص»), and lists the failing
  checks first, each half in the order the steps happen in. The chat's failure notice still shows
  only the failing checks.
- **Speech-to-text default.** The `openai-stt` preset's model is `gpt-transcribe`. A preset's
  settings are copied into a row once, when it is created, so only new rows take it: a row that
  already holds `whisper-1`, or any model somebody chose, keeps it until a person changes it. The
  OpenAI-compatible transcription adapter still asks for `whisper-1` when a row has no model at all,
  which is what self-hosted Whisper servers answer to.

## 113. Latin digits in every client, also in Arabic; the phone's profile chip sits in the drawer's footer

Decided by the owner on 2026-09-26 (before the apps night), not proposed:

- **Latin digits (123) everywhere.** Every client — web, desktop, iOS, Android, the CLI and the hub's
  own messages — shows numbers, durations, sizes, dates and times, counts, percentages and version
  numbers with Latin digits, in the Arabic UI too. Arabic words, plural forms and RTL stay («43 ث»,
  «12 خطوة», «26 سبتمبر 2026»). Android was the odd one: it followed the Arabic locale's digits
  («٤٣ ث» in the tool-activity row), while the web and iOS mostly showed Latin. It is done once per
  client, on the locale used for formatting, not per screen: the web's `intlLocale` (`ar-u-nu-latn`
  for every `Intl` formatter and `toLocale*String`, guarded by a test that reads the source), iOS's
  `AppLanguage.locale` / `Locale.latinDigits` (`@numbers=latn`, and byte counts through
  `ByteCountFormatStyle` with that locale instead of the phone's), Android's `Digits` (the
  activity's configuration and the process default carry `-u-nu-latn`, so `stringResource`,
  plurals, `String.format`, `Formatter` and `DateUtils` all agree — also when the app follows an
  Arabic phone). The string catalogues hold no Arabic-Indic digits either; `pnpm i18n:check` fails
  on one (the JSON catalogues and Android's `values-ar`). Content the person or the agent wrote is
  shown as written.
- **The phone's profile selector is a small chip in the drawer's footer**, beside the account name
  and the connection dot (iOS and Android), opening the same picker; it left the top of the drawer.
  Web and desktop keep it in the top bar. It stays what NAVIGATION.md rule 4 says: one concrete
  profile, never «all», it switches `X-Hub-Profile` in place and never navigates. The header of an
  agent's pages on iOS keeps its full-width selector, because those pages edit one profile.

## 114. The generated phone clients send `null` when the contract asks for it

Proposed on the apps night (2026-09-27) — owner to confirm. It changes no wire shape; it lets the
Kotlin and Swift clients send what the contract already allows.

The generated Kotlin client left every `null` out of a request (`explicitNulls = false`, so a PATCH
built from a model does not clear fields it did not mean to touch) and the Swift one did the same
(`encodeIfPresent`). So the phones could not say "set this to null" — back to the agent's default
model (`SessionPatch.model: null`), give a chat's naming back to the hub (`title: null`, §26), clear a
task's description — and a body whose schema **requires** a property that may be null was refused
with 400: a schedule's `trigger` and `target` list every field as required, some of them null, so
the phones' create, edit and next-run preview never passed the hub's contract check (batch 3 had
patched it per app with a `ScheduleBodies` interceptor, now removed).

The rule, read from the contract for every schema a JSON request body can hold (components, inline
bodies, inline object properties and inline array items, `$ref` aliases followed):

- a property that is **required and admits `null`** is always written, `null` when unset;
- a property that is **optional and admits `null`** stays absent when unset (a PATCH still changes
  only what it names), and is written as `null` only when the caller lists it in the model's
  `sendNull` set — `SessionPatch(sendNull = setOf(SessionPatch.Clearable.MODEL))` in Kotlin,
  `SessionPatch(sendNull: [.model])` in Swift. `Clearable` holds exactly those properties, so the
  compiler refuses a field that cannot be cleared. A listed property that holds a value is sent with
  its value;
- read-only properties are never written; response decoding does not change.

It is made by `packages/contracts/scripts/explicit-nulls.mjs` after generation, like the multipart
and serializer patches: Swift models get `sendNull`/`Clearable` and an `encode(to:)` that writes
`encodeNil` where the rule says (nested models encode themselves); Kotlin models implement
`ExplicitNulls` (an interface written next to the client), whose `withExplicitNulls` puts the nulls
back into the JSON tree, nested models, lists and maps included, and `ApiClient` sends every JSON
body through it. The patch fails generation when a line it expects is not in the generator's output,
and when a nullable property sits in an inline object it cannot name (make that object a component).

Rejected: `explicitNulls = true` in Kotlin (every untouched field of a PATCH would clear what it did
not name); a tri-state wrapper type per property (`NullEncodable` in the Swift generator, a
`Patch<T>` in Kotlin), which changes the type of every nullable request field and every call site
that builds one; and per-app interceptors that rewrite bodies after encoding (what batch 3 did), which
each screen would have to know about.

## 115. A notify webhook belongs to the profile its request names, and says so in the contract

Proposed on the apps night (2026-09-27) — owner to confirm. The wire does not change: the header
the hub already read is now declared.

§4 listed `notify` among the global operations that ignore `X-Hub-Profile`, and the seven webhook
operations (`notify.listWebhooks`, `createWebhook`, `updateWebhook`, `deleteWebhook`, `testWebhook`,
`listWebhookDeliveries`, `redeliverWebhookDelivery`) were marked `x-scope: global` with no profile
parameter. The hub did otherwise since §59: it stores each webhook in the profile of the request
(`X-Hub-Profile`, `default` when absent) and finds it there again, so switching profiles lists a
different set, and the web — whose client sends the header on every call — worked. The generated
phone clients send only what an operation declares, so the phones listed and wrote the default
profile's webhooks whatever profile they were in, until batch 10 added the header by hand (an OkHttp
interceptor on Android, `customHeaders` on iOS).

Now the seven operations declare `X-Hub-Profile` (the shared `Profile` parameter) and drop
`x-scope: global`; the generated clients take the profile as their first argument like every other
profile-scoped call, and the hand-added header is gone. On the hub the route's guard now resolves
the profile before the handler (`requireWorkspace`), with the same answers as before: an unknown or
forbidden slug is `404 profile_not_found`, and no header still means `default`. The event catalogue
(`notify.listWebhookEvents`) stays global — it is the same in every profile — and so do the inbox and
the notification preferences, which belong to the person.

Rejected: keeping the interceptors (every client would have to know which global operations are
secretly scoped), and a `?profile=` query form (§4 rejected it for all operations).

**Amended 2026-09-27 (hotfix, compatibility rule — ADR 0027 when merged): the header is optional.**
Making `X-Hub-Profile` required on these seven operations broke every client built for v1.1.2 (the
older phone apps, the CLI, scripts), which send no header. They now reference `ProfileOptional`
(`required: false`) and carry `x-scope: global` again, as in v1.1.2; `Profile` and every other
operation are unchanged. Sent, the header is honoured as above (an unknown or forbidden slug is
`404 profile_not_found`), so the generated clients — which pass it by name — keep their per-profile
behaviour. Absent, the request is answered exactly as v1.1.2 answered it: from a `?profile=` value
when one is given (v1.1.2 read it here; v1.1.3 had silently dropped it, so such a script wrote into
`default`), otherwise from `default`. The `?profile=` form stays undocumented as an input for new
clients (§4); it is kept only so an old script keeps working.

## 116. An archive can replace the default profile; the old default is kept as `default-backup`

Proposed (2026-09-27) — the owner asked for it and confirmed the design (the backup names never run
out; any failure leaves the original default exactly as it was); the details are the owner's to
confirm.

People moving to the hub bring their old program's default profile. `auth.importProfile` always made
a new profile beside the default, because Hermes refuses to import as `default`: the default profile
is Hermes's root home, not a folder under `profiles/` (`hermes_cli/profiles.py` §import_profile,
v2026.9.14), and Hermes has no operation that turns the root into a named profile either.

`ProfileImport.replace_default: true` (optional, absent = the old behaviour) makes the archive the
default. The hub itself moves files inside Hermes's home, on one filesystem, with a journal:
1. The whole archive is checked first (§34's checks, the providers file of §37), then unpacked under
   `profiles/.corehub-import-<job>/` — a dot name, invisible to Hermes and to the profile listing.
2. The backup id is `default-backup`, then `default-backup-2`, `-3`, …: the first free both in the
   hub (any workspace, archived included) and in Hermes (a folder or a deletion tombstone). A taken
   name is never an error.
3. With the root gateway held down, the TUI gateway closed and Hermes's dashboard server stopped,
   every root entry that belongs to the default profile moves to the backup folder, and the
   archive's entries take their place. What Hermes shares across profiles stays at the root and is
   never replaced: `profiles/`, the task board (`kanban.db*`, `kanban/`), the shared OAuth store
   (`auth.json`), `shared/`, `honcho.json`, `logs/`, the root gateway's runtime files and the
   installation (`bin`, `node`, `node_modules`, `hermes-agent`, …). The list is of what stays, not
   of what moves, because Hermes's per-profile files are many and grow.
4. In one database transaction: a workspace row for the backup (its settings copied from the
   default's), the default's new name when one was given, and the archive's providers as the
   default's own. The default workspace keeps its id and `is_default`, so the shared providers and
   keys (§37), members, tokens and every hub row stay where they were — including the hub's
   transcripts, which stay readable in the default (continuing one starts a new Hermes
   conversation: its Hermes session moved to the backup).
5. Any failure in 3 or 4 rolls the transaction back and replays the journal backwards; the job fails
   with "The import did not happen and your default profile is as it was:" and the reason.
6. Then, best effort: the default's own providers are copied to the backup with their keys (a copy,
   §37), the backup's `.env` loses the hub's shared keys, the hub's tools leave the backup (their
   key belongs to the default) and return to the new root, the skill library is seeded, and the
   root gateway starts again on the hub's providers. The backup's channels and schedules moved with
   it and keep running from its own gateway until somebody moves them.

Admins only, as every import. Audited as `auth.profile_default_replaced` or
`auth.profile_default_replace_failed`. A second replacement while one runs is `409 conflict` before
any job exists.

Rejected: importing the archive into Hermes under a temporary name and moving it (Hermes's import
leaves a wrapper script for that name the hub cannot find to remove); an allow-list of what moves
(an unlisted file of the default would stay and mix with the imported one); moving the hub's own
per-profile rows to the backup (ten modules' tables and their attachment folders — a larger and
riskier change than this one).

## 117. Anyone with the public TestFlight link can test the iPhone app; each upload is submitted for Beta App Review by itself

Owner's decision (2026-09-27): send people one link instead of adding each tester by hand. The
details below are proposed — owner to confirm. Nothing in the contract changes.

Every build the *iOS signed build* workflow uploads to TestFlight (a manual run with
`upload_testflight`) also goes to an external TestFlight group, `Public` by default (input
`external_group`; empty skips it), whose public link is on, with at most 1000 testers (input
`public_link_limit`) and tester feedback on. The workflow creates the group the first time, prints
its link in the run's summary, sets the build's "What to Test" to the version and its release page,
submits the build for Beta App Review and adds it to the group
(`apps/ios/scripts/testflight-public.mjs`, docs/RELEASING.md → TestFlight). The internal `Owner`
group is unchanged and still gets every build first, without review.

Beta App Review needs details only the owner can give — the feedback email, the review contact and,
because the app is useless without a hub, sign-in with a demo account and the demo hub's address in
the review notes. The workflow never invents them: while any is missing the step fails and names
each field and where it is in App Store Connect; the upload and the internal group are done by then.
It fills only the two non-personal fields, the beta description and the privacy policy URL, from the
App Store listing in `apps/ios/fastlane/metadata`.

The link is public by design and appears in the public Actions log; the tester limit caps how many
can join, and the owner can turn the link off or change the limit in App Store Connect (the next run
sets the limit from its input again). Tag pushes still do not upload to TestFlight.

Rejected: submitting without sign-in details (Apple rejects an app reviewers cannot use); inventing
or storing the owner's contact details in the repository or in secrets; a new external group per
release (the link would change every time).

## 118. The direct agent runs on providers signed in through Hermes, borrowing the sign-in for one turn

Owner's decision (2026-09-27): «المفروض برق يستخدم اي موديل بـ API أو بدخول» — the `direct` agent
must run on any model the pickers offer, whether its provider holds a key or was signed in to
through Hermes (§55). The details below are proposed — owner to confirm. Nothing in the contract
changes: no operation, field or error code is added or removed.

- **The credential stays Hermes's, and a turn borrows it.** At the start of each `direct` turn on a
  signed-in provider (`openai-codex`, `nous`, `xai-oauth`, `minimax-oauth`) the hub runs Hermes's
  own Python — an argument array, never composed program text — with `HERMES_HOME` set to the home
  the provider was signed in to (the root for a shared provider or the default profile's own, else
  `profiles/<slug>`), as the live model list (§83) and the subscription's images (§84) already do.
  The program asks Hermes's own resolver (`hermes_cli.auth.resolve_*_runtime_credentials`, which
  refreshes a token about to expire) and prints one line: the wire, the base URL, the model id on
  the wire, the headers — the credential is the `Authorization` one — and the reasoning field. The
  hub keeps that in the turn's memory only: never in the database, a file, a log line or an error
  (any trace of the token in a provider's error text is replaced by `[redacted]`; the program's
  output is never passed on when it fails). A 401 that arrives before any text makes the hub ask
  Hermes once more with a forced refresh and send the request once more — never a third time.
- **Each provider on the wire Hermes uses for it** (Hermes v2026.9.14, read and described in our
  words): the ChatGPT subscription on the Codex backend's Responses API (`/responses`, streamed,
  `store: false`, the system prompt as `instructions`, Hermes's identity headers and the account id
  from the token, `reasoning: {effort, summary: auto}` clamped by Hermes's own vocabulary for the
  model, no `max_output_tokens`, Hermes's invented `-900k` names stripped); xAI on its Responses
  API, with an effort only for a Grok model that takes one; Nous Portal on OpenAI-compatible
  `chat/completions` (Anthropic Messages only when Hermes's `nous_api_mode` names it for that model);
  MiniMax on Anthropic Messages with `Authorization: Bearer`.
- **It behaves as a key provider does:** the same streaming, reasoning, cancel, usage and estimated
  cost from the model row's prices, and the same fallback chain (§54). The direct path has no tools
  (backlog §2.16), so there is nothing else to match.
- **Refused by name when it cannot work.** A hub that does not run Hermes, or has no Hermes Python,
  answers `agent_unavailable` saying the sign-in is borrowed from Hermes's Python and what to do
  instead (the Hermes agent, or a provider with a key); a fallback model may take the turn. A
  provider whose sign-in was never approved is `provider_not_configured` ("sign in under Models →
  Providers"), before Hermes is asked. Hermes holding no usable sign-in is `provider_unauthorized`
  with Hermes's words.
- The pickers already listed signed-in providers' models; only the turn refused them, so no client
  changes.

This amends §55's last clause ("a signed-in provider is used by Hermes alone: the `direct` agent
refuses it by name"); everything else in §55 stands — Hermes does the sign-in, keeps and refreshes
the credential, and the hub stores none of it.

Rejected: the hub keeping the token between turns (ADR 0010, §55); the hub refreshing it itself
(Hermes's per-provider refresh is not ours to copy); passing the stale token to Hermes as an
argument (visible in the process list); running the whole request inside Python (streaming, cancel
and usage would each need a second protocol, where §83/§84 already take the token only for the
moment of use).

## 119. The oldest Hermes the hub works with, said on its card; a person's own Hermes updated by its own updater

Proposed (2026-09-27) — the owner asked for it ("what if Hermes was already installed before?");
the floor and the wording are the owner's to confirm.

In the desktop app's local mode (and a hub run beside Hermes) the Hermes is the person's own and may
be of any age. `AgentInstall` gains three optional fields, absent from older hubs:
- `minimum_version` — for an agent the hub does not install, the oldest version it is known to work
  with. Hermes: `0.21.3`, release v2026.9.14 — the version the image pins (`HERMES_REF`) and every
  `*.real.test.ts` runs against, and the source the hub's Hermes calls were read from. An older
  Hermes is not proven (spot checks against v2026.8.13 found the commands and TUI methods the hub
  calls, so the floor is conservative, not a known break).
- `below_minimum` — the installed version (build metadata ignored) is older. Clients say so and
  block nothing: the agent still runs.
- `self_update` — `agents.upgrade` runs the agent's own updater on the person's install: for Hermes,
  `hermes update --yes` (no prompt; config migrations accepted) in the person's environment, never
  with the hub's `HERMES_HOME`; then the Hermes the hub runs is restarted and probed again. True only
  where Hermes's home is the person's and not the hub's (never in the image, whose Hermes comes with
  the image), for owners and admins as every upgrade. Never automatic: the web asks first, because it
  updates Hermes for everything else on the computer too.

`agents.upgrade` keeps its meaning for every other agent; one the hub did not install and that has no
`self_update` is refused as before. A newer Hermes than the pin is not flagged (the one Hermes's
installer puts on a computer today is past it and was tested for real,
`docs/changes/2026-09-27-twuijri-desktop-local-existing-hermes.md`).

## 120. The Android app goes to Google Play as its own build, with self-update off and the GitHub APK's key

Owner's decision (2026-09-27): publish the Android app on Google Play from a personal developer
account. The details below are proposed — owner to confirm. Nothing in the contract changes.

The Play build is the release AAB built with `-Pcorehub.selfUpdate=false`: no request to GitHub and
no `REQUEST_INSTALL_PACKAGES` (Play updates the app and forbids self-updating). It is signed with the
same keystore as the GitHub APK, and the recommended Play App Signing choice is to upload that key
as the app signing key, so an install from GitHub and one from Play carry one signature and a
GitHub user can move to Play as an update. Its versionCode is 100000 + the upload workflow's run
number, above every GitHub APK code. `.github/workflows/play-upload.yml` (by hand only) builds it
and sends it and/or the listing in `apps/android/fastlane/metadata/android` with fastlane supply;
a release is a draft unless the run asks otherwise, and nothing is promoted or rolled out by the
workflow. The listing, graphics and screenshots live in the repository and are checked against
Play's limits (`apps/android/scripts/play-listing.mjs`); the screenshots are the real app on the
demo hub. The Data safety answers declare what the app sends to the person's own hub, because
Play counts any data sent off the device as collected (docs/store/google/README.md).

Rejected: a Google-generated app signing key (two signatures: a phone could not move between the
GitHub APK and Play without losing its sign-in); keeping the self-updater in the Play build;
r0adkll/upload-google-play (uploads the bundle but not the listing and images); "No data
collected" on Play (the Firebase library alone sends a token and an installation id to Google).

## 121. The editor's live check takes a drawing that has no name yet (`WorkflowCheck`)

Found 2026-09-28: a new workflow opened in the web editor said "The drawing could not be checked:
The request did not match the expected shape" although its steps were drawn. The editor starts
with an empty name and sends it to `schedules.validateWorkflow`, whose body was `WorkflowWrite`,
where `name` has `minLength: 1`; the contract refused the body with `400 validation_failed`
before the check ran, although the check never reads the name. The iPhone and Android editors
sent the same empty name.

The body of `validateWorkflow` is now its own schema, `WorkflowCheck`: the fields of
`WorkflowWrite` with `name` a plain string (empty or absent is fine). This only accepts more,
so every existing caller keeps working (`pnpm contracts:compat` passes). `createWorkflow` and
`updateWorkflow` keep `WorkflowWrite` and still need a name (`400` for an empty one, `409
name_required` for a blank one). The clients leave the name out of the check altogether (the
phones) or may send it empty (the web), so a new app checks an unnamed drawing on an older hub
too.

The web editor also no longer checks the empty drawing it starts from while a saved workflow is
loading, says "name required" by the name field instead of as an error, and puts the fields a
refused request names (`details.fields`: `name`, `nodes.<i>.<field>`, `edges.<i>`) next to that
field or step; what no field shows stays in the general message.

Rejected: dropping `minLength` from `WorkflowWrite` (saving would accept an empty name at the
contract and only the hub would refuse it, with a different status); leaving the contract and
fixing only the clients (every released phone app would keep failing on a new hub).

## 122. An MCP server is signed in by OAuth from the hub's pages, through Hermes, with the hub as the browser's way back

Owner's goal (2026-09-27): connect ClickUp's MCP server — or any MCP server that signs in by OAuth —
from the web alone, then Test shows its tools. The details below are proposed — owner to confirm.

**Hermes does the sign-in; the hub only relays it.** Hermes's own dashboard already runs the whole
flow (MIT source `hermes_cli/web_routers/mcp.py`, `tools/mcp_dashboard_oauth.py`, v2026.9.14): it
discovers the provider, registers a client, answers the provider's authorization URL, accepts the
browser's return only with the flow's `state`, exchanges the code and keeps the tokens in the
profile's own `mcp-tokens/`. `agents.startMcpOAuth` starts it for the profile in `X-Hub-Profile`
and answers the hub's own flow id (a ULID; Hermes's id never leaves the hub),
`agents.getMcpOAuthFlow` polls it (`pending` → `approved` with the tools Hermes then listed,
`failed`, `cancelled`, `expired`), `agents.cancelMcpOAuthFlow` stops it. **No token passes through
the hub** and none is returned or logged.

**The redirect URI is the hub's callback**, because Hermes would otherwise name its own address
(`127.0.0.1:<port>` inside the container), which the person's browser cannot reach. Hermes has no
per-flow parameter for it but reads the server's `oauth.redirect_uri` first, so before starting the
hub writes there `<base>/api/v1/mcp-oauth/callback/<server>`, where `<base>` is the `hub_url` the
client sends — the address the person reaches the hub on, so a tunnel's or a proxy's address is the
right one — or else the request's own `protocol://host` (which honours `X-Forwarded-*` from the
proxies `COREHUB_TRUST_PROXY` trusts). An `oauth.redirect_uri` that is not a hub callback (a person's
own proxy) is left alone and used. Each dashboard sign-in makes Hermes register a fresh client, so
moving the hub to another address only needs a new sign-in. `agents.mcpOAuthCallback` is public
(`security: []`): it hands the query to Hermes's callback unchanged and answers a short page in the
browser's language; the outcome is read by polling. Its request is not logged (`logLevel: warn` on
that route: Fastify's request lines carry the URL, and the URL carries the authorization code).

**The status is read from metadata only.** `McpServer.oauth` (optional, on `http`/`sse` servers)
says `connected` (an access token that has not run out, or one Hermes can renew with a refresh
token), `expired`, `not_connected` (no file) or `error` (a file that is not a sign-in), from the
existence of `mcp-tokens/<name>.json`, its `expires_at` (or its time plus `expires_in`) and whether a
refresh token is there — never a value. `required` is the block's `auth: oauth`.
`agents.disconnectMcpOAuth` deletes that server's four files in the profile (Hermes has no API for
it); a Hermes already holding the connection keeps it until its gateway restarts. Each profile signs
in on its own: `mcp-tokens` is not shared between profiles.

**Masking, one level down.** A secret one level into the block — a `headers` value such as
`Authorization`, an `oauth.client_secret` — now reads `[stored]` like an `env` value (only `env` was
masked before, and a header came back as written), and saving `[stored]` keeps the stored value.
`auth: oauth` reads as it is: it names how the server signs in, not a credential.

Rejected: the hub doing the OAuth exchange itself (a second implementation of what Hermes does, and
the tokens would pass through the hub); Hermes's own `dashboard.public_url` (it changes the whole
dashboard's address and would send the browser to a path under `/api` the hub does not serve);
asking the person to type the redirect URI; returning the token's expiry from `expires_in` without
the file time (wrong after a restart); a `hub_url` taken without checking (anything but `http(s)`
without credentials is `400`).

**Amended (2026-09-28, the ClickUp report).** The owner's tester signed in to ClickUp on the test
image: the callback page said "Sign-in received", but the server stayed not connected and Test got
`401`. Reproduced against the real Hermes of the image (v2026.9.14) with a real OAuth 2.1 + MCP
server: ClickUp advertises `authorization_response_iss_parameter_supported` and sends `iss` on the
redirect (RFC 9207). Hermes v2026.9.14's **dashboard** callback route takes only `code`, `state`
and `error`, so the MCP SDK refused the sign-in ("Authorization response missing iss parameter
advertised by the authorization server") after the hub's page had already said it was received.
Hermes v2026.9.21 carries `iss`, but against it several of the hub's other real-Hermes tests failed
that pass on v2026.9.14 (the shared provider's key in named profiles, gateways side by side, a TUI
command — docs/changes/2026-09-28-twuijri-mcp-oauth-real-hermes.md); moving the image is its own
task. So — proposed, owner to confirm:
- **The sign-in is Hermes's own `hermes mcp login <server>`**, the CLI's browser flow, whose
  callback listener keeps `iss` in every version the hub supports. The hub writes `auth: oauth`,
  `oauth.redirect_uri` (its callback, as before) and `oauth.redirect_port` (a free port on its
  host), runs the command in the profile's home with `SSH_CLIENT` set (so Hermes opens no browser
  on the hub's machine), gives the person the page Hermes prints, and hands the provider's query,
  unchanged, to `127.0.0.1:<port>/callback`. Hermes exchanges the code, keeps the tokens in the
  profile's home and says "Authenticated — N tool(s)". The image stays on v2026.9.14.
- **The callback page says connected only when Hermes says so**: it waits (45 s at most) for that
  sign-in to end, and answers connected with the tool count, the failure in Hermes's words,
  declined, or "still finishing" — never success on the code's arrival alone. `approved` also
  needs the token file in the profile's home, not Hermes's word alone.
- A new sign-in for the same server ends the one before; a hub that closes ends its sign-ins.
- The web follows the sign-in while the person is on the provider's tab, runs Test by itself once
  signed in, and offers Reconnect beside Disconnect when connected.
- **"Add server" → Sign in (OAuth)**: an address and a name read from the host
  (`mcp.clickup.com` → `clickup`, the next free name when taken); the web writes the smallest
  block a server that signs in needs — `url` and `auth: oauth`, no `connect_timeout` or
  `skip_preflight` (Hermes's login waits 315 s itself and its preflight is skipped for OAuth) —
  and the sign-in starts at once. Only `https`, or `http` on this computer.
- CI: "MCP OAuth against the real Hermes" installs the image's pinned tag the way the image does
  and runs the whole sign-in against a local OAuth 2.1 + MCP server that sends `iss`.

Rejected: moving the image to Hermes v2026.9.21 in this fix (see above); patching Hermes's
dashboard route in the image (a change to third-party code the hub does not own); dropping `iss`
checks (older MCP SDK) — the check is the provider's protection against mix-up.

## 123. Inbound webhook triggers start a workflow; a condition can hold several rules

Owner's goal (2026-09-28): outside systems — ClickUp first — send events into a Core Hub
workflow, the workflow filters them, and only the ones that matter reach an agent step. Generic
for every hub. The details below are proposed — owner to confirm.

**Triggers.** A workflow has any number of inbound triggers (`listWorkflowTriggers`,
`createWorkflowTrigger`, `updateWorkflowTrigger`, `deleteWorkflowTrigger`), each a stable
public address on the hub, `POST /api/v1/workflow-hooks/{workflow_trigger_id}`
(`receiveWorkflowTrigger`, `security: []`, `x-scope: global`). A trigger has a preset that says
how a delivery proves its sender: `clickup` (`X-Signature` = hex HMAC-SHA256 of the raw body),
`github` (`X-Hub-Signature-256`), `generic_hmac` (a chosen header, hex or base64, an optional
prefix) and `token` (the secret itself in a chosen header). The body is read raw, at most 1 MiB,
the signature is checked over those bytes with a constant-time comparison (both sides hashed
first), and only then is the JSON read. The secret may be stored later than the trigger is made
(ClickUp makes it when the webhook is registered with the address); it is sealed with the hub's
data key ring, never returned (`secret_stored`, the web shows `[stored]`), replaceable. Until one
is stored every delivery is refused.

**Receiving**, in order: signature (`401`, logged `signature_rejected` without the body), repeat
(a stable key per preset — ClickUp: `webhook_id` and the sorted `history_items[].id`; else a
delivery-id header; else the SHA-256 of the body — remembered 7 days; a repeat is `200
duplicate`), the trigger's event allow-list (`200 filtered`, logged `filtered_out`), then the
run is queued and the answer is `202` at once; the steps go on after it. The run acts as the
trigger's owner in the trigger's profile; its `{{trigger.*}}` holds `body`, `event`, `event_id`,
`task_id`, a short allow-list of headers (`-` written `_`, never a signature, token or secret),
`delivery_id` and `test`. Runs carry the trigger, the delivery, `event_id` and `task_id`
(additive optional fields of `WorkflowRun`, new columns of `workflow_runs`), and
`listWorkflowRuns` takes `event_id` and `task_id`.

**The delivery log** (`listWorkflowTriggerDeliveries`): one line per delivery, `received`,
`duplicate`, `signature_rejected`, `filtered_out`, `run_started`, then `run_succeeded` or
`run_failed` when the run ends (settled by the engine's end-of-run hook, and again when read,
for a run a restart ended); 7 days and at most 500 lines per trigger; a 1000-character body
preview with secret-looking fields masked. **Send test event** (`testWorkflowTrigger`) builds a
sample for the preset (ClickUp: a task event about a made-up task), signs it with the stored
secret and runs the whole receiving path; nothing leaves the hub. `409 secret_missing` without
a secret.

**Several rules.** `WorkflowNode.rules` (optional, nullable): `{ match: all | any, items: [{ path,
operator, value }] }` with the single-line condition's operators. With at least one rule the
step answers from them and `input` is not read; old workflows are unchanged. `operator` is a
plain string in the contract (so every generated client can carry `==`), checked when the
workflow is saved (`rule_operator_invalid`, `rule_path_invalid`, `rule_value_missing`,
`rule_regex_invalid`). An app that does not know the field sends a condition node without it;
`updateWorkflow` then keeps the rules the saved node had (`null` removes them), so an older
phone cannot erase them. A run whose condition said no with nothing to follow ends `succeeded`
with `WorkflowRun.filtered = true` — not failed, no alert — and its delivery line says
`filtered`.

**Clients.** The web editor's side panel has a Triggers section (sender, address with copy,
secret, events, signature settings, test event, delivery log with a link to each run) and the
condition form a rules editor; the runs view finds runs by task or event id and marks filtered
ones. The phones list a workflow's triggers read-only with the address to copy, show a
condition's rules read-only and keep them on save; editing rules and triggers on the phones is a
follow-up. The ClickUp registration is described in `docs/guides/clickup-webhook-trigger.md`.

Not used: `workflows.trigger_kind = 'event'` and `event_key` stay as they were (they name the
hub's own realtime events, not an outside sender; a workflow may have several triggers).
Rejected: re-serialising the parsed body to check its signature (other bytes than the sender
signed); putting the secret in the address (it would be in every proxy log); new values in
`RunTrigger.kind` (an older app would meet an enum value it does not know — the run says
`api` and carries the new optional fields).

## 124. A "Send message" step: Telegram through the profile's bot and a Core Hub conversation

Owner's decision (2026-09-28): a workflow step sends a message to Telegram and/or a Core Hub
conversation (the person picks either or both), Telegram directly through the Bot API with the
profile's `TELEGRAM_BOT_TOKEN` from its Hermes `.env`. The details below are proposed — owner to
confirm.

**Shape.** The step is a `notify` node with a new optional field, `send: { targets: [...] }`,
not a new `kind`: the generated Kotlin and Swift clients decode `WorkflowNode.kind` as a closed
enum with no fallback, so a new value would make an older phone fail to load every workflow
list that holds one. An older app sees a notice with the same words, and `updateWorkflow` keeps
the saved node's `send` when such an app saves the node without the field (`null` removes it),
as it does for §123's `rules`. A target's `platform` is a plain string (`telegram`,
`core_hub`), so WhatsApp can be added later without an older app meeting an enum value it
cannot read; an unknown platform is refused when the workflow is saved
(`send_platform_unknown`), as are a Telegram target without a chat id and a conversation
target that names none (`send_chat_missing`, `send_conversation_missing`, `send_no_target`).

**Telegram.** `sendMessage` with the chat id (a group is `-100…`), the step's words rendered
like any template. A text over 4096 UTF-16 units is split on paragraph, then line, then word
boundaries (a single run longer than that is cut where it must, never inside a surrogate
pair), sent in order. The token never reaches a log or a reason. A refusal is Telegram's own
`description`; a profile without a bot is said as such.

**Core Hub conversation.** The words are posted in the chosen conversation as its agent's
message, announced live (`message.created`), so they show in every app. If the conversation was
deleted, a new one with the same title and agent is made, the words go there, the node is
pointed at it (the drawing's version is not bumped), and the run owner's inbox says so.

**Never twice, never a false success.** Each part sent is written down (`workflow_sent_parts`,
migration 0034) by the run it belongs to — a rerun from a step counts as the run it repeats —
the node, the target and the part; a step tried again sends only what did not go. The step's
output is `WorkflowSendResult`: `status` `sent` (every target took it), `partial` or `failed`,
`message_ids`, `message_id`, `delivered_to` and each failure's reason; `sent` is never said
without the platform's id. Every target failing fails the step; any failure (and a remade
conversation) is also said in the run owner's inbox.

**Test.** `schedules.testWorkflowSend` (`POST /workflows/send-test`) sends the given words to
the given targets now; nothing is remembered, so pressing it twice sends twice. The web
editor's palette has "Send message", whose form picks Telegram (chat id) and/or a conversation
and has "Send test message". The phones show a send step's targets and keep them on save;
editing them there is a follow-up. A test hub may point the Bot API elsewhere with the
optional `COREHUB_TELEGRAM_API_BASE` (default `https://api.telegram.org`).

Rejected: a new node kind (older phones would stop loading workflows); sending through Hermes's
gateway (it would need Hermes up and a channel's own delivery rules, and the owner chose the Bot
API); remembering by run id only (a rerun is a new run and would send again).

## 125. Settings → Secrets: the owner sees the names of every secret and one value at a time, with the password asked again each time

Owner's request (2026-09-28): a Secrets section in Settings, on web and desktop only, visible to the
owner alone, that asks for the account password every time it is opened, and shows the secrets the
hub holds — masked, one revealed at a time, hidden again after about 30 seconds, copyable, each
reveal in the audit log.

**This amends the ARCHITECTURE invariant** "secrets … never returned to a client": they are still
never returned by any other operation, and `[stored]` stays their shape everywhere else; the one
exception is `secrets.reveal`, for the owner, behind a step-up.

**Step-up (`auth.stepUp`, `POST /auth/step-up`; `auth.endStepUp`, `DELETE`).** Body `{ password,
purpose: secrets }` (`StepUpRequest`; `StepUpPurpose` is an enum so a later purpose is a contract
change). Owner only (`x-roles: [owner]`), and only from a web sign-in session — an app token (a
paired phone, an integration) is `403 web_session_required`, so a leaked integration token never
opens a secret. A right password answers `StepUpGrant { grant, purpose, expires_at, ttl_seconds:
300 }`: an opaque `su_…` string kept **in the hub's memory only**, by its SHA-256, bound to the
person, the sign-in session (`app_tokens` row behind the JWT) and the purpose; a new step-up ends the
session's earlier grant; `DELETE` ends it at once (the web calls it when the page is left); the clock
and a restart end it too. A wrong password is `401` with `details.reason: wrong_password`, counts on
the same per-address password lockout as sign-in (five in 15 minutes lock it for 15: `429` with
`Retry-After`, sign-in included), and both outcomes are audit rows (`auth.step_up`,
`auth.step_up_failed`) with the purpose and never the password. Answers are `Cache-Control:
no-store`.

**The list and the value (`secrets.list`, `secrets.reveal`, tag `secrets`).** Both `POST` with the
grant in the body (no grant in a URL, nothing a cache keeps), owner only, web session only; no live
grant of this session is `403` with `details.reason: step_up_required`, and the page asks for the
password again. `SecretList.items` are `SecretEntry { id, kind, profile, label, name }` — never a
value, never a hint of one — of the kinds `SecretKind`: `provider_key` (a key in the hub's encrypted
store, listed once for its credential family with the providers that use it; `profile` null for a
shared key), `channel` (a platform's secret variable in a Hermes profile's `.env`, the ones
`channel-platforms.ts` declares secret), `mcp` (a credential in an MCP server's block, the ones the
MCP pages show as `[stored]`: `env.X`, `headers.X`, `oauth.client_secret`, a top-level key),
`webhook_out` (an outgoing webhook's signing secret; hub-wide) and `webhook_in` (a Hermes incoming
webhook route's own secret). The id is a digest of where the secret sits, so `secrets.reveal`
finds it by listing again and nothing a client sends is ever a path; an id that no longer matches is
`404`. `SecretValue { id, value }` answers one value; every list (`secrets.listed`, with the count)
and every reveal (`secrets.revealed`: who, kind, profile, label, name, when) is an audit row without
the value. No value is written to a log line or an error. The routes live in `models` (the owner of
"keys (secrets)"), which reads the other stores through their modules' public surfaces
(`hermesSecretsFor` in `agents`, `webhookSecretsFor` in `notify`); the grant check is `auth`'s
(`stepUpFor(io)`).

**Clients.** Web and desktop: Settings → Secrets (`secrets`, a settings tab after Privacy, `roles:
[owner]`, `surfaces: [web, desktop]`; the router sends anyone else home). Locked on every visit; the
password leaves the page the moment the hub has it; the grant lives in the page's state only (no
query cache, no storage) and a reload forgets it; the list is grouped by kind, then profile (the
hub-wide ones first), values masked; showing one hides any other, and it hides itself after 30
seconds; Copy fetches a hidden value (audited) and copies it without showing it; the grant running
out (a countdown shows it) or refused locks the page again; a hub older than the page (`404`) is
said in words. The phones do not call these operations; their generated clients simply gain them.

Proposed — owner to confirm: five minutes for a grant; 30 seconds before a value hides; the kinds
listed (push-sender credentials, stored encrypted by `devices`, are not listed yet); a value copied
while hidden is audited as a reveal. Rejected: a "recently signed in" window instead of the password
each time (the owner asked for every time); a grant stored in the database or a JWT claim (it would
outlive the page and a restart); single-use grants (every reveal would ask for the password again);
putting the grant in a header or query (a URL is logged, a header is easy to forward); showing the
last four characters (a part of a secret without an audit row).

## 126. The web and desktop sidebar: Search beside the fold toggle, and «Tools» around Agents, Tasks, Workflows and Schedules

Owner's design, approved 2026-09-28 (web and desktop; the phones follow in their own change once he
has seen it): the search icon sits next to the fold toggle at the top, and comes back as the row
right below New chat when the sidebar is folded into its rail of icons. One expandable entry,
«الأدوات» / "Tools", holds — in this order — Agents (owners and admins only, as before), Tasks,
Workflows and Schedules. A press on it closes it so the chats list gets the room and opens it again;
the choice is the device's (local storage, read inside try/catch, open by default), and while it is
closed on one of its pages the heading is marked as the current place. Workflows leaves the
Schedules page, where it was a tab, for a page and an entry of its own (`/workflows`), and the tab's
old address (`/schedules?section=workflows…`) still lands there with the rest of it kept.

**The navigation contract grows, and nothing a phone reads changes.** `docs/clients/navigation.json`
gains the term `workflows` and `tools`; the destination `workflows` (`surfaces: web, desktop`,
member, entry kind `rail`) listed in a new `railExtra` rather than in `rail`, because the Android
parity test compares `rail` exactly and the phones do not have the page yet; `brandRow` (the rail
entries web and desktop draw beside the fold toggle: `search`) and `sidebarGroups` (`tools` with its
items) — presentation over the rail, not destinations. `rail` itself is unchanged. `nav:check`
counts `railExtra` as a primary list and checks that every `brandRow` and group item is a rail entry,
in one place only, on the group's surfaces, with a known title term. `profileScope.alwaysAll` gains
`workflows` (the page lists every profile, as the tab did). The API contract does not change.

Rejected: putting `workflows` in `rail` (every phone parity test would fail until the phones draw
it); a Tools destination with its own page (it would be a hub page listing four links, the
"settings inside settings" NAVIGATION rules out); remembering the group per account (it is about the
room on this screen, like the fold); keeping Workflows as a tab too (two entries to one place).

## 127. A run's phase, a workflow's failure alert, and one step tried with a sample

Owner's goal (2026-09-28): the pieces of §123 and §124 put together into a flow a person can
follow and trust — ClickUp → filter → agent → message. The details below are proposed — owner
to confirm.

**Phase.** `WorkflowRun.phase` (optional, a plain string so a later value never breaks an older
app) says where a run is, worked out from its status and steps when it is read — nothing is
stored: `received` (no step yet), `analyzing` (an agent step works before any approval),
`needs_input` (waiting for a person), `approved` (an approval said yes and nothing has started
since), `executing` (after an approval, or a step that is not an agent's), `completed`,
`failed`. The web shows it on the run, the phones beside the run's status (with the task a
trigger's run is about).

**Failure alert.** `Workflow.on_failure` / `WorkflowWrite.on_failure` (optional,
`WorkflowFailureAlert`): the run owner's inbox and/or a "Send message" step's targets
(Telegram, a conversation), told the workflow's name and the run's error when a run ends
`failed` (a step nothing handled, a limit that ran out). Stored in the definition like
`limits`; left out of a save it stays, `null` removes it; its targets are checked like a send
step's. Sent once per run (the §124 memory, under the node key `__on_failure`). Absent, nothing
changes: a failed run tells nobody beyond its own record, as before.

**Test this step.** `schedules.testWorkflowStep` (`POST /workflows/test-step`) tries one node on
its own with a sample `input`, `trigger` and earlier `steps`: a condition answers yes or no
(rules or the single line), a template is rendered, a delay is read, an agent step runs a real
turn only with `execute: true`, and a "Send message" step is only rendered (its own test is what
sends). Nothing is saved and no run is made. The web has it in every step's panel with a
ClickUp-shaped sample event filled in.

**Guide.** `docs/guides/clickup-agent-flow.md` (English): the agent's ClickUp MCP server with an
include list of read-only tools, the flow drawn step by step, the webhook registered, and what to
watch.

Rejected: a stored `phase` column (it would be a second record of what the steps already say);
alerting on every failed run by default (an older workflow would start sending notices nobody
asked for).

## 128. The phones take the web's «Tools» drawer and edit workflows as the web does

Owner's approval (2026-09-28): what §123, §124, §126 and §127 gave the web and desktop comes to the
iPhone and Android apps. The details below are proposed — owner to confirm.

**Navigation.** The phones' drawer is drawn from the same manifest keys as the web's sidebar:
`sidebarGroups.tools` (Agents for owners and admins, Tasks, Workflows, Schedules under one heading
«الأدوات» / "Tools", open by default, the choice kept in the app's own settings on this device, the
heading marked as the current place while it is closed on one of its pages) and `brandRow` (Search).
The drawer has no fold, so the phone equivalent of the web's brand row is the drawer's header: the
Search icon sits beside the close button, always, and the Search row leaves the rail. `workflows` gains
the `ios` and `android` surfaces and the route `/workflows` on both; it stays in `railExtra`, so an
app built before it still matches `rail` exactly (`rail` is unchanged). Schedules on the phones loses
its Jobs | Workflows switch; every way a phone reached a workflow run through Schedules (pending
approvals, the Background sheet, notices, `corehub://open/schedules?section=workflows…`) now opens
Workflows.

**Workflow editing.** The phones stop saying "edited on the web": a saved workflow's editor has the
Triggers section (add with a sender preset, the address to copy, the secret set or replaced — never
shown back, the header/prefix/encoding of a signed or token webhook, the events it takes, Send test
event, the delivery log with a way to each run, delete), a condition's several rules (all / any,
path with suggestions, the operator words, value; switching them off sends an explicit `null`), the
palette's "Send message" with Telegram and Core Hub conversation targets and Send test message, the
workflow's failure alert (written only when changed in the editor, `null` when emptied, left out
otherwise), "Test this step" on every step, and a run's phase, filtered mark, task and event ids with
"Find a run" by task or event id. The words are the web's.

**Nothing breaks.** No contract change. An older hub answers 404 to the trigger, send-test and
step-test endpoints: the phone hides the Triggers section and shows a plain error for a test, and
saving a workflow still works (the new node and workflow fields are optional and kept by the hub when
left out). A target of a platform the phone does not know is kept as it is.

Rejected: a canvas on the phone (a list of steps is what a phone screen holds; the drawing's
positions are kept); a Tools destination with its own page (as in §126); keeping the Search row in
the phone rail too (two entries to one place).

## 129. A Hermes with one gateway per host serves every profile from the hub's one gateway

Proposed (2026-09-28) — a real user's desktop app (local mode, his own newer Hermes) showed «hermes
gateway exited (code 75): One gateway per host serves every profile; manage it with `hermes -p
default gateway restart`». Owner to confirm. No contract change.

Hermes v2026.9.21 (`0.21.4`) made one `hermes gateway run` per host (per OS user) the only
topology: the first gateway serves every profile, and a second one attaches to it and exits 75
(`gateway/host_attach.py`; §119's floor, v2026.9.14 = `0.21.3`, is the last release without it).
Its host lock lives in `$XDG_STATE_HOME/hermes/gateway-locks`, not in the home, and a served
profile's keys are now scoped per turn (no longer process-wide `os.environ`, the reason the hub
started a gateway per profile).

- **Topology by version, 75 as the fallback.** The hub reads `hermes --version` when it starts
  Hermes and after Restart. From `0.21.4` it starts no gateway per named profile; the default
  gateway serves them. Below, or unknown, nothing changes — except that a gateway exiting 75 with
  Hermes's one-gateway-per-host words switches the topology (a plain 75 is still a restart).
- **The card.** A named profile with a channel or a job keeps its row, following the default
  gateway: its pid, and `running` once Hermes lists the profile in `served_profiles`; its
  platforms are Hermes's `<profile>:<platform>` entries. A profile Hermes still does not serve
  after the gateway was restarted for it says so (`error`).
- **Changes.** A channel or setting change in a named profile asks the running gateway to
  `rescan-profiles` on its control socket (Hermes also does it every 30 s); a gateway that came
  up serving only the default profile (one profile at start) is restarted once so it decides
  again — again only when somebody changes something.
- **Beside a person's own Hermes.** The hub's home is a Hermes root of its own, so on a
  one-gateway-per-host Hermes the gateway and every Hermes command of the hub get
  `HERMES_GATEWAY_LOCK_DIR=<home>/gateway-locks` when the person's `~/.hermes` is not the hub's
  home. Their gateway and the hub's then each own their home. There the version is read before the
  gateway's first start, so it never holds the person's host lock even for a moment. Never on an
  older Hermes and never in the image.

Rejected: `gateway.standalone: true` per profile (Hermes calls it a temporary shim to be
removed); `--force` (Hermes's escape from its own safety check); attaching to the person's gateway
(it serves their home, not the hub's).

## 130. Any registered UI language in `Accept-Language`; `Locale` stays Arabic and English
Proposed 2026-09-28 (ADR 0028) — owner to confirm. **No change to the OpenAPI document.**

The hub matches `Accept-Language` against the language registry (`locales/languages.json`): the
best registered language by quality, then order (`zh-TW` finds `zh-Hant`, `pt-PT` finds `pt-BR`),
and answers its `{ error, code }` envelopes in it, falling back along that language's chain to
English for a message its catalogue lacks. It already accepted any header value; the documented
`AcceptLanguage` enum stays `[ar, en]`, because widening a closed enum changes the phones'
generated Kotlin and Swift types, which ADR 0027 forbids. A client may send a registered code
beyond it; an older hub answers such a request in English, as it always did for an unknown tag.

`Locale` (a person's stored `locale`, push registrations, `meta.locales`) stays `ar | en`. A web
client in another language stores the nearest of the two — the first of Arabic and English on its
fallback chain, English for most — for the hub's own notices, and keeps the chosen language in the
browser as it keeps the display language. A per-person UI language on the hub is a later additive
field. `@corehub/contracts`' TypeScript client takes `language?: string` (it was `'ar' | 'en'`); the
wire is unchanged.

Rejected: widening `Locale` or the header enum now (breaks the generated clients the phones ship
with); a free-text `locale` (every client would have to cope with any string at once).

## 131. The owner on the desktop's own computer: «نسيت كلمة المرور؟» after the OS confirms, and sign-in without a password
Design approved by the owner 2026-09-28; the defaults below are proposed — owner to confirm.
**No change to the OpenAPI document or to any realtime event.**

In local mode (ADR 0009) the desktop app's sign-in screen offers "Forgot password?" /
«نسيت كلمة المرور؟». Pressing it shows the operating system's own confirmation — Touch ID or a Mac
administrator's password (`systemPreferences.promptTouchID`, then Authorization Services through
`osascript … with administrator privileges` running `/usr/bin/true`), Windows Hello
(`UserConsentVerifier` through Windows PowerShell's WinRT projection), polkit on Linux
(`pkexec /usr/bin/true`). No native module is shipped. After it, the page shows the owner's
username in monospace and asks for a new password twice (8–1024 characters, as setup); saving
sets it and ends the owner's sign-ins on other devices only — web sessions, paired phones and
computers (their device tokens; the device rows are marked revoked), the owner's push
registrations and live connections — signs the app in with a fresh session and writes
`auth.password_recovery_started` and `auth.password_recovered` audit rows (method, counts of
sessions and devices; never the password or the grant). **Owner's decision (2026-09-28):** the
owner's personal tokens (`hub_at_…`, scripts and integrations) are **not** revoked, and nothing
else is touched — provider keys, MCP connections, channels and Hermes's state are not auth's and
never were affected. The screen says only that phones and other computers must sign in again.

**Local only, never HTTP.** The hub has no route for any of this. `LocalOwnerAccess`
(`packages/server/src/modules/auth/local-owner.ts`, `localOwnerAccessFor(io)`) is reached only from
`apps/desktop/src/hub/entry.ts` over the IPC channel of the child process the app forked
(`owner` requests / `owner-answer` in `apps/desktop/src/shared/hub-ipc.ts`). The LAN, a tunnel
(§95) or another account on the computer cannot open that channel; a hub in a container has none.
`begin` (sent only after the OS said yes) answers the username and a random 256-bit grant kept by
its SHA-256, single use, five minutes, one alive at a time, at most five in fifteen minutes; the
app keeps the grant, the page never sees it; the app asks the OS at most five times in fifteen
minutes. A computer with no reachable prompt (Windows without Hello, Linux without `pkexec` or a
graphical session) does not show the button.

**Sign-in without a password on this computer.** The same channel's `sign-in` gives the owner a
session when the app's setting `localSignIn` (`desktop.json`) is on; the web client asks for it at
start when it holds no session, and the sign-in screen offers «ادخل على هذا الحاسوب» / "Sign in on
this computer". Phones, browsers and other computers still need the password. Default: **on for a
new install** (no `desktop.json` yet), **off for an install from before it** (a file without the
field, or one that cannot be read) — nothing changes for anyone who already has the app until the
owner turns it on in Settings → This device. Turning it on takes the owner's own live sign-in
(the hub checks the access token, `is-owner`); turning it off takes nothing.

Rejected: an HTTP route guarded by loopback (a tunnel's connector reaches the hub from loopback);
a per-launch secret over HTTP (the IPC channel already exists and is not a socket); CredUI with a
`LogonUser` check on Windows (P/Invoke through PowerShell we could not verify on a real machine —
Hello covers Windows 10/11 with a PIN); a password-free default for existing installs (changes what
people who already run the app have). Hubs in Docker are out of scope: recovery codes or a command
inside the container are for the owner to choose later.

## 132. The image carries the latest Hermes (v2026.9.24, `0.21.5`); every real-Hermes test runs on it and on the floor; a person's own Hermes hears of newer releases

Proposed (2026-09-28) — the owner asked to move Core Hub to the latest Hermes Agent for 1.1.5 and
never fall behind again. Owner to confirm. Additive contract change only (`AgentInstall.tested_version`).

**The two Hermes releases the hub is proven against** live in one file,
`packages/server/src/modules/agents/catalog/hermes-versions.ts`: `HERMES_FLOOR` (v2026.9.14,
`0.21.3` — §119, unchanged) and `HERMES_TESTED` (v2026.9.24, `0.21.5`), which the image's
`HERMES_REF` equals (`scripts/hermes-watch.mjs current`, checked by `pnpm scripts:test`). CI's
`hermes-real` job builds the image at each of the two and runs **every** `*.real.test.ts` against it
(a matrix, required through the gate); before this only the MCP OAuth suite ran in CI, against one
Hermes.

**What v2026.9.21–v2026.9.24 broke, and how the hub copes on both versions** (read in Hermes's MIT
source at v2026.9.24, in our words):
- **A named profile's turn reads its keys only from that profile's `.env`.** Its secret scope
  (`agent/secret_scope.py`) no longer falls back on the process environment, which is where the
  shared providers' keys reached a named profile (their names were left out of its `.env` when
  equal to the root's). The hub now writes every key a profile uses into its own `.env` — its own,
  and the shared ones it has no own of — and an empty value where it must not use the root's.
  The same on every Hermes version; a changed key reaches every profile's file on the save.
- **One gateway per host answers a named profile's webhook routes from the root's file.** Hermes's
  shape: routes live in the default home's `webhook_subscriptions.json`, one of a named profile
  carries `profile: <name>`, and the default listener answers it at `/p/<name>/webhooks/<route>`;
  a named profile has no listener of its own. On such a Hermes (§129) the hub keeps each profile's
  own file as its record (a volume from an older Hermes keeps its routes), copies every named
  profile's routes into the root's file — marked as its copies, under `<profile>--<route>` or a
  hashed name when that is taken — switches the root's listener on (the default profile's Channels
  page then shows the webhook listener on), and passes a delivery for a named profile to the root's
  listener under that prefix. The public door (`agents.receiveWebhook`) does not change.
- Hermes's reason for a refusal skips its own `[hermes] WARNING: …` process lines (the PID 1
  warning goes to stderr while the refusal goes to stdout).
- Not the hub's to fix, said here: on one gateway per host, a named profile **with an allowlist**
  no longer pairs strangers (Hermes decides a DM's `unauthorized_dm_behavior` from the default
  profile's settings, `gateway/authz_mixin.py`); they are ignored. Without an allowlist pairing
  works. And Hermes's gateway now asks for boto3 (its Bedrock provider) when it starts, installing
  it into `/data/hermes-packages` when there is a network.

**A person's own Hermes** (desktop local mode, a hub beside Hermes; §119): the hub looks up Hermes's
newest stable GitHub release (NousResearch/hermes-agent; the version is read from the release's
title, the tag is a date) on the six-hourly check and on `agents.checkUpdate` — only for a Hermes its
own updater updates (`self_update`), never the image's, never installed on its own (`auto_update`
stays off). `latest_version` / `update_available` then say it, and the Update button runs Hermes's
own updater after the person confirms. `AgentInstall.tested_version` (new, optional) names
`HERMES_TESTED`; `newer_than_tested` is also true for such a Hermes past it. The Hermes card says a
newer Hermes may not be supported yet, and whether an available update is one Core Hub was tested
with. GitHub unreachable: what was known stays.

**Never behind again — the Hermes watch** (built beside this, docs/changes/2026-09-28-twuijri-hermes-watch.md):
a daily workflow tries any newer Hermes release against every real-Hermes suite and opens a pull
request moving `HERMES_TESTED` (green) or one issue listing the failures (red); never merged
automatically. Every image release says which Hermes it carries and whether a newer one exists.

Rejected: raising the floor (0.21.3 still passes every real suite); `gateway.standalone: true` per
profile to keep webhooks per profile (a shim Hermes will remove, §129); writing the default
profile's settings to restore pairing in named profiles (it would change the default profile's
own channel behaviour).

## 133. "Send test message" fills the step's variables first, and never sends a `{{…}}`

Proposed (2026-09-29) — a tester's report: the test of a "Send message" step (§124) sent its words
as written, so Telegram received `{{steps.analysis.output}}`; the run itself filled them. Owner to
confirm. Additive contract change only.

**A test says what the run will say.** `WorkflowSendTest` gains two optional fields: `values` (a
value per variable, keyed by its path as the template writes it — `steps.analysis.output`,
`trigger.body.task.name`, `input`) and `workflow_run_id` (a run of the workflow whose event, input
and finished steps fill them; `values` win over it). When the words name a variable, the hub puts
both into one context and renders them with the run's own code (`expr.ts` `render`), so a test and a
run cannot differ. A variable with nothing is refused, `400 bad_request`, `details.reason:
template_unresolved` and `details.unresolved` naming each one — never sent as `{{…}}` and never as
a silent gap. Words without a variable are sent as they are, exactly as before; an older app that
sends words with a variable gets the refusal, which is the point.

**Where the values come from.** "Test this step" (`WorkflowStepTest`) takes the same two fields, and
its result gains `values`: what each variable of the step's words read as in the sample. The web
asks it with the workflow's newest run ("Use the last run's values") and fills a field per
variable; the person can change any, or type them all when there is no run. The preview under the
fields shows the words that will go, and Send stays off while a variable has no value. The phones
(iOS, Android) ask for a value per variable, show the preview, block until each has one, and send
the words filled in; taking values from the last run on a phone is a follow-up.

**What a run does is unchanged**: it still reads a variable with nothing as empty (§123).

## 134. The hub keeps each MCP server's last test, and writes Hermes's own per-server tool filter

Proposed (2026-09-29) — owner's request on Agent → Hermes → MCP: see a server's tools without
pressing Test every time, and choose which of them the agent may use. Owner to confirm. Additive
contract change only.

**The last test is kept.** `McpServer.last_test` (`McpLastTest`, or `null` when never tested in
this profile; absent from older hubs) carries what Hermes found: `ok`, the tools with their
descriptions, `tool_count`, `error`, `tested_at`, `duration_ms`. The hub writes it on every
`agents.testMcpServer` and when an OAuth sign-in lands (§122, the tools it then asks Hermes for),
into one JSON file of its own state (`<data>/mcp-last-tests.json`, keyed by the profile's Hermes home
and the server's name) — not Hermes's home, and no migration. Deleting the server forgets it. With
each test the hub keeps a hash of the server's connection settings (the block without `enabled`,
`tools` and the `oauth` block); when they differ now, `stale: true` says the list may be out of date.

**Read or write.** Each kept tool says `access` — `read`, `write` or `unknown` — and
`access_source`. Hermes's test answer carries no MCP annotations, and Hermes records only
`readOnlyHint: true` (in the profile's `cache/mcp_schema_cache.json`, for the tools it registered;
no `destructiveHint` anywhere), so the hub reads that when it is there (`annotation`) and otherwise
the verbs in the name (`name`): any changing verb (create, update, delete, move, merge, add, remove,
send, upload, start, stop, execute, run…) makes it `write`, else a looking verb (get, list, search,
read, fetch, query…) makes it `read`. It is a suggestion; the person ticks the boxes.

**The filter is Hermes's.** `McpServer.tool_filter` and `McpServerPatch.tool_filter`
(`McpToolFilter {include, exclude}`) are the server block's `tools.include` / `tools.exclude` in the
profile's `config.yaml` — the keys Hermes reads at the floor (v2026.9.14) and the pinned tag
(v2026.9.24) in `tools/mcp_tool_registration.py` `_make_tool_filter`, and writes itself in `hermes mcp
configure`: exact names or `fnmatch` globs; `include` (even `[]`, which allows none) wins; otherwise
`exclude`; neither — every tool. A patch with `include` writes the allow-list and drops `exclude`;
with only `exclude`, the block-list and drops `include`; both `null` removes them; the block's other
keys (`tools.resources`, `tools.prompts`) and every other byte of the file stay. Hermes applies it
when it next connects to the server — the restart the page already asks for. Hermes's test still
lists every tool, so the picker always sees the whole list. A real-Hermes suite proves both versions
register only the allowed tools (`mcp-tool-filter.real.test.ts`).

**Clients.** The web shows the count on the folded row ("61 tools", "12 of 61 tools"), the list on
opening, and tests a never-tested server once by itself when its row first opens; each tool has a
box, with All / None / Read-only. Every box ticked saves no filter; a filter that was a block-list
stays one; otherwise the ticked tools become an allow-list, and the page says a tool the server adds
later stays off until it is ticked. A hand-written glob is kept and the tools it decides cannot be
changed by a box. iOS and Android show the count and the list (with each tool's reading and whether
it is allowed); choosing on a phone is a follow-up. A hub without `last_test` gets every client's
page as it was.

## 135. "Send test message" always ends in words, and the hub logs every send

Proposed (2026-09-29) — the owner's tester on v1.1.5-preview.27: pressing "Send test message"
seemed to do nothing (no success, no error, nothing in Telegram), with a variable and with plain
words, and "Use the last run's values" once left the workflow page white. Owner to confirm.
Additive contract change only.

**Never silent.** The web's button ends in one of: a spinner with "Sending…" while it works; the
state with where it went and the platform's message id(s); Telegram's own words, or the hub's
error with its request id; "the hub did not answer within 90 s" (the page stops waiting); or "the
answer could not be read" when something other than a `WorkflowSendResult` came back (a proxy's
page). While it cannot be pressed it says why in words, not only in a tooltip: no target, a
Telegram target without a chat id, a conversation not chosen, no words, or the variables still
without a value.

**The hub's log line.** Each test send writes one line per target — `workflow send test`
(`info`) or `workflow send test failed` (`warn`) — with `workflow_id`, `node_id`, `profile`,
`platform`, `chat_id` or `session_id`, `status`, `message_id(s)` on success and `error_code` +
`error` on failure; a test refused before sending (`send_invalid`, `template_unresolved`, a run
that is not there) writes `workflow send test refused`. A run's own sends and its failure alert
write `workflow send` / `workflow send failed` with `workflow_run_id` as well. The bot token and the
words are never in a line or a reason: every copy of the token is cut out of a reason, and a
network failure names its cause (`ECONNREFUSED`, `ENOTFOUND`) instead of Node's bare "fetch
failed"; Telegram gets 20 s per message (`timeout`). `WorkflowSendTest` gains two optional fields,
`workflow_id` and `node_id`, used only for that line.

**Chat ids copied out of right-to-left text.** The hub and the web cut spaces and invisible
direction marks (LRM, RLM, the isolates, zero-width spaces, no-break space) out of a Telegram
chat id before it is checked or sent; the web saves the cleaned id, and a step saved earlier with
a mark in it still reaches the chat because the hub cleans it too.

**A panel error closes that panel only.** The editor's canvas, its side panel and a run's view
each sit in an error fence: an error while drawing one says what it was and offers it again (and
another step reopens it); the page, the drawing and its unsaved changes stay. The values of a
test are kept per step while the page is open — reopening the step shows them — and are never
saved into the step; "Use the last run's values" takes any answer as text and names the variables
the run had nothing for.

## 136. An agent step can talk in the same conversation every run

Owner's request (2026-09-29): a workflow's Agent step opened a new conversation on every run, so
the chat list filled with one conversation per run. Generic for every hub. The details below are
proposed — owner to confirm.

**Shape.** `WorkflowNode.conversation` (optional, nullable) is `WorkflowAgentConversation`:
`mode` (`new` — a new conversation per run, the default and what a step without the field does —
or `reuse`), `session_id` (the conversation's id, or a template such as
`{{trigger.body.conversation}}` rendered with the run's `render` like the prompt), and, for
`reuse`, `create_if_missing` (off by default) and `title` (a template; the step's title when
empty). `mode` is a plain string, as §124's `platform`, so the generated Kotlin and Swift clients
never meet an enum value they cannot decode; an unknown mode is refused when the workflow is
saved (`conversation_mode_unknown`), as is `reuse` without an id (`conversation_id_missing`) or
with one that is neither a ULID (after cutting spaces and invisible direction marks) nor a
template (`conversation_id_invalid`); template paths are checked like the prompt's. An app that
does not know the field sends an agent node without it and `updateWorkflow` keeps the saved
node's (`null` removes it), as for §123's `rules` and §124's `send`: older phones drop unknown
node fields when they decode, so the hub is what keeps them. Phones built from this contract
decode and re-send the field (it is in their generated `WorkflowNode`), show the mode, the id and
"created if missing" read-only on the agent step, and keep it on save; editing it on the phones is
a follow-up.

**Who may use which conversation** (enforced by the hub at run time, and by the same function
behind "Test conversation"): the conversation must be in the run's profile (workspace) as the
person the run acts as reaches it — a trigger's run acts as the trigger's creator (§123), a
schedule's as its owner, a run by hand as whoever pressed Run. Another profile's conversation is
answered exactly like a missing one (`not_found`), so nothing about it is told. A room seat's
conversation (it belongs to its room) and another person's own assistant (`global_agent`) are
refused (`not_allowed`). **The agent**: a conversation has one agent; the step's agent must be
the same (`agent_mismatch` otherwise, never a silent switch), or the step may leave its agent
empty and the conversation's own agent answers (the save warning `agent_missing` is not raised
for a `reuse` step). The web's picker sets the step's agent to the picked conversation's. The
turn uses the step's own model/provider when it names one, else the conversation's.

**Missing conversation.** Off (default): a missing, deleted or foreign conversation fails the step
with "the conversation <id> was not found in this profile (it was deleted, or it is another
profile's)" — never a new conversation in silence. On: the run makes one (source `workflow`,
origin the workflow, the step's agent, the rendered title) and the turn goes there; when the
step's `session_id` is a plain id the step is **pointed at the new conversation** (the drawing's
version is not bumped, as §124 does for a deleted Send-message conversation) so every later run
talks there, and the run owner's inbox says which conversation was missing and which was made
(plus a `workflow conversation made` log line). A templated id is not repointed — the next run's
values decide again. Runs that were waiting for the same missing id use the conversation the first
one made (remembered in memory by the requested id, so two concurrent runs do not make two).

**Turns one at a time, whole.** Runs that reach the same conversation are serialized in the hub:
a run waits until the workflow turns queued before it for that conversation have ended *and* the
conversation has no turn going on (a person's included), and only then writes its prompt and
starts its run. The history therefore reads prompt, reply, prompt, reply (never two prompts before
their replies), Hermes never receives a second turn while one runs (it would answer
`already_running`), and each run's output is read by its own run id — its own reply only. The
wait is bounded (10 minutes; `WorkflowPorts.conversationWaitMs`); past it, or when the step's
timeout or the run's budget ends the step, nothing is written into the conversation and the step
fails with "the conversation was busy with another turn for N s; this run did not send its
message".

**Outputs.** `WorkflowStep.session_id` — declared since §52 but always `null` — is now filled for
every agent step (new or reused conversation), and `WorkflowStep.message_id` (new, optional) is the
agent's reply message; `output` stays the reply's text. Later steps may read
`{{steps.<id>.conversation_id}}` (also `session_id`), `message_id`, `run_id` and `status`
(`succeeded`/`failed`) besides `output`. The web's run view opens the conversation at the reply.

**Test conversation** (`schedules.checkWorkflowConversation`, `POST /workflows/conversation-check`,
additive): `{ session_id, agent_id? }` → `WorkflowConversationCheckResult` with `status` (a plain
string: `ready`, `busy`, `not_found`, `not_allowed`, `agent_mismatch`), the title, the agent, the
turn going on and a reason; nothing is sent or saved. A template is `400` (`conversation_id_template`):
it has no value until the step runs.

**Web.** The agent step's form has "Conversation": "A new conversation for each run" or "The same
conversation every run". The owner's shape: the **picker is the main control** (the profile's
conversations, searched by title, each with its last activity and agent; room seats are not
offered), "Paste a conversation id instead" is the secondary way (templates only there); a plain
id, picked or pasted, is looked up at once and shown by its title or the reason it cannot be used;
"Test conversation" asks again; "Create if missing" (off) with the new conversation's title.

Rejected: a new node kind or an enum `mode` (older phones would fail to load workflows); queueing
the prompt in the session's own run queue at once (two runs would write two prompts before either
reply, and a run that gave up would leave an unanswered prompt behind); letting a step switch a
conversation's agent (a conversation has one agent in every client); telling another profile's
conversation apart from a missing one (it would confirm that it exists).

## 137. A "Send message" step chooses how Telegram reads its words: plain, HTML or MarkdownV2

Owner's request (2026-09-29): a Send message step (§124) sent no `parse_mode`, so `**` or `<b>`
arrived as written. Generic for every hub. The details below are proposed — owner to confirm.
Additive contract change only.

**Per step, per Telegram target.** `WorkflowSendTarget.formatting` (optional, nullable) is a plain
string — `plain`, `html` or `markdown_v2` — like §124's `platform`, so a later value never meets an
older app's enum. Absent or `null` is `plain`: every step saved before this reads and sends exactly as
before, and nothing is rewritten. Any other value (`HTML`, `Markdown`, `''`…) is refused when the
workflow is saved or tested (`send_formatting_unknown`); a stored value is never handed to Telegram
as it is. It is a property of the step, not of the bot or the profile. A conversation target
ignores it (the conversation renders its own Markdown). A failure alert (§127) is always sent
plain: the hub writes its words, and an error may hold `<` or `*`.

**What Telegram receives.** `plain`: no `parse_mode` field at all, the words as they are. `html`:
`parse_mode: "HTML"` — Telegram's own tags only (b/strong, i/em, u/ins, s/strike/del, code, pre,
`a href`, tg-spoiler / `span class="tg-spoiler"`, blockquote; Bot API "HTML style"), nothing is
sanitized or escaped by the hub. `markdown_v2`: `parse_mode: "MarkdownV2"`, never the legacy
`Markdown`. The formatting applies to the words after their variables are filled (`render`), so a
variable's value is part of the markup: a value with `<`, `&` or an unescaped `.` can make Telegram
refuse it (escaping a variable's value is a follow-up).

**A refusal is said, never hidden.** When Telegram cannot parse the markup (`Bad Request: can't
parse entities: …`) the target fails with `Telegram HTML formatting failed: can't parse entities: …`
(or `MarkdownV2`) — the mode and Telegram's own words; the hub never resends it plain and never says
`sent`: `message_id` only for what Telegram took. Other refusals stay Telegram's words.

**Long messages.** Plain words are split exactly as before (§124). A formatted one is measured on
what Telegram counts — the text after its entities are parsed (tags, markers and escapes count
nothing; `&lt;` counts one) — against 4000 (Telegram's 4096 with a margin), and cut on a paragraph,
then a line, then a word, else between two characters; never inside a tag, an entity (`&amp;`), an
escape (`\.`), a custom emoji or a date. The spans open at a cut are closed at the end of the part and
opened again at the start of the next (`<b>`, `<a href="…">`, `<pre><code class="language-x">`; in
MarkdownV2 `*`, `_`, `__`, `~`, `||`, a code block with its language, a link's `](url)`, a quote
line's `>`, an expandable quote's `||` / `**>`; an empty bold `**` keeps a closing `_` from reading
as `__`), so each part is valid on its own. A text that fits is sent whole and untouched (Telegram
judges it); a longer one whose markup cannot be walked is refused before any part is sent. Each part
is remembered as before (`workflow_sent_parts`, same run/node/target/part key), so a retry or a
rerun sends only the parts that did not go.

**Output and log.** `WorkflowSendResult` gains `formatting`, `parse_mode` (`null` for plain),
`chat_id` and `parts_count` of the (first) Telegram target, and `targets` — `WorkflowSendTargetResult`
per target (`target`, `platform`, `chat_id`, `session_id`, `formatting`, `parse_mode`, `status`,
`message_ids`, `parts_count`, `reason`); a target that failed part way keeps the ids of the parts
that went. The `workflow send` / `workflow send test` log lines add `formatting`, `parse_mode` and
`parts_count`; the token is still cut out of every reason (§135).

**Keeping it.** An app that knows `send` but not `formatting` rebuilds the Telegram target from the
chat id and saves it without the field; `updateWorkflow` gives each such Telegram target the
formatting of the saved Telegram target in the same place (the first with the first), so an older
phone does not turn an HTML step plain. `null` sent on purpose is plain.

**Clients.** The web's Send message form has "Telegram formatting" (Plain text / HTML / MarkdownV2)
under the chat id; the preview says "Telegram formatting: HTML" and shows the words formatted — parsed
by the web into Telegram's tags only (no HTML is injected), with a note when the markup looks broken;
"Send test message" sends with the chosen formatting. iOS and Android show the formatting on the
step, can change it, and keep it when the chat id is edited.

Rejected: a per-bot or per-profile setting (the owner asked per step); falling back to plain when
Telegram refuses the markup (it would send words the person did not mean, and say success);
Telegram's legacy `Markdown` (no nesting, no underline/spoiler/quote); an enum in the contract
(older generated clients cannot decode a value added later).

## 138. A coding agent's MCP page edits its own file; an agent is installed without `--version`; a failed agent says why

The owner's hub (2026-09-29, image from `main` after #226): Claude Code's MCP page answered "That
is not allowed in the current state." in its server list and its "Core Hub tools" card although
the agent was Available; installing Codex ended in "Error" with codex-acp's own "unexpected argument
'--version'"; a chat with Goose (installed, no provider set) ended in a bare "Internal error" and
Claude Code in "Authentication required", both cards looking ready; the model picker said "Default
model" without saying which. Proposed here — owner to confirm:

- **The MCP operations serve the coding agents the catalog offers the page to.** For Hermes nothing
  changes. For Claude Code they edit the `mcpServers` of its global config `~/.claude.json`
  (`$CLAUDE_CONFIG_DIR/.claude.json`; a legacy `.config.json` wins when present) — the user-scope
  servers the CLI reads on every session its ACP bridge starts (`settingSources: user, project,
  local` at `@zed-industries/claude-code-acp` 0.16.2). Claude Code rewrites that file itself, under
  a lock folder `<file>.lock` (stale after 10 s); the hub takes the same lock, reads the file again
  inside it, changes `mcpServers` only and renames a new file over it, keeping its mode. For Gemini
  CLI and Qwen Code they edit `mcpServers` in `settings.json`; a file with comments is read but
  never rewritten (`400`, `config_has_comments`). None of these files has a per-server "off", so a
  server switched off is taken out of the agent's file and kept in
  `<DATA_DIR>/agent-mcp/<agent>.json` (0600) until it is switched on. Credentials read as
  `[stored]` as for Hermes. One set for every profile, as on the Config files page (§78). A coding
  agent's `McpServer` carries no `last_test`, `oauth` or `tool_filter` (Hermes's), and a
  `tool_filter` write is `409 tool_filter_is_hermes_only`. Codex, Goose, OpenCode, Kimi, Grok and Pi
  answer `409 state_invalid`, `mcp_not_managed`, and the page says their servers are in their
  settings file (Config files); `config_busy` when Claude Code holds its lock past 3 s.
- **The Core Hub tools card is the profile's, on every agent's page.** `agents.getHubTools` /
  `updateHubTools` answer for any agent over ACP (the agent is handed the server in `session/new`,
  §67); the card says the settings are shared and keeps Test (which asks Hermes) to Hermes's page.
- **Installed is decided by the files, not by `--version`.** A catalog `HealthCheck` may be
  `installed`: nothing is run, the protocol binary must be in the agent's `bin` and executable
  (Claude Code, Codex). An npm agent's version is its package's `package.json` under its prefix. A
  `command` check that runs and says no (any exit code) or reaches its deadline leaves the agent
  installed; only a program that cannot start (spawn error, exit 126/127, not executable) fails.
- **A failed agent says why.** An ACP error carries what its `data` adds; a bare "Internal error"
  the last lines of the bridge's stderr; credentials masked, 600 characters at most. The web's
  failure notice names the agent's known cases with one action where the hub has one — Goose → its
  Config files, Claude Code / Codex / Gemini CLI / Qwen / OpenCode / Pi → Settings → Models, Kimi and
  Grok → their own sign-in — with the agent's words underneath.
- **`Agent.credentials`** (optional string, `ready` | `missing`): for an installed Claude Code,
  Codex, Gemini CLI, Qwen Code or Goose, whether a key it reads is handed or set, or its own sign-in
  or provider setting is in its folder (Goose: `GOOSE_PROVIDER`). The card says "Needs a provider or
  sign-in". A string, not an enum (§137's reason).
- **`Agent.agent_default_model`** (optional string): the model a coding agent's own settings name
  (Claude Code `model`, Codex top-level `model`, Gemini/Qwen `model.name`, Goose `GOOSE_MODEL`,
  OpenCode `model`); the picker says "Default · <model>", or "Agent's own default" when none is
  named; Hermes and the hub's own agent say "Default · <default_model>".

Rejected: an MCP list kept by the hub and handed in `session/new` (a second list beside the one the
agent already reads, and invisible to the agent run by hand); an ACP `initialize` handshake as the
health check (a process per agent at every boot, and a sign-in some agents want first); a new
`ErrorCode` for "sign-in needed" (older generated clients cannot decode it); the phones in this
change (they still say "Default model" and show no badge — a follow-up).

## 139. A coding agent gets an allow-list of the hub's environment; the renamed ACP bridges; Claude Code's skills

Phase 0 of the model gateway (research in PR #228, `docs/research/model-gateway-2026-09.md`,
approved by the owner on 2026-09-29). Proposed here — owner to confirm:

- **A coding agent the hub starts gets an allow-list of the hub's environment, never all of it.**
  Until now an ACP agent inherited the hub's whole `process.env` — the database URL, the first-owner
  password, push keys, anything an operator put in the container reached every third-party CLI and
  the package scripts it ran. Now it gets: a base every program needs (`PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `TMPDIR`, `XDG_*`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TERM`, `COLORTERM`, the
  proxy variables in both cases, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`,
  `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, npm's cache and registry, the desktop session's
  `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`, and what
  a Windows program cannot start without); the variables its catalog entry maps its keys to
  (`credentials`); and the ones the entry documents the agent reading (`hostEnv`: Claude Code
  `ANTHROPIC_*`, `CLAUDE_*`, its Bedrock/Vertex routes; Codex `OPENAI_*`, `CODEX_*` and codex-acp's
  own switches; Gemini `GEMINI_*`, `GOOGLE_*`; Qwen `QWEN_*` and its providers; Kimi `KIMI_*`,
  `MOONSHOT_*`; Grok `XAI_*`, `GROK_*`; Goose `GOOSE_*`, OpenCode `OPENCODE_*` and Pi `PI_*` with
  every provider's variables). `COREHUB_*`, `MAJLIS_*`, `HUB_*`, `DATABASE_*`, `TELEGRAM_*`,
  `DATA_DIR` and `PORT` are never passed, whatever an entry names, and the catalog refuses an entry
  that asks for them. `NODE_OPTIONS` is not passed. What the hub itself hands the agent (the
  profile's shared keys, its settings `env`) is added on top, as before. The same list serves the
  agent's sign-in and its `--version` checks. A person who set a key or setting for an agent in the
  host's environment keeps it: every variable the agent reads is on its list (a test starts each
  catalog agent as a fake program and checks both sides).
- **No program the hub starts is given the hub's own settings.** `HostEnv.inherited` is the host's
  environment less the hub's configuration keys (`ENV_KEYS` and their old names). Hermes, npm and
  the other helpers get this — Hermes keeps everything else it reads (its channels' tokens,
  provider keys, `HERMES_*`, a skill script's `COREHUB_IMAGE_*`), so nothing of it breaks.
- **Claude Code and Codex move to the renamed ACP bridges.** `@zed-industries/claude-code-acp`
  0.16.2 and `@zed-industries/codex-acp` 0.16.0 are deprecated on npm; the pins are now
  `@agentclientprotocol/claude-agent-acp` 0.84.0 (program `claude-agent-acp`) and
  `@agentclientprotocol/codex-acp` 2.0.0 (program `codex-acp`; it installs `@openai/codex` beside
  it). An npm entry may name `legacy` packages with their program. An install of the old package
  keeps working with no action: the hub finds its program under the old name, runs it, and reads
  its version from its own `package.json`, so the card offers the update (0.16.2 → 0.84.0). Taking
  the update (or auto-update) installs the new package into `<DATA_DIR>/agents/.<id>.next`, runs
  its `--version` (a Node too old for it fails here), swaps the folders and runs the health check;
  anything that fails leaves the old install exactly as it was. npm cannot install the new package
  over the old one in place (both own `bin/codex-acp`: EEXIST), which is why the swap. A dot folder
  under `agents/` is never put on `PATH`. Checked with the real packages (`acp-bridges.real.test.ts`):
  the old bridge installed, updated by the hub's installer, and the new one driven by the hub's ACP
  adapter through `initialize`, `session/new` and a turn against a local fake Anthropic / OpenAI
  Responses endpoint named only in the environment — the key the hub handed reached it. codex-acp
  (0.16 and 2.0 alike) still asks for a sign-in at `session/new` when it is only handed a key
  unless `DEFAULT_AUTH_REQUEST` says to use it; that is unchanged here and left to the gateway work.
- **Claude Code's Skills page manages `~/.claude/skills`** (`$CLAUDE_CONFIG_DIR/skills`) instead of
  answering `409 skills_are_hermes_only`: the skill operations (list, read, write, switch, pin,
  delete, import) act on that folder, one set for every profile, as its Config files and MCP pages
  do. Nothing of Hermes's applies there: no `library` in the list, no bundled skills, no `platforms`
  filter, and off is `SKILL.md` renamed `SKILL.md.off` — never a `config.yaml` written into
  Claude Code's folder. Every other agent that is not Hermes still answers `skills_are_hermes_only`;
  the library operations stay Hermes's.

Rejected: a deny-list for coding agents (whatever an operator adds tomorrow would leak again);
passing `GITHUB_TOKEN`/`GH_TOKEN` through (a secret; a person who wants it gives it in the agent's
settings `env`); removing the old bridge in place before installing the new one (a failed install
would leave no agent); a shared `~/.agents/skills` page now (the survey's next step, not tonight's);
calling ACP `authenticate` for Codex (it writes the key into Codex's own `auth.json`; the gateway
work decides how the hub signs agents in).

## 140. The model gateway, phase 1: every coding agent runs on any model the hub has

ADR 0029 (the hybrid the owner approved on 2026-09-29: the hub's own gateway in front, CLIProxyAPI
behind it as the translator). Phase 1. The owner's rules are the ADR's; what follows is how phase 1
does them, proposed here — owner to confirm:

- **Contract, additive only.** `Agent.model_source` (a string: `hub` or `agent`; absent for Hermes, the
  hub's own agent, agents not wired yet, a hub whose gateway is off, and older hubs): where a coding
  agent's model calls go in this profile. `Model.agent_gateway` (boolean; absent when the hub has no
  gateway): a coding agent can run this model through the gateway — its provider has a key the hub
  holds and is not a subscription signed in to through Hermes. The choice itself is a field of the
  agent's settings form (`models` section, `model_source`: `auto` / `hub` / `agent`, default `auto`),
  which the settings operations already carry; no new operation. The gateway's own routes
  (`/gateway/anthropic/…`, `/gateway/openai/…`) are not `/api/v1`: they are served on a loopback port
  of their own to the programs the hub starts, and documented in ADR 0029 §2.
- **Which agents, and how.** Claude Code (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` = the token,
  `ANTHROPIC_MODEL` and the Opus/Sonnet aliases = `corehub-main`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` =
  `corehub-small`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, the model's context window when known; its API key,
  OAuth token and Bedrock/Vertex switches taken out). Codex (`CODEX_CONFIG`: a `corehub` provider,
  Responses wire, `env_key` = the token's variable, model `corehub-main`; and codex-acp's own `gateway`
  sign-in method as `DEFAULT_AUTH_REQUEST`, which changes only the running session — the `api-key`
  method was not used because it writes the token into Codex's `auth.json`, over a ChatGPT sign-in).
  Goose (its OpenAI provider at the gateway's Chat Completions path), OpenCode (an OpenAI-compatible
  provider in `OPENCODE_CONFIG_CONTENT`, models.dev not asked), Qwen Code (`OPENAI_BASE_URL`,
  `OPENAI_API_KEY`, `OPENAI_MODEL`) and Kimi Code (its env-only temporary model), all from the
  research's verified names; all six are proven with the real agents (below). Each entry's wiring is data in its catalog file (`gateway`). Gemini
  CLI, Grok Build and Pi keep their own account (phases 2–3).
- **What an agent on the gateway is given.** Its own settings `env` and `secret_refs` as before; none
  of the profile's provider keys; the wiring's variables; `NO_PROXY` with the loopback addresses added.
  The wiring's `clears` and the entry's key variables are taken out after everything is merged
  (`AgentTarget.envRemove`), so a key in the host's environment does not reach it either. An agent not
  on the gateway gets exactly what it got before.
- **Automatic.** `hub` in the image (`COREHUB_AGENT_MODEL_SOURCE=hub`); elsewhere `hub` unless the agent
  has its own sign-in or provider on this computer (its sign-in file, a provider its settings name, a
  key in the environment the hub runs in — `agent-credentials.ts` §`ownSignIn`). In every mode `agent`
  when there is no model to give it (none picked, no default), and, on Automatic, when the chosen
  model's provider is one the gateway does not serve. A choice of `hub` with such a model is refused by
  the gateway with the reason, never silently served by the agent's own account. A change applies from
  the next message: the runner starts the agent again with the other environment. When the gateway
  cannot start (no CLIProxyAPI, it fails), the agent runs on its own account and the log says why.
- **Per turn.** The runner sets the token's turn (run, provider row, model) before each prompt and
  clears it after; the gateway resolves `corehub-main`, `corehub-small` and any id it does not know to
  it, and a catalogue key to its own model. A call between turns runs on the last turn's model.
- **Usage.** Read from each answer (Anthropic `message_start`/`message_delta`, Responses
  `response.completed`, Chat's usage chunk, or a whole JSON body) without changing a byte; the turn's
  running totals per model reach the run as the adapters' usage events do, priced from the model row
  (`estimated`); a call that ends after its turn is added to that run's row (`recordUsage` gains
  `accumulate`, which adds instead of replacing).
- **CLIProxyAPI** 8.0.4, pinned per platform by SHA-256 (`scripts/cliproxy/pin.json`, the Linux builds
  are the static `no-plugin` ones); in the image at `/opt/corehub/bin/cli-proxy-api` (+22.6 MB
  compressed), in each desktop installer at `resources/cliproxy/` (+16–24 MB measured: `.exe` +15.9, `.deb` +17.6, `.dmg` +20.9, `.AppImage` +22.7,
  `.msix` +23.7), for a developer from
  `pnpm cliproxy:fetch`; `COREHUB_CLIPROXY_BIN` names another, `COREHUB_MODEL_GATEWAY=off` switches the
  whole gateway off. Started the first time an agent needs it, run with `-local-model` (no remote model
  catalogue), restarted with a backoff (1, 2, 5, 10, 30 s), its lines in the hub's log under `cliproxy`
  (its per-request lines at debug), a change of providers served by a new process while the old one
  finishes its streams. Known: it still asks GitHub for the Antigravity client version every three
  hours, which the hub cannot switch off.
- **Proven for real** (`agents/model-gateway.real.test.ts`, a CI job required through `gate`):
  CLIProxyAPI 8.0.4 + the hub's gateway + the real `claude-agent-acp` 0.84.0 and `codex-acp` 2.0.0,
  against a provider that speaks only Chat Completions: Claude Code writes a file with its `Write` tool
  on the provider's tool call and the next request carries the result; Codex answers through Responses;
  a call without a token, with a forged one or a revoked one is refused; the provider's key reaches the
  provider only — not the agent's environment, not the hub's log — and the token never reaches the
  provider; and Goose 1.52.0, OpenCode 1.18.31, Qwen Code 0.24.5 and Kimi Code 2.1.1 each answer a
  turn through the Chat Completions path on nothing but their catalog wiring.

Rejected: an agent pointed at CLIProxyAPI directly (static shared keys, no profile, turn or ledger); a
download of CLIProxyAPI on first use in the desktop app (a runtime download-and-run path for 16–24 MB
the owner's size budget allows); lending Hermes-held subscriptions (the owner); restarting CLIProxyAPI
in place on a provider change (it would cut other agents' streams); counting a call's usage into the
ledger directly while its turn is live (the run's own totals would double it).

## 141. The model gateway, phase 2: Gemini CLI, Grok Build and Pi; tool calls for every agent; phones; picker quality

ADR 0029, phase 2 (stacked on §140). The owner's priority: Gemini CLI on any connected model. What
follows is proposed here — owner to confirm:

- **The Gemini wire in the hub's gateway.** `POST /gateway/google/v1beta/models/<model>:generateContent`,
  `:streamGenerateContent` (with `?alt=sse`) and `:countTokens`, and `GET /gateway/google/v1beta/models`
  (and one model), on the same loopback listener as §140 and, like it, not `/api/v1`. The model is in
  the path, so the path is what is resolved and rewritten — `corehub-main`, `corehub-small` and any
  id the hub does not know (Gemini CLI's router and utility calls name flash-lite models) become the
  turn's model, a catalogue key its own — to CLIProxyAPI's `/v1beta/models/h<row>/<model>:<method>`.
  CLIProxyAPI 8.0.4 serves those three methods and translates Gemini in to OpenAI Chat, Anthropic or
  Gemini out, tools included (checked against its source, `translator/openai/gemini`, and for real).
  The token is read from `x-goog-api-key` (what `@google/genai` sends) or `?key=`, which is taken
  out of the query before anything is forwarded. Usage is read from `usageMetadata` (output =
  candidates + thoughts), streamed or whole, a stream without `alt=sse` being one JSON array. Errors
  come back in the Gemini envelope (`{error: {code, message, status}}`).
- **A model id with a colon** (Ollama's `qwen3:8b`) is served to CLIProxyAPI under an alias with `__`
  for the colon: its Gemini route splits `models/<model>:<method>` on the colon. The group's `name`
  keeps the real id, so the provider gets the id it listed (checked).
- **Gemini CLI** (0.60.0): `GOOGLE_GEMINI_BASE_URL=<gateway>/gateway/google` (loopback may be
  http), `GEMINI_API_KEY=<token>`, `GEMINI_MODEL=corehub-main`; taken out: `GOOGLE_API_KEY`, the
  Vertex, Code Assist and Cloud variables, `GOOGLE_GENAI_API_VERSION`, `GEMINI_API_KEY_AUTH_MECHANISM`.
  With no sign-in type chosen, or an API key, that is all. A person who chose a Google or Vertex
  sign-in has it win over the variables (its ACP `newSession` reads `security.auth.selectedType`
  first), and only the system settings rank above theirs — which it reads only from a root-owned
  folder (checked: a hub-owned file is skipped as "not owned by root"). So such a Gemini CLI runs in a
  home of the hub's own (`GEMINI_CLI_HOME=<DATA_DIR>/gateway/agents/gemini-cli/home`) whose `.gemini`
  links every entry of the person's own (sessions, memory, extensions, credentials — the same files)
  and holds a copy of their `settings.json` with `selectedType: "gateway"`; nothing of theirs is
  changed. Not on Windows (links): there it keeps its own account. The ACP `authenticate` call was
  not used: it writes the type into the person's settings and clears their Google credentials. Its
  flag stays `--experimental-acp` (0.60.0 and 0.62 take it; a Gemini CLI found on the computer may be
  older than `--acp`). A Gemini CLI older than 0.60.0 (no `gateway` type) keeps its own account.
- **Grok Build** (1.0.41) takes a model with its own address only from a `[model.<id>]` table of
  `$GROK_HOME/config.toml`; its `GROK_CONFIG`/`GROK_CONFIG_PATH` overlay does not define models
  (checked). The hub keeps one table, `[model.corehub-gateway]` (Chat Completions, `base_url` the
  gateway, `env_key = "COREHUB_GATEWAY_TOKEN"`, `model = "corehub-main"`, `context_window`), between
  two marker lines at the end of the file, the rest of the file byte for byte, and picks it with
  `GROK_DEFAULT_MODEL=corehub-gateway` — the person's `[models] default` stays theirs.
- **Pi** (0.87.1 with pi-acp 0.0.34) takes a provider only from `$PI_CODING_AGENT_DIR/models.json`.
  The hub keeps one key there, `providers["corehub-gateway"]` (`openai-completions`, `apiKey:
  "$COREHUB_GATEWAY_TOKEN"`, the two aliases as its models), known as the hub's by its loopback
  gateway address, every other key as it was; and switches the ACP session to it with
  `session/set_config_option` (`model` = `corehub-gateway/corehub-main`), which pi-acp turns into Pi's
  `set_model` without saving a default. A session that refuses it does not start (no other model
  answers instead). `AgentTarget.sessionConfig` carries it; the ACP adapter now also closes the
  process when a session cannot be opened.
- **Written, never a key.** The blocks name the token's variable; the gateway's port is in them (a
  new one each time the hub starts), so they are rewritten when they differ. They stay when the agent
  runs on its own account (another conversation may be using them; without the token they serve
  nothing). Refused — the agent keeps its own account and the log says why — when the file does not
  parse, is over 1 MiB, is a link out of the home, or already has a table/provider of that name that
  is the person's.
- **Tool calls, for real, for every wired agent** (`agents/model-gateway.real.test.ts`, the
  required `model-gateway-real` job): with the real CLIProxyAPI 8.0.4 and a provider that speaks
  only Chat Completions, Gemini CLI 0.60.0, Goose 1.52.0, OpenCode 1.18.31, Qwen Code 0.24.5, Kimi
  Code 2.1.1, Grok Build 1.0.41 and Pi 0.87.1 each write a file with their own tool on the
  provider's streamed tool call, and the next request carries the result (Claude Code and Codex as
  in §140). The provider's key reaches the provider only; the person's own settings beside the
  hub's block come through unchanged.
- **Contract, additive only.** `Model.agent_tools` (boolean, `false` only when the provider's
  metadata says the model takes no tools — OpenRouter's `supported_parameters` without `tools`;
  absent when unknown). Kept in `models.capabilities` as an internal `no_tools` marker, never served
  as a capability and taken out of profile exports (an older hub would serve it). `Agent.gateway_min_context`
  (integer, with `model_source`): the smallest context window worth giving the agent through the
  gateway — Claude Code, Codex, Gemini CLI, Grok Build 64K; Goose, OpenCode, Qwen Code, Kimi Code
  32K; Pi 16K.
- **Pickers.** On web, iOS and Android, a coding agent on the hub's models is offered gateway models
  that can call tools; one whose known context window is under the agent's floor says "small
  context (under 64K)". A hint, not a refusal.
- **Phones.** iOS and Android read the chat's agent (`agents.get`) to filter the picker and name the
  default ("Default · <model>", the web's rule), and the agent card says "Models: Core Hub's
  providers" / "the agent's own account". `model_source` is changed in the agent's settings form,
  which both apps render from the server. An older hub, without the fields, leaves both as they were.

Known limits: Grok Build refuses a Chat Completions chunk without `created` (real providers send
it); CLIProxyAPI's Gemini-in translation appends an empty user message after a tool result, which a
strict provider might refuse (not seen); Gemini in to an Anthropic provider round-trips tools
(checked by hand) but CLIProxyAPI 8.0.4 reports its input tokens as 0, so such a turn's cost is
counted low.

## 142. The model gateway after its first live test: one reader per turn; a spent quota fails fast and plainly

ADR 0029, after the owner's first live test (2026-09-30). Additive only (`Run.error.details` is
already the `Error` envelope's). Proposed here — owner to confirm:

- **One reader per turn.** A turn the runner ends itself (the agent refused the prompt) lets go of
  the session's event stream; an ACP turn drops what the agent said after the last turn ended, and
  waits (at most 15 s) for a turn the hub stopped before it asks again. Before this, a stale reader
  took every other event of the next turn: the owner's «هلا! كيف أقدر أساعد؟» arrived as
  «لا كيفقدرساعد؟», and the turn never ended.
- **CLIProxyAPI does not cool a provider row down** (`routing.cooldown.disable-cooling`, no retry
  rounds): each row is one key, so after one 429 it only refused the row for a growing while, in
  words carrying the row's internal id.
- **Spent or passing.** Google says `RESOURCE_EXHAUSTED` for a spent quota and for a per-minute
  rate or token limit alike (the owner's models had credit), so the gateway tells them apart:
  - **spent** — a 402, or a 429/403 saying `insufficient_quota`, billing, payment, credit, a usage
    limit, or a daily/monthly quota (`…PerDay…`): answered at once;
  - **passing** — a 429/403 saying quota, `RESOURCE_EXHAUSTED` or CLIProxyAPI's "cooling down"
    without those: the gateway waits the provider's own time (`retry-after(-ms)`, Google's
    `RetryInfo.retryDelay`, "Please retry in …", `reset_seconds`; else 20 s) **once**, at most 30 s,
    and asks again in the same turn. A second refusal, or a longer wait, counts as spent.
    CLIProxyAPI 8.0.4 keeps only the message when it translates such an error to the Anthropic,
    Responses or Gemini wires (checked), so there the wait is the 20 s default;
  - anything else — a plain rate limit ("slow down") — passes to the agent as before.
  A spent quota is answered in the agent's own envelope and in words it does not retry: 429 with
  `x-should-retry: false`, `rate_limit_error` (Anthropic), `insufficient_quota` (OpenAI), and for
  Gemini an `ErrorInfo` `MODEL_CAPACITY_EXHAUSTED` (Gemini CLI's terminal quota error). The message
  names the provider and the model as people know them. The same turn does not ask that model
  again; a new turn does. There is no live "waiting" line in the chat yet (it needs a new event).
- **Every call is the turn's model.** On the hub's models the gateway serves each call the model
  picked for the turn (else the agent's default in the profile), whatever id the agent names —
  `corehub-main`, `corehub-small`, a vendor id, or a catalogue key it picked itself from
  `/v1/models` (this replaces §140's "a catalogue key names its own model"). The chain applies
  only after that model failed.
- **The profile's fallback chain** (§54, which lists a rate limit among its failures) takes over:
  the gateway moves the turn to the chain's next model it can serve, for the rest of the turn, and
  the run says so (`model_fallback`, as a Hermes turn does, every model it went past in order —
  the chosen one first). With nothing left, the run fails. The web names the models in that line
  and in "Answered by" as «<provider> · <model>» from the catalogue, not by their keys.
- **The run's error:** `code: rate_limited`, `error` the sentence in the request's language
  ("{provider} ran out of quota for {model}. Pick another model for this chat."), and
  `details: {reason: "quota_exhausted", provider, model, provider_id, model_id}` — `provider` and
  `model` being the names people know. An agent that writes the error as its answer (Goose, Kimi
  Code, Pi) fails the same way; one that keeps retrying (OpenCode, Qwen Code) is stopped after 8 s.
  Clients: the web says it in the person's language with a button that opens the chat's model
  picker; an older client shows the sentence and the code as before.
- **No internal names**: an error the gateway passes on has `h<row id>/…` replaced by the
  provider's and model's names.

## 143. Subscription sign-ins through the bundled CLIProxyAPI; Hermes on the hub's models

ADR 0030 (the owner's decision of 2026-09-30, after the research of PR #230). Additive only. What
follows was confirmed by the owner on 2026-10-01 («اعتمد»), including the full CLIProxyAPI provider
list and "check now" on the vendors' undocumented usage addresses; §144 replaced its Hermes choice:

- **Who moves.** Every provider connected by signing in to an account is signed in to by the
  CLIProxyAPI the hub bundles (8.0.4): ChatGPT (`codex`), Claude (`claude`), xAI (`xai`), Kimi
  (`kimi`, `kimi-ai`), Meta (`meta`), Google Antigravity (`antigravity`), Devin (`devin`) — every
  vendor its management API signs in to. Gemini CLI, Qwen and iFlow were removed from CLIProxyAPI;
  Vertex is a service-account import, not a sign-in, and is not offered. Providers connected by
  key or address stay exactly as they are. The hub does not block or judge a vendor; the list
  carries one neutral sentence (`SubscriptionVendors.note`: some vendors limit using a
  subscription outside their own apps).
- **Flows.** A short code (`flow: device`) for xAI, Kimi and Meta (CLIProxyAPI's management API)
  and for ChatGPT (`cli-proxy-api -codex-device-login -no-browser` run as a child process; the hub
  reads `Codex device URL:` / `Codex device code:` and takes only "Codex device authentication
  successful" as success, since the flag exits 0 either way). A link (`flow: link`) for Claude,
  Antigravity and Devin: `ProviderSignIn.accepts_code: true`, `callback_hint` (how the address
  begins), and `models.completeProviderSignIn` with the whole address the browser landed on — its
  own `state` is what CLIProxyAPI checks, so an address from an older sign-in is refused. On the
  desktop the callback could be caught on the same computer; that is a follow-up.
- **Contract.** `models.listSubscriptionVendors` (`GET /models/subscription-vendors`);
  `models.getProviderAccounts`, `models.updateProviderAccount` (`disabled`),
  `models.removeProviderAccount`, `models.refreshProviderAccount`, `models.checkProviderAccount`
  (`/models/providers/{id}/accounts[/{account_id}[/refresh|/check]]`);
  `models.moveProviderToGateway`; `models.getHermesModelSource` / `models.setHermesModelSource`
  (`/models/hermes-source`). Fields: `Provider.subscription {vendor, flow, accounts,
  accounts_ready}`, `Provider.gateway_move {preset}`, `ProviderSignIn.callback_hint`,
  `ProviderPreset.replaced_by`. The gateway presets are not in `models.listProviderPresets`, so an
  older client never offers a link it cannot finish; an older client that meets such a row still
  shows it and can sign in by code. `completeProviderSignIn` now accepts an address for a link
  sign-in (it answered 409 for every sign-in before). An older hub answers 404 to the new
  operations and a client hides them.
- **Accounts belong to a row.** After an approved sign-in the hub finds the account CLIProxyAPI
  saved (new, or renewed: same file name) and sets `prefix: h<row>`, `note: corehub:<row>`,
  `disable_cooling: false` through `PATCH /credentials/fields`. The gateway's `h<row>/<model>`
  then reaches only that row's accounts, round-robin; an account whose vendor says its limit is
  reached cools until its reset while the others answer (the global `disable-cooling: true` of
  §142 stays for key rows). A signed-in row is an upstream of kind `subscription`: no group in
  CLIProxyAPI's file, so signing in starts no new process. Its models are what CLIProxyAPI serves
  under `h<row>/` (`GET /v1/models`, its own catalogue for the vendor, with context windows). One
  account can belong to one row at a time: the same e-mail signed in under a second row moves to
  it.
- **The dialog** (`ProviderAccounts`): per account its status (`active`, `cooling`, `error`,
  `disabled`, `refreshing`, `unknown`), CLIProxyAPI's last error, `next_retry_at`, success and
  failure totals and the 20 ten-minute buckets (kept in CLIProxyAPI's memory: a restart starts
  them again), `last_refresh_at`, and `windows` — Claude's `anthropic-ratelimit-unified-<window>-
  utilization`/`-reset` and ChatGPT's `x-codex-<primary|secondary>-used-percent`/`-window-minutes`/
  `-reset-at` as CLIProxyAPI kept them from the last answer (`source: observed`), or what "check
  now" read (`source: checked`): ChatGPT `wham/usage`, Claude `api/oauth/usage`, xAI
  `v1/billing`, Kimi `coding/v1/usages`, Antigravity `retrieveUserQuotaSummary`, asked through
  `POST /requests/api-call` with `$TOKEN$`. Those addresses are undocumented; a reading that fails
  is `check_error`, still 200. `errors` are the row's failed calls, drained from CLIProxyAPI's
  usage queue (`usage-statistics-enabled: true`, kept 300 s there, the last 200 in the hub's
  memory). Everything is redacted of anything that looks like a token.
- **Hermes on the hub's models.** One choice per hub, in `<DATA_DIR>/gateway/hermes-models.json`
  (no migration). At the first boot with this code: `hub` for a hub with no provider and a
  gateway, `native` for every other — an upgrade never moves Hermes. With `hub`, each row the
  gateway serves is one more `providers:` block, `corehub-gw-<slug>`, at
  `http://127.0.0.1:<port>/gateway/row/<row>/anthropic` (`anthropic_messages`, Claude models:
  Hermes keeps prompt caching) or `…/openai/v1` (`responses` for OpenAI and ChatGPT,
  `chat_completions` otherwise), `key_env: COREHUB_GATEWAY_TOKEN`; the model stays the provider's
  own id; `model.provider`, the per-turn provider, cron's and the fallbacks name those blocks; the
  chain ends on Hermes's own route to a chat model from a key, so Hermes answers if the gateway is
  down. The token is `chgwh_<workspace>.<HMAC>` signed with `<DATA_DIR>/gateway/hermes-token.key`
  (0600): long-lived, in that profile's `.env` only, bound to the profile. The gateway listens on
  the port it had last time when it is free (`gateway.port`), so Hermes's files do not change
  with each restart; when Hermes uses the gateway it listens at boot and CLIProxyAPI starts at
  boot. A call on a Hermes token has no turn: the gateway counts nothing into the ledger (Hermes
  reports its own usage). Speech, embeddings, the ChatGPT images and the Codex app-server of a
  Hermes sign-in stay as they are; keys stay in Hermes's `.env`. `native` removes the hub's
  blocks and the token.
- **CLIProxyAPI at boot.** It renews tokens only while it runs, so a hub with any account in its
  store, or with Hermes on the gateway, starts it at boot and reads the accounts every minute.
- **Legacy.** Hermes's sign-ins keep working for the rows that have them. ChatGPT and xAI rows say
  so and offer "Move to Core Hub's gateway" (`models.moveProviderToGateway`: adds or reuses the
  gateway row of the same vendor and scope and starts its sign-in; tokens are never copied —
  OpenAI and Anthropic rotate refresh tokens, and two holders would sign each other out; once
  approved and its models are listed, the model defaults, fallbacks and ensemble members that
  named the old row's models name the new row's same models; the old row stays until removed).
  The web no longer offers those two Hermes presets where subscriptions are available
  (`replaced_by`). Nous Portal and MiniMax stay Hermes's (CLIProxyAPI cannot sign in to them).
- **Removal plan** (a later change, after the owner's live hubs have moved and on his word):
  `models/signed-in-chat.ts` and its tests (the `direct` agent then refuses a Hermes sign-in it
  cannot borrow with "move it to the gateway"), the Hermes half of `live-models.ts`, the `codex`
  protocol of the two image scripts (images through CLIProxyAPI's `/v1/images/*` for a gateway
  ChatGPT row, after a real test), and `sign-in.ts` down to Nous and MiniMax; the `openai-codex`
  and `xai-oauth` presets stay readable for old rows, never offered. Contract unchanged.
- **Proven.** With a stand-in of CLIProxyAPI's management API (`gateway/subscriptions.test.ts`,
  `hermes-gateway.test.ts`, web `subscription-signin.test.tsx`, Playwright
  `zzzzzzzzzzzzzzzz-subscriptions.spec.ts`), and with the real CLIProxyAPI 8.0.4 in the required
  `model-gateway-real` job (`gateway/subscriptions.real.test.ts`): xAI's device-code sign-in
  through the management API against stand-ins of xAI's discovery, device and token addresses
  (CLIProxyAPI has no setting for them; it honours `HTTPS_PROXY` and `SSL_CERT_FILE`, so the test
  answers their hosts itself behind a proxy with a throwaway authority), the account's prefix and
  note, its models in the hub's catalogue, "check now" with the account's token put in by
  CLIProxyAPI (never in the hub), renew (a refresh against the stand-in), off/on, sign out;
  ChatGPT's `-codex-device-login` child process end to end; Claude's authorisation link and a
  pasted address from another sign-in refused. The Claude code exchange itself is not driven:
  CLIProxyAPI uses its own TLS client for Anthropic, which takes no proxy.

Known limits: the request buckets and passive windows are CLIProxyAPI's memory (a restart, or a
change of key providers that starts a new process, begins them again); a change of key providers
while a sign-in is pending keeps the old process for that sign-in until it ends; phones show
accounts, status, usage and "check now" and sign in by code or pasted address, but the web alone
has turn off, renew, sign out and "move to the gateway".

## 144. Every agent reaches its model through the hub, with no switch

Status: decided by the owner, 2026-09-30 — «ابي كل الايجنتات تمر عن طريقنا مالها اتصال بنفسها …
كل شي يكون عن طريق الهب بدون زر» ("I want every agent to go through us, with no connection of
its own … everything through the hub, without a button"). It reverses the opt-in parts of §140,
§141, §142 and §143 named below; everything else in them stands.

- **Hermes.** The "Hermes uses Core Hub's models" choice of §143 is gone, with its operations
  (`models.getHermesModelSource` / `models.setHermesModelSource`, `/models/hermes-source`) and its
  schema `HermesModelSource`. They were added in this same unreleased change (the compatibility
  base, v1.1.5, never had them), so removing them breaks no released client; a preview build that
  called them gets 404 and hides the card. On every hub whose gateway is available the hub writes
  Hermes's `providers:` blocks at the gateway (§143's `corehub-gw-<slug>`, token, port) for every
  row the gateway serves, at every boot and every change; `<DATA_DIR>/gateway/hermes-models.json`,
  left by a preview build, is read by nobody. §143's escape hatch — Hermes's own route to the chat
  model at the end of its fallback chain — is removed: the chain goes through the gateway too.
  Speech, embeddings, the ChatGPT images of a Hermes sign-in and the rows the gateway cannot serve
  (a Nous Portal or MiniMax sign-in through Hermes) stay as they were. A hub whose operator
  switched the gateway off (`COREHUB_MODEL_GATEWAY=off`) or that has no CLIProxyAPI gives Hermes
  its own routes, as before the gateway: that is the operator's switch, not a person's.
- **A person's own Hermes, on a computer.** The hub never writes `~/.hermes`. Every Hermes turn
  the hub starts (web, phones, channels, workflows, schedules) runs in the hub's own Hermes home,
  `${DATA_DIR}/hermes` (ADR 0021 decision 3, `hermes-runtime.ts`: `HERMES_HOME` of the TUI gateway
  and of the gateway child the hub supervises, whatever the mode; only the install's dependency
  state is shared, by a link inside the hub's home, and §129's lock-directory isolation keeps the
  two gateways apart). The gateway blocks and the token are written there only. So messages sent
  through Core Hub go through the gateway, and messages the person sends from their own Hermes
  app keep their own configuration. Limit: where the hub attaches to a Hermes gateway somebody
  else runs (`external` mode), the jobs that gateway runs by itself follow its own files.
- **Coding agents.** No model source choice: the settings form no longer has the `models`
  section (`model_source`: Automatic / Core Hub's models / the agent's own account), an agent's
  own sign-in on the computer no longer counts, and `COREHUB_AGENT_MODEL_SOURCE` (§140, `hub` in
  the image) is still accepted and ignored. Every coding agent the gateway wires runs through it.
  When the hub has no model for it — none chosen and no default, a model of a provider the
  gateway cannot serve, an agent older than its wiring, a gateway that cannot start or a settings
  file the hub cannot write — the turn fails before any process starts, `provider_not_configured`,
  with words saying what to do (Settings → Models, the model picker, or Agents); it never runs on
  the agent's own account. §142's rewriting of the agent's "Authentication required" is gone with
  that path.
- **Compatibility.** `Agent.model_source` stays in the contract (`hub`, or absent where the hub
  does not wire the agent); `agent` is no longer sent, and clients that read it keep working. A
  `PATCH /agents/{id}/settings` with `section: models` and only `model_source`, from an app
  written before this, is answered 200 and changes nothing; any other key in that section is 404,
  as an unknown section always was. Stored `model_source` values are left in the settings rows
  and ignored. Phones had no control of their own (they render the server's form), so nothing
  changes there.
- **Proven.** `hermes-gateway.test.ts` (no switch; a preview build's `native` ignored; blocks and
  token written with no native route in the chain; operator off gives Hermes its own routes; a
  person's `~/.hermes` byte-for-byte unchanged), `hub-gateway.test.ts` (no `models` section, an old
  app's `model_source: agent` ignored, an agent signed in to its own account on the computer
  still started on the gateway with no key, the failure words for no model / unserved provider /
  old version / unwritable file), `runner-gateway.test.ts` (a gateway that cannot start or a turn
  with no model fails before any process starts).

## 145. Hermes is restarted by the hub after every change it needs; the runtime card names the model

Status: the owner's request on preview.38, 2026-09-30 — after adding or changing things he had to
press «Restart now» before "The runtime restarted after the last change" went green; the hub must
recycle Hermes by itself after any change that needs it, with no manual restart in the normal
flow.

- **Every path that changes what Hermes reads schedules the same coalesced restart** (`ModelsService
  .scheduleRestart`: debounced, waits while a turn is in flight, at most about two minutes):
  a provider added, edited or removed, the model defaults and fallbacks, speech, the image model,
  a subscription signed in through CLIProxyAPI (already), and — newly — a subscription's last
  account signed out from its dialog, a subscription row whose accounts came or went outside a
  sign-in (read every minute: an account CLIProxyAPI dropped, a backup restored without it; the
  row's gateway block comes or goes), and a change only a named profile's files see (its own
  messaging gateway reads them, and the restart recycles every one). The Hermes-through-gateway
  blocks, their token and port (§144) are written by the same propagation, so they follow it.
- **The runtime report says whether the restart is on its way.** `RuntimeCheck.detail` of a
  failing `gateway_reloaded` is `scheduled`, `waiting_for_run` (after the reply in progress), or
  null (none coming). No schema change: `detail` was always a free short fact. The web, iOS and
  Android say "Applying the change — Hermes restarts by itself…" and ask again every 2 s until it
  turns green; «Restart now» appears only when no restart is coming, as a way out.
- **`model_selected`'s detail is the chat model as people read it elsewhere**: «<provider label> ·
  <model name>» (was Hermes's `<block>/<model id>`, e.g. `corehub-gw-custom-cli-proxy-api/gemini-
  3.8-flash-high`). A client shows `detail` as it is, so older apps show the new words too.
- **Proven.** `gateway/hermes-restart.test.ts`: one test per path (provider added / turned off /
  default changed / removed; a named profile's files only; a subscription signed in, its last
  account signed out, an account gone outside the hub), each restarting Hermes once with no call
  to the restart operation and the check green after; and `scheduled` → `waiting_for_run` → green
  as a turn ends. Web `agent-restart.test.tsx`: no button while the restart is on its way, green
  by itself, the button only when none is coming.

## 146. One provider list in "Add a provider"; one dropdown shape everywhere

Status: the owner's choices on preview.38, 2026-09-30.

- **One list, two tabs.** "Add a provider" has two tabs: the list (**Preset**) and **Custom**
  (kept as it was, the owner's correction). The "Sign in with a subscription" tab is gone: the
  subscriptions the gateway signs in to are in the same list, under a "Subscriptions" heading,
  each with a «Subscription» tag and its own name ("ChatGPT (Plus / Pro / Business)", "Claude
  (Pro / Max)", "xAI Grok (SuperGrok / Premium+)", "Kimi Code (kimi.com)" …). Picking one shows its
  detail line (how its sign-in goes; "Shows usage and reset times" where it does), the neutral
  note, and «Continue to sign in», which starts the sign-in in the same dialog. The providers used
  with a key follow under "With an API key".
- **No duplicates, no dead ends.** A Hermes sign-in preset that the gateway also signs in to
  (`openai-codex`, `xai-oauth`) is not offered (`ProviderPreset.replaced_by`, §143); rows already
  added keep working. MiniMax (sign-in) and Nous Portal have no CLIProxyAPI sign-in: they stay in
  the list, tagged «Subscription», with the detail "Sign in with a short code, through Hermes · for
  Hermes and Core Hub's own agent". Serving them to coding agents through the gateway would need
  the hub to borrow Hermes's short-lived tokens into CLIProxyAPI per call (CLIProxyAPI takes a key
  only from its file, and a new file restarts it) and to translate Nous's Chat Completions for
  every agent's wire; that is not done here (the owner, 2026-10-01: Hermes-only in 1.1.6, a gateway design later). So under §144 a coding agent pointed at one of them
  fails, saying the gateway cannot serve that provider; Hermes uses them on its own route in the
  hub's Hermes home, and the hub's own agent borrows them per turn (§118).
- **The provider dropdown is our `Select`**, the one the composer's approval picker uses: a large
  panel, readable text, a check on the chosen row, a highlighted row, and per option the company's
  logo (a one-colour mark tinted in the brand accent), the name as the title with the tag beside
  it, and the detail line under it. `SelectOption.badge` is new (typeahead still finds an option
  by its name), and `Select.block` fills a form field's width. Radix's typeahead jumps to a name
  as it is typed; a filter field inside the list is not added (the list is about thirty rows).
  Logos: `@lobehub/icons-static-svg` 1.95.1 (MIT) and Simple Icons 16.33.0 (CC0) for Deepgram,
  generated into the client by `scripts/icons/vendor-logos.mjs`; a monogram for a company with
  none; THIRD-PARTY-NOTICES.md records both.
- **One trigger shape** (the owner, 2026-09-30, with no exception for the composer): every
  dropdown trigger — `Select` and the searchable picker's (`Combobox`) — is a rounded rectangle
  with the Runtime card's radius (`--ch-radius-md`) and its thin 1px border (`--ch-color-border`),
  a comfortable height (`--ch-control-height-lg`), normal text (`--ch-font-size-sm`) and the
  chevron at the far inline end (the left in Arabic). It replaces the filled pill, the top bar's
  profile switcher included. The composer's toolbar (under the message box, and on the new-chat
  screen) keeps a compact size — 2rem, small text — in the same shape as the secondary buttons
  ("Test", "Edit"): rounded rectangle, thin border, no pill. Done once in the shared styles, so it
  applies to every settings form, dialog, filter and the switcher.
- **Phones.** iOS and Android keep their own add-provider screens (a subscriptions section beside
  the presets) for now; the single list with logos there is a follow-up.
- **Proven.** Web `subscription-signin.test.tsx` (two tabs, the subscriptions tagged in the one
  list with their logo and detail, the sign-in from it, none on an older hub), `models-screen
  .test.tsx`; Playwright `zzzzzzzzzzzzzzzz-subscriptions.spec.ts` (the list photographed,
  `provider-list-ar-light.png`), `zz-design.spec.ts` (screenshots of the chat, models, settings
  with the new triggers), `zzzzzzzzzzz-design-family.spec.ts`, and the pseudo-locale width pass
  (`zzzzzzzzzzzzzzzzz-pseudo-locales.spec.ts`, en-XA, ar-XB, zh-XC, th-XD, desktop and phone).

## 147. "Check now" reads usage as CLIProxyAPI's console does, and says why in words; a restart on its way stays on its way

Status: fixes from the owner's first real sign-in, 2026-10-01 (v1.1.6, preview.39).

- **The requests are CPAMC's.** "Check now" asks, in order, the requests CLIProxyAPI's own
  management console (CPAMC, "Quota Management", MIT) makes for the same accounts — verified
  against its source (main at `a7ec312f`) and CLIProxyAPI 8.0.4's, not guessed:
  - **Google Antigravity**: `v1internal:retrieveUserQuotaSummary` on the daily, sandbox and
    production hosts (`daily-cloudcode-pa`, `daily-cloudcode-pa.sandbox`, `cloudcode-pa`), with the
    account's Google Cloud project in the body (`{"project": …}`, CLIProxyAPI's `project_id` for
    the account; `{}` when it has none) and Antigravity's client name
    (`antigravity/cli/1.0.13 (aidev_client; …)`); then `v1internal:fetchAvailableModels` on the daily
    and production hosts, whose `models.<id>.quotaInfo` (`remainingFraction`, `resetTime`) is what
    CPAMC read before the summary existed and what CLIProxyAPI's own model list asks for every
    consumer account. The hub asked only the production host, with `{}` and no client name; that
    is what Google answered 403 "no valid license". The summary's buckets become windows
    ("Gemini · 5-hour"); the model list becomes one window per model with its own name, what is
    left and when it resets (a model that says only its reset time has none left).
  - **ChatGPT** `wham/usage` with Codex's client name and the account id: the plan's windows and,
    new, the code-review windows; a spent window with no percentage is 100%.
  - **Claude** `api/oauth/usage`: every window, Anthropic's code name for the weekly Fable limit
    (`iguana_necktie`) read as "Weekly (Fable)".
  - **xAI**: the weekly credits (`v1/billing?format=credits`) first, then the monthly bill, with the
    Grok CLI's headers.
  - **Kimi** `coding/v1/usages`: time units as Kimi sends them (`TIME_UNIT_MINUTE`), a reset as an
    instant or seconds from now, a limit's own name.
  The first answer that carries usage wins.
- **No vendor's raw answer in the dialog.** When nothing can be read, `ProviderAccount.check_error`
  is one sentence in the person's language: "Google doesn't share usage for this account type."
  (403/404, ranked first as CPAMC does), a refused sign-in (401), a rate limit (429), a vendor
  error with its status, the vendor unreachable, or an answer without usage. The vendor's own
  words go to the hub's log only, redacted (Google's `ya29.` tokens are now redacted too). No
  contract change: `check_error` was always a sentence for the client to show.
- **A restart on its way stays on its way.** §145's state ended when the hub asked Hermes to
  restart, not when Hermes had started again; for those seconds the report said "did not restart"
  with the button, and the page stopped asking, so it stayed red although Hermes restarted (the
  owner, 2026-10-01). A restart the hub asked for now reports `scheduled` until the new process
  has started (up to three minutes, then the button as the way out); a runtime that is not the
  hub's to restart reports nothing coming. The wait itself: a 1.5-second debounce, then — only
  while a **Hermes** turn is in flight, no longer any agent's (a coding agent's turn is not touched
  by the restart) — up to two minutes (80 × 1.5 s) before the change wins, said as "once the reply
  in progress ends"; then the seconds Hermes takes to start. Every path that changes the model
  defaults already propagates and schedules the restart (audited: `setDefaults`,
  `ensureChatDefault`, `moveUses`); none was missing.
- **Proven.** `gateway/subscription-usage.test.ts` with recorded answer shapes (Google's 403,
  `fetchAvailableModels`, the quota summary, `wham/usage`, `oauth/usage`, xAI's credits and bill,
  Kimi's usages; the sentences in English and Arabic; Google's words and token absent from the
  dialog and the token absent from the log); `gateway/hermes-restart.test.ts` (on its way while
  Hermes starts again; nothing coming for a runtime that is not the hub's);
  `update-policy.test.ts` (`busyWith`).

## 148. A provider's refusal said for what it is: no capacity and a passing limit are not a spent quota; the chat hears what the gateway is doing

The owner's Google Antigravity sign-in, 2026-10-01: Claude Code on a working account was told
"ran out of quota" for two models and answered by `openrouter/free` after 88 s of "Thinking", while
Hermes on the same account answered. Proposed here — owner to confirm:

- **Google's reason is read, not guessed.** Google says `RESOURCE_EXHAUSTED` for a spent quota, for no
  capacity and for a per-minute limit alike, and CLIProxyAPI 8.0.4 keeps only the message when it
  answers the Anthropic, Responses and Gemini routes (checked in its source: the Claude handler builds
  `{type, message}`; the OpenAI Chat handler returns the provider's JSON as it came). On such a refusal
  the gateway asks the same model once per turn on CLIProxyAPI's Chat route (`max_tokens: 1`) and
  classifies from that whole answer; if the model answers there, the limit has passed and the call is
  asked again at once.
- **Three reasons.** `quota_exhausted` — a 402, `insufficient_quota`, billing, payment, credit, a
  usage limit, a daily/monthly quota, Antigravity's `QUOTA_EXHAUSTED` or "exhausted your capacity …
  quota will reset": answered at once. `no_capacity` — `MODEL_CAPACITY_EXHAUSTED`, "No capacity
  available for model … on the server", an overloaded model (429, 503, 529): waited once (the
  provider's delay, else 5 s). `rate_limited` — any other quota word (a per-minute limit, Google's bare
  "Resource has been exhausted (e.g. check quota)", `RATE_LIMIT_EXCEEDED`, CLIProxyAPI cooling down):
  waited once (the provider's delay, else 20 s; at most 30 s). A second refusal ends that model's part
  in the turn with its own reason; the chain moves on (§54, §142), else the run fails.
- **Said plainly.** `Run.error` (`rate_limited`) carries `details.reason` — `quota_exhausted`,
  `no_capacity` or `rate_limited` — and `details.said`, the provider's own words with Google's reason
  codes, quota names and retry delay, redacted; the sentence is the reason's ("has no capacity for …
  right now", "is limiting requests to … right now", "ran out of quota for …"). The fallback line's
  "why" is the same sentence and the provider's words.
- **`run.status`** (`/rt/sessions`, new and additive; an older client ignores it): while the gateway
  waits (`phase: waiting`, `seconds`, `reason`) or tries the chain's next model (`phase: trying`), with
  the provider's and model's names. Never stored. The web shows it in the live indicator and counts a
  wait down; it clears with the model's first words or the run's end.
- **The downloads-folder note is context, not a task.** A run's note of where files for the person go
  was an order ("Write any file the user should be able to download into: …"), and a model answering
  «هلا» wrote a file. It is now marked as Core Hub's (`<corehub-context>`), conditional ("Only if the
  user asks for a file they can download …"), and says to create none otherwise. It stays in the turn:
  the folder is the run's own, so no system prompt set when the agent started can carry it.
- Checked and left as they are: CLIProxyAPI retries nothing itself (`request-retry: 0`,
  `max-retry-interval: 0`, cooling off); a plain Claude Code turn makes one call, so parallel calls do
  not explain the refusals.

## 149. No phone push for a reply the person is watching

Status: the owner's request, 2026-10-01 — «اي رد يوصلني تنبيه على جوالي… اني انا فاتح الصفحة
المفروض ما يرسلي تنبيه» ("every reply sends me a phone notification… when I have the page open it
should not"). Each push also costs a request on the push relay.

- **Clients say what they are looking at.** A new command on `/rt/sessions`, `viewing
  { session_id }` (or `null`), sent while a conversation is open and its page or app is in front —
  the web: the tab visible (`document.visibilityState`) and focused; iOS: the chat on screen with
  the scene `active`; Android: the chat on screen with the activity resumed — repeated every 20 s,
  and `null` the moment that stops (hidden, blurred, another screen). The hub keeps it per socket
  in memory for 45 s unless repeated, and drops it when the socket closes. Additive: no HTTP
  operation, no event schema (commands are documented in `events/README.md`); an older hub never
  acks it and pushes as before; an older app never says it and is pushed to as before.
- **The hub skips only the push.** For `run_completed`, `run_failed` and `approval_requested` on a
  session any of the person's clients is viewing, the notice is still written and announced in the
  app (unread count and inbox unchanged); only the push to phones and browsers is skipped. Another
  session's events, a workflow's approval, and everything when no client is viewing, push as
  before. After a hub restart nobody is viewing until the clients say it again, which errs toward a
  push.
- **Proven.** `tests/unit/push-viewing.test.ts` (a real socket: viewing suppresses the push but
  not the notice; another session, `null`, a closed socket and an older client push; 45 s expiry;
  two screens), web `tests/viewing.test.tsx` (visible and focused says it and repeats it; blur,
  hidden, another conversation, unmount say `null`; a reconnect says it again). iOS and Android
  send it from their chat screens (Android compiled locally; iOS built by CI).
- **Second live test (preview.41).** Three more causes, found with the real CLIProxyAPI, a
  Google Antigravity account file pointed at a stand-in for Google, and the real Claude Code:
  - **Claude Code's token counts**: Claude Code asks `count_tokens` about fifteen times as a turn
    starts (counted at the gateway); CLIProxyAPI turns each into Antigravity's `countTokens`, Google
    refuses them with RESOURCE_EXHAUSTED, and the refusal cost the turn its model — which is why
    Claude Code failed where Hermes and Gemini CLI on the same account and model answered. The
    gateway now answers `/v1/messages/count_tokens` itself with an estimate (about four bytes of
    system, messages and tools a token); none reaches a provider.
  - **The account cooled itself down**: the sign-in set the account's own `disable_cooling: false`
    (§143), which outranks the config's `disable-cooling: true`, so after one 429 CLIProxyAPI
    refused every later call without asking Google ("All credentials … are cooling down"). Accounts
    are now set `disable_cooling: true` at sign-in, and existing ones once per process.
  - **No vendor's raw answer in the chat**: the fallback line's "why" and the failure notice say
    only the hub's sentence; the provider's words (a message inside another answer read out of its
    JSON) stay in `Run.error.details.said` and the hub's log.

## 150. Phones: swipe a message to reply, and a long press on the agent's reply opens its menu

Status: the owner's requests, 2026-10-01 — «اذا المستخدم سحب المحادثة يسار يخليني كاني برد عليها
نفس التيليقرام», and a long press on the agent's message should open the same menu as on his own.

- **Swipe to reply (iOS and Android).** A horizontal drag on a message bubble — the person's or the
  agent's — moves it toward the reading start, with the reply arrow appearing behind it: left in a
  left-to-right interface (Telegram), right in Arabic. That is away from the system back gesture
  (iOS's interactive pop starts at the leading edge and moves toward the trailing side; Android's
  gesture navigation answers at the screen edges, where the system's own gesture wins), so the two
  do not compete. Past 60 pt/dp a light haptic; letting go there replies. Beyond it the bubble
  moves at a third of the finger's speed, up to 96. The axis is decided once, at the drag's first
  move past the touch slop: only a mostly horizontal start (|dx| > 1.5 |dy|) toward the reading
  start is a swipe; anything else is left to the list's scroll. Never on a reply still streaming or
  the empty shell a run opens with. Reduce Motion: the bubble returns without animating.
  VoiceOver and TalkBack get a «Reply» action on the bubble.
- **One reply path.** The swipe calls the same reply as the message menu's «Reply to this»: the
  quoted strip with its «×» over the composer, and the message sent with `RunCreate.reply_to_message_id`
  — what the web sends, so every agent and runtime gets the same quote. Choosing a reply, by swipe
  or menu, now also puts the cursor in the composer and brings the keyboard up.
- **Long press on the agent's reply** opens the same menu as on the person's message — Copy, Read
  aloud, Reply, Fork from here — the «…» under the reply staying as it is. iOS shows the reply's
  opening twelve lines as the menu's preview, not the whole card; Android's menu has no preview,
  as for the person's message. Not on a streaming reply.
- **Proven.** Android `SwipeToReplyUiTest` (Compose, Robolectric): a left swipe replies in
  English, a right one in Arabic, the other direction, a vertical drag and a short swipe do not,
  the «Reply» accessibility action, a disabled row, the rules, and a long press on the agent's
  reply opening the menu whose Reply answers it. iOS `SwipeToReplyTests` (XCTest): the same rules
  and the action's name in both languages; SwiftUI's gesture itself is checked on a device.
- **Changing Claude Code's request (the owner, 2026-10-01: «ما ابي نخرب كلود علشان جيميناي»).** Any
  adjustment of what an agent asks — thinking level, tools, `max_tokens` — is scoped to exactly the
  case a log proves fails: keyed on a Google model (Gemini, Gemma; Google's API, Antigravity, Vertex
  or a proxy) and on that cause; the smallest change that works (a lower thinking level Google
  accepts before "off"); a no-op for every Claude model, Claude models through Antigravity included,
  whose request reaches the provider byte for byte as Claude Code sent it; tests prove both. A
  candidate — asking a refused Gemini model once more without the agent's thinking settings, for the
  rest of the session, when the same model answers a plain request — is on
  `fix/gateway-gemini-claude-code`, waiting for the owner's log to show the refusal is about thinking.
