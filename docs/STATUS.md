# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**209 of 267 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id. Measured on this
branch, 2026-09-25, by asking a booted hub which operations are still the
built-in stub — and `packages/server/tests/unit/status.test.ts` keeps this
number from claiming more than the hub answers.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 34 | 34 | first-run setup, sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles — and since 2026-09-23 **a workspace is a Hermes profile** (ADR 0014): created in Hermes from scratch or as a copy, and Hermes's own profiles listed as workspaces. Since 2026-09-24 **a member enters only the profiles explicitly granted** — an empty list means none, a new profile is nobody's until granted (contract decision §29, migration `0010`). Since 2026-09-24 **a profile moves as Hermes's own archive** (stage 2): `exportProfile` is a job in which Hermes's own server (`hermes serve`, ADR 0015) writes the `.tar.gz`, the hub copies it leaving every `.env` and `auth.json` out and overwriting every provider key it stores wherever its bytes appear, and keeps it as a download for its requester alone for 24 hours; `importProfile` checks an uploaded archive (one top-level folder, no links, no paths outside it), has Hermes make the profile under the slug asked for, and adds the profile — a taken slug is refused before any job, Hermes's refusal comes back in its words (contract decision §34). Only where the hub supervises Hermes; elsewhere both answer `409 hermes_not_supervised`. Since 2026-09-24 **a conversation runs in its profile's own Hermes profile** (stage 3): every Hermes run — a chat turn, a resume, a fork, a task run, a workflow step, a title, and the questions and approvals inside them — opens its session in that profile's Hermes profile (its config, `.env`, SOUL, memory, skills, sessions) on the one TUI gateway, in the session's own folder under `/data/workspaces/<profile>/`; a workspace older than its Hermes profile gets one on its first run, as a copy of `default`; the hub's provider endpoints are declared in every profile and its keys reach every profile through the gateway's environment. With the agent pages acting on the selected profile's home (the `agents` row), stage 3 is done; a Hermes reached only over the network (no `hermes` beside the hub, so no TUI gateway) still runs everything in its own default profile. Since 2026-09-25 **every profile, the default one included, can be renamed to any name** (contract decision §44): `updateProfile` writes the name to Hermes first as the profile's display name — `hermes profile rename default <name>` for the default one, `display_name` in `profile.yaml` for a named one — so `hermes profile list` / `show` say the same name; the id never moves where the hub mirrors Hermes (a new slug is refused `409 profile_id_fixed`, the folder is not renamed), a new or imported profile's name is written the same way, names are 1–64 characters (Hermes's limit), and an export's file is named after the name; proven against the real Hermes |
| sessions | 28 | 32 | sessions, messages, streamed runs, approvals, resume, fork, and the eight attachment operations (implemented by `knowledge`, which owns the bytes); only session categories are not built. Since 2026-09-25 **the global agent** (`openGlobalAgent`, contract decision §46, proposed — owner to confirm): one standing conversation per person per profile (`source: global_agent`), made on first open with the agent given, never archived (`409 state_invalid`), a fork of it an ordinary chat. Since 2026-09-25 **a conversation reads as its trajectory** (`getTrajectory`, contract decision §43): every input, model turn, reasoning and tool call with its times, and only the metrics the hub has — the model's turns are recorded on each run from then on (migration `0015`), so older runs list their steps without times; `download=true` is the session log. Hermes's TUI usage is now recorded per turn (Hermes reports its live session's running total), and the OpenAI-compatible and Google adapters no longer count cached prompt tokens as input too. Since 2026-09-24 the list and search cross every profile the caller may enter (`profiles=all`, and `profiles: 'all'` on the socket — ADR 0016). Since 2026-09-24 **archiving a conversation stops its work**: `archived: true` (one or many) cancels every live run the way the chat's Stop does, so a task on that run goes back to `ready`; and a `before` cursor that is not a message of the conversation answers `404` instead of the newest page again (contract decision §31) |
| models | 26 | 26 | providers, keys, catalogue, defaults, verification on save, speech (ADR 0010). Since 2026-09-24 **two provider scopes** (contract decision §37): a provider is every profile's (shared, stored under the default profile) or one profile's own, whose key goes into that profile's Hermes `.env` and wins there over a shared one of the same slug; a new profile has every shared provider at once, a copy of a profile takes its source's own providers with their keys, and an export «مع المزوّدين» carries the providers a profile uses (keys in the clear) which an import makes the new profile's own. Model choices stay per profile and fall back on the default profile's (`ModelDefaults.inherited`). Hermes's root home is the default profile's whoever saved, and each named Hermes profile's `.env` holds exactly the keys that differ from the root's — proven against the real Hermes. Every provider older than migration `0012` is its profile's own |
| agents | 44 | 53 | Since 2026-09-25 **the hub offers itself to its agents as MCP tools** (contract decision §67, proposed — owner to confirm): `agents.getHubTools` / `agents.updateHubTools` switch, per profile and off by default, six groups — tasks (list, create, move, assign, comment), schedules (list, create, pause, run now), conversations (list, search, summary), notifications (notify the person), workflows (list, run), files (list, read, write in the profile's folder) — each reading once on and writing only when its own switch allows; on, the hub writes one `corehub` block into the profile's Hermes `config.yaml` (bearer from `${COREHUB_MCP_TOKEN}` in the profile's `.env`), puts it back at boot, and the generic MCP routes refuse to touch it; `agents.hubMcp` (`POST /api/v1/hub-mcp`) is the Streamable HTTP endpoint. A call acts only while a run of the hub's is live in that profile, as that run's owner, through the REST routes with a run token that enters that profile only and is never an admin; several people running at once are told apart by the agent's own announcement of the call, or the call is refused. A coding agent over ACP gets the same server in `session/new` when it can reach HTTP MCP servers. Proven against the real Hermes (v2026.9.14 in the image): Hermes connects, lists the tools (behind its `tool_search` bridge) and a chat turn with a scripted model calls `tasks.create` through `tool_call` — the task is on the board as the person's; Hermes's own MCP test lists them. Not built: `browser`, `devices` and `usage` groups; messages arriving on a channel cannot use the tools (no person owns that run). Before that: registry, curated catalog (Hermes, the hub's own `direct` agent, four coding CLIs), install/remove/upgrade, discovery, restart, per-agent settings — and since 2026-09-23 the three Hermes tool pages that are **files in the agent's own home**: skills (`skills/<slug>/SKILL.md`, written verbatim so a pack's front matter survives), MCP servers (one block of `config.yaml`, edited in place with the comments kept) memory (`SOUL.md` at the profile home; since 2026-09-24 `memories/MEMORY.md` and `memories/USER.md`, where Hermes itself reads and writes them — earlier the page wrote them at the profile root, where Hermes never looks; those files are moved into `memories/` once at boot and on the next memory read, nothing dropped. The two lists are written the way Hermes round-trips them (entries separated by a `§` line) and a write that would grow one past the profile's character budget is refused with `memory_too_long`; proven against the real Hermes both ways) and channels (`platforms:`, whose fields are read from the file rather than from a form the hub wrote). Since 2026-09-24 **plugins** are Hermes's own, per profile: `listPlugins`, `updatePlugin`, `installPlugin` (a `plugin_install` job; Hermes fetches, scans and installs it switched off) and `deletePlugin` run Hermes's `hermes plugins` command against the selected profile's home, with Hermes's own status words (`enabled`, `disabled`, `not enabled`) — Hermes's dashboard plugin routes take no profile, so they could only ever reach the default one; what Hermes ships is switched, never removed; only where the hub supervises Hermes. The agent's **Jobs** page is the agent's schedules in the selected profile (for Hermes, the jobs in Hermes's own scheduler), read from `schedules.list` and acted on with the schedules operations — no operation of its own. **Skills in category folders** (`skills/<category>/<name>/SKILL.md`, where Hermes keeps its built-in skills) are listed under their category with its `DESCRIPTION.md`; the ones Hermes seeded from its bundle (`.bundled_manifest`) are `builtin` and read-only (`409 skill_bundled`); proven against the real Hermes. Presets and the journey are not built. Since 2026-09-24 the four pages act on **the selected profile's** Hermes home (`profiles/<slug>`, the root for the default one; a profile Hermes does not have says so), and the three live tools work: `testMcpServer` has **Hermes** connect to the server and list its tools (Hermes's own `/api/mcp/servers/{name}/test`, ADR 0015), `loginChannel` pairs **WhatsApp by QR** through Hermes's onboarding as a `channel_login` job whose progress carries the code, and `importSkills` installs an uploaded `SKILL.md` or zip into the profile's `skills/`, byte for byte, checked by Hermes's reading rules, all or nothing. The first two need a Hermes the hub supervises; Telegram's bot-creation flow is not a QR pairing and is not built | Since 2026-09-24 **every Hermes profile with a messaging channel has its own gateway**: the hub supervised one `hermes gateway run`, which serves the default profile only, so a WhatsApp paired in another profile was never answered (the owner's report «سويت رستارت وراسلته ولا رد»). Now each named profile with a channel switched on and able to sign in, or with an active scheduled job of Hermes's own (Hermes fires a profile's jobs only in a gateway of that profile; checked every half minute, and after every Hermes schedule the hub writes), gets `hermes -p <profile> gateway run` (only the default gateway dispatches Hermes's one kanban board) (restarted with backoff, logged with the profile's name, without the API server, its WhatsApp bridge on a port of its own), started, restarted or stopped when a channel there is linked, switched, edited, cleared or unlinked, and on boot; a profile with neither gets none (about 200 MB each). Hermes's Restart restarts all of them and its card lists each one's state. Before any gateway starts — the default one too — the profile's `config.yaml` is given the hub's endpoints and the model its chat default resolves to, so a gateway no longer answers «Provider authentication failed» (`Unknown provider 'corehub-…'`). A WhatsApp Hermes paired reads as **linked** with its account (from the session folder, not config fields) and can be **unlinked** (`unlinkChannel`: the gateway held down, the session deleted, the channel switched off). **Pairing approvals**: `listPairing`, `approvePairing`, `denyPairing`, `revokePairing` — Hermes's own pairing API in the selected profile, except Deny, which removes the one request from Hermes's pending file because Hermes has no verb for it (contract decision §38). In the default profile a channel change still waits for Hermes's Restart. Since 2026-09-24 **Telegram links from the web** in the selected profile (`linkChannel`): the person makes a bot with @BotFather (Hermes's outside bot-creation service is not used), the hub checks the token with Telegram's `getMe`, stores it in that profile's own Hermes `.env` (never returned) and switches the channel on with pairing for strangers; a named profile's gateway starts at once, the default one's at Hermes's Restart; `unlinkChannel` covers Telegram. **Telegram settings** (`getChannelSettings`, `updateChannelSettings`): every user-facing option Hermes has for it — who may message, show the model's thinking, tool progress, streaming, quoting, reactions, groups and mentions, voice notes (marked as shared with every channel of the profile), home chat, command menu, proxy — read and written where Hermes reads each one (the profile's `config.yaml`, or its `.env`)
| updates | 7 | 7 | release channels, publishing from an upload or a source URL the hub fetches itself, check, download with `Range`, settings whose token never comes back |
| jobs | 3 | 3 | list, get, cancel, with `/rt/jobs` events |
| meta | 2 | 2 | health, and `meta.get` — the hub's name, its build, the contract version it loaded, the realtime namespaces it actually opened, and whether it still needs an owner. Unauthenticated, because a client compares the contract version before it signs in |
| knowledge | 1 | 1 | `knowledge.listItems` — journal, notes and files in one page; the attachment operations it also implements are counted under `sessions`, whose tag declares them. Since 2026-09-24 the same file can be uploaded again after a delete or under another name (it answered `500`): each upload is its own attachment over bytes stored once, removed with the last one (contract decision §39) |
| audit | 1 | 1 | the Logs, Usage and Performance reports; `skills` still answers `501`, because nothing records skill use and zeros would read as a measurement |
| plugins | 1 | 1 | what is installed on this hub — an empty list until an installer exists |
| tasks | 27 | 27 | projects, the nine-column board with fractional ordering, subtasks, dependencies, comments, activity, worktree rows — and since 2026-09-23 **Hermes's own kanban on the same board**: read through `hermes kanban list` when the board opens, Hermes wins on every read, a move on a Hermes card is asked of Hermes first and a refusal comes back in Hermes's words, and a task given to Hermes goes on Hermes's board. And since 2026-09-24 **assigning starts the work**: `assignTask` with `start: true` opens a session of source `task` for the assignee (in the workspace's ordinary per-session folder), queues one run whose prompt is the task — title, brief, checklist as it stands, the instructions given — moves the task to `running` and answers `202` with the real job, run and session ids; when the run ends the task moves on its own (`review` with the agent's last words as the progress summary, `blocked` with the reason it failed, `ready` when stopped from the chat). Stop, unassign, reassign and a person's move out of `running` cancel the run for real; `dispatch` starts what it assigns; a restart settles the tasks it finds left `running`. Without `start` a task is only assigned and `TaskAssigned` answers `null` ids. A task given to Hermes is handed to Hermes's own board and never run by the hub. And since 2026-09-24 **Hermes's cards are fully editable from the board** when the hub manages Hermes: their title, description and priority, deleting them, comments (said on Hermes's card in the person's name; Hermes's own comments shown on the card), stopping their run and handing them to another workspace's Hermes profile all go through Hermes's own API (`hermes serve`, ADR 0015) — Hermes first, the reflection refreshed from Hermes's answer, a refusal in Hermes's words; opening the board starts that server in the background. Where the hub does not run Hermes (an external one), those writes are still refused as before. **Not built yet:** a git worktree per task (the row is still recorded in `creating` and nothing makes one), reporting into a project's room (`rooms` is 501), and `auto_start` And since 2026-09-24 (ADR 0016 stage 2, DECISIONS §32) `listTasks` takes `profiles=all` (one keyset over every profile the caller may enter), the board answers `profiles=all` too, a card's `assignee.name` is the registry's (it used to be the id), `dispatch` and the two worktree operations answer the contract's `JobAccepted` (`{job_id}`), and Hermes's board is read whenever anyone opens the board, not only someone who may enter the default profile |
| schedules | 23 | 23 | schedules with a real `next_run_at` (cron, interval, once, in the schedule's own timezone), run history, workflow definitions with validation, workflow-run history and cancel, and workflow import preview/confirm — and since 2026-09-23 **Hermes's own cron on the same page**: a schedule for the Hermes agent is created, edited, paused, deleted and fired *in Hermes's scheduler* through its `/api/jobs`, so it really runs; jobs Hermes made itself appear too, Hermes wins on every read, and the runs Hermes reports land in the history. And since 2026-09-23 **workflows run**: `runWorkflow` and `rerunWorkflowFromNode` walk the drawing step by step — `condition`, `delay` and `notify` done by the engine, `agent` as a real turn in a session of its own (source `workflow`), each step's output readable by the next as `{{steps.<id>.output}}`; cancel stops a run at once, a restart fails the runs it cut short, and conditions and templates are checked when the workflow is saved. And since 2026-09-24 **the hub fires its own schedules** — every schedule whose agent is not Hermes (the `direct` agent, a coding agent) and every workflow schedule: a scheduler claims each due tick with a compare-and-set on `next_run_at` plus a history line unique per tick, so a moment fires once across restarts and concurrent looks; the run is a session of source `schedule` in the schedule's profile, as its owner, with its prompt (or the workflow, with the schedule in `{{trigger}}`); the history line carries the session (or the workflow run) so the page opens it, and settles with the run — last status, last error, the repeat count and limit. The next time is computed from the moment of firing, in the schedule's own timezone; a paused schedule is never due. Since 2026-09-24 **each schedule has two run options** (the owner's decision; DECISIONS §40): *run if missed* (`run_if_missed`, off by default) — a tick up to two minutes late is on time and runs; later, it runs once if the option is on and the hub is back within 24 hours, and is otherwise recorded as skipped with the reason — and *if the previous run is still going* (`overlap`): `skip` (recorded), `wait` (the default: runs as soon as the previous run ends, at most one waiting, a further one recorded as skipped), `parallel` (a run of its own alongside) or `replace` (the previous run is cancelled for real, then the new one starts). "Run now" always starts at once and stops nothing. A time still waiting when a restart ends the run it waited for follows *run if missed*. Existing schedules got the defaults (off, `wait`) by migration `0014`. Hermes's own schedules have neither — Hermes decides both per profile, not per job — and a write that sets one is refused (`409 hermes_run_options`). `runNow` starts that same run at once and answers the real ids (`session_id`, `run_id` or `workflow_run_id`; DECISIONS §35); a target that cannot start is a failed line and `409 target_unavailable`. **Workflow `approval` steps are built**: the run pauses (`waiting`), an ordinary approval of kind `workflow_step` is raised — listed by `/approvals`, announced profile-wide, in the owner's inbox — approve continues from that step, deny fails it with the reason given, a cancel closes it, and a run waiting at one survives a restart (its place is written down). Any step with `approval_required` waits the same way before it works. Since 2026-09-24 `schedules.list` pages for real (the `cursor`/`limit` it always declared, one keyset over every profile) and takes `profiles=all`; Hermes's cron is read whenever anyone opens the page |
| rooms | 0 | 28 | several agents in one room |
| devices | 0 | 17 | device registry and push |
| notify | 12 | 12 | the inbox — and since 2026-09-22 something actually writes to it: a run that finishes and an approval that is raised, in the recipient's own language, announced on `/rt/devices`. Per-kind preferences decide whether a notice is written at all, quiet hours are stored as given, and webhooks check their URL against private addresses before anything is sent, with an HMAC signature and a delivery record; since 2026-09-24 a webhook's recent deliveries are readable (`listWebhookDeliveries`). **The only delivery a webhook receives today is the test one**: nothing forwards the hub's events to a webhook yet, so the events it subscribes to are stored and not sent |

**Phase 4 of the roadmap is complete**: `knowledge`, `plugins`, the `updates`
channel and the `audit` dashboards all answer. Of Phase 1, `tasks` is complete
as a board, `schedules` entirely (since 2026-09-24 the hub fires its own), and `notify` entirely;
`rooms` is still 501, as is the Hermes-gateway half of `agents`. Phase 3 (phones and desktop) is last, by the
owner's decision on 2026-09-22.

**What answers is not always what works end to end.** Two places say so
themselves rather than in a footnote: a task worktree is recorded in `creating`,
because making a git worktree is not built — a started task works in its
session's ordinary folder under `/data/workspaces/<profile>/` instead; and a
schedule whose target cannot start (an agent that is not installed, a workflow that
is gone) is recorded as a failed run that says why, never as a run that happened.
**Nothing in this hub starts a run except a person typing in the chat, a workflow
someone ran, a task someone assigned and started (or dispatched), a schedule whose
time came or that someone ran now (since 2026-09-25 an agent in someone's live run may do
the last three through the hub's own tools, as that person, where an admin allowed it) — the hub's own scheduler for every schedule but
Hermes's — and Hermes's own scheduler and kanban for the schedules and cards that
live in them.** A workflow step that waits for a person waits until someone answers
its approval.

## Clients
- **Web** (`packages/web`): first-run setup, login, chat with streaming,
  approvals and resume — and since 2026-09-24 scrolling back through a long
  conversation page by page, keeping the reader's place; since 2026-09-25 a
  «المسار» / "Trajectory" tab beside «المحادثة» / "Chat": a timeline of the
  inputs, model turns and tools on one axis (time flows in the reading
  direction, idle stretches folded), a step list with Duration / Turns / Calls
  filters and search, each tool step opening to its arguments and result, the
  metrics the hub has, and the session log download; it follows a run live —
  sessions list, agents (since 2026-09-25 a «أدوات كور هب» / "Core Hub tools" card on an agent's MCP
  page: the groups with what each does, a switch for the whole, one per group and one for each group's
  changes, the last calls in the hub's words, and Test through Hermes), models, the Tasks board,
  schedules (since 2026-09-24 "Run now" for every schedule, each schedule's history
  opening the conversation or the workflow run it started, and a workflow run's view
  where a step waiting for approval is approved or denied with a reason — the inbox
  opens it there; and each hub schedule's two run options, "run if missed" and "if the
  previous run is still going", set on the new-schedule form and changed from the card's
  "Run options", not shown for Hermes's schedules; a time waiting for the previous run
  says so in the history), notifications, people, workspaces (with export to a download and import
  from a file, since 2026-09-24; since 2026-09-25 Rename on every profile says the id stays, and
  the new name is what the top profile chip, the list badges, Hermes's gateways on the Agents page
  and a Telegram bot "already linked in" message show), knowledge, plugins, updates, about, settings, pairing. Screens whose module is still 501 say so explicitly
  instead of showing an empty page.
  The destinations still showing that placeholder all wait on a **module**:
  `rooms`, and the parts of `agents` its row above lists as not built.
  Since 2026-09-25 **Global agent** is no longer a placeholder: its page (no menu entry) opens
  the person's global-agent conversation in the profile — search hits and the pending-actions
  bar lead there, the chats list leaves it out — and a **pending-actions bar** sits in the top
  bar of every screen: the count of approvals, agents' questions and workflow steps waiting in
  every profile the person may enter (and, for an admin, senders waiting to pair with a channel
  in the profile they are in), opening a sheet where each is answered or opened where it lives. Since
  2026-09-24 none waits only on a screen: **Webhooks** lists, adds, edits, enables, deletes and test-sends
  (the test really arrives, signed, and its delivery is listed with the
  endpoint's status), and **Privacy** lists the app tokens and paired devices
  that can act as you and revokes them. Privacy's `redact_pii` switch is not
  shown, because nothing in the hub applies it yet.
  Since 2026-09-24 the agent's **Channels** page shows a linked WhatsApp with its account and
  Unlink (behind a confirm), says how to use it (message the number from another account,
  approve the first request here) with a warning about linking a personal number, and lists
  «طلبات بانتظار الموافقة» / "Waiting for approval" — approve or deny each sender — and the
  approved senders with Revoke, read again every ten seconds. Hermes's card lists its
  messaging gateways and their state.
  Since 2026-09-24 (ADR 0016 stage 2) the **Tasks board and Schedules** show
  every profile the person may enter with no profile filter, each card and
  schedule with its profile's badge; a new task or schedule is made in the top
  selector's profile (the screen names it), anything done to an existing one
  goes to its own profile, and a task's conversation opens there
  (`?profile=`) without moving the selector. Both pages hear every profile in
  realtime.
- **Terminal** (`packages/cli`): the reference client — `setup`, login, pairing,
  agents, models, sessions, an interactive `chat` with resume and approvals.
- Desktop, Android and iOS: not started (ADR 0007, ADR 0009).

## Name
Since 2026-09-24 the product is **Core Hub** («كور هب», ADR 0017): packages `@corehub/*`, the
command `corehub`, `COREHUB_*` variables, image `ghcr.io/twuijri/core-hub`. Every name it had
as Majlis is still read where something older may say it — `MAJLIS_*` variables, `majlis.*`
browser keys, `~/.config/majlis`, the `majlis` command, tokens signed as `majlis`, Hermes
provider blocks `majlis-*` (moved to `corehub-*` with every reference to them at boot) and
archives with `majlis-providers.json` — proven by unit and integration tests, not yet on the
owner's test stack.

## First run
A hub with no owner is **open to the first comer for an hour** after the process
starts (ADR 0019, `COREHUB_SETUP_OPEN_MINUTES`, `0` = token only): `/setup` in the
browser or `corehub setup` in a terminal creates the owner from a name and a
password, and the screen says it is open and shows the time left. After the hour
the claim token the hub writes to `<DATA_DIR>/setup-token.txt` and logs is
required (ADR 0011); restarting the hub opens a fresh hour. `meta.get` carries
`setup_open` / `setup_open_until`. Somebody else got there first:
`COREHUB_RESET_OWNER=1` and a restart disables that owner (stepped down to a
disabled admin, tokens revoked, nothing deleted) and reopens setup — once, thanks
to the marker `owner-reset.json`. `HUB_ADMIN_PASSWORD` still creates the owner
unattended and skips the screen.

## Runtime
A fresh install has **two** agents (ADOPTION-BACKLOG §2.15, owner's decision of
2026-09-22):

- **Hermes** runs inside the image, supervised by the hub (ADR 0008). Since
  2026-09-25 the image also carries the dependencies of the two channels the hub
  links itself — Hermes's Telegram client (the exact pin of Hermes's
  `platform.telegram`) and the WhatsApp bridge's `node_modules` — so linking either
  downloads nothing; each profile's bridge copy links to the image's
  (`modules/agents/whatsapp-bridge.ts`). The image grew from 259.2 MB to 284.3 MB
  compressed. Since
  2026-09-23 a conversation reaches it over its **TUI gateway** (ADR 0013), the
  surface Hermes's own apps use: the model's reasoning, each tool's arguments and
  result, and the questions Hermes asks (`clarify`) reach the screen, a question
  as a card above the composer. A Hermes reached from outside the container keeps
  the API server's run surface, without those three.
- **Direct** («مباشر») is the hub itself: a turn is one request from the hub to
  the model provider, with no runtime in between. It runs no tools — skills and
  MCP over this path are backlog §2.16 — and it inlines a text attachment or
  sends an image to a model that accepts one, refusing anything else by name
  (`docs/domain/models.md` §الاتصال المباشر). Its conversation lives in the
  server process, so a restart starts a fresh context.

Either way a model provider must be configured before anything can answer;
until then a run fails with the provider's own message and a named code, never
silently. Coding agents install on demand from the curated catalog into the
data volume (ADR 0006).

## Proven against fakes, not yet against the real thing
- A full turn with a real model reply (needs a provider key on the owner's box).
  The direct path is proven end to end against a scripted provider, in the
  container as well as the test suite; a real provider key is still the owner's
  own check.
- The catalog's pinned versions actually installing and starting on a machine.
- The trajectory's model turns and timings (2026-09-25) are proven against the
  scripted runner (unit, API and browser journey); Hermes's per-turn usage against
  a scripted TUI gateway. Not yet looked at on a real Hermes run; ACP coding agents
  report no usage at all, so their trajectory has times but no token metrics.
- PostgreSQL: the schema is SQLite-shaped so far; the hub refuses rather than
  pretending.
