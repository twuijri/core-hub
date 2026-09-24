# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**189 of 252 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id. Measured on this
branch, 2026-09-22, by asking a booted hub which operations are still the
built-in stub — and `packages/server/tests/unit/status.test.ts` keeps this
number from claiming more than the hub answers.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 34 | 34 | first-run setup, sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles — and since 2026-09-23 **a workspace is a Hermes profile** (ADR 0014): created in Hermes from scratch or as a copy, and Hermes's own profiles listed as workspaces. Since 2026-09-24 **a member enters only the profiles explicitly granted** — an empty list means none, a new profile is nobody's until granted (contract decision §29, migration `0010`). Export and import still only queue a job that nothing runs (stage 2), and a conversation still runs in Hermes's default profile (stage 3) |
| sessions | 26 | 30 | sessions, messages, streamed runs, approvals, resume, fork, and the eight attachment operations (implemented by `knowledge`, which owns the bytes); only session categories are not built. Since 2026-09-24 the list and search cross every profile the caller may enter (`profiles=all`, and `profiles: 'all'` on the socket — ADR 0016) |
| models | 26 | 26 | providers, keys, catalogue, defaults, verification on save, speech (ADR 0010) |
| agents | 29 | 40 | registry, curated catalog (Hermes, the hub's own `direct` agent, four coding CLIs), install/remove/upgrade, discovery, restart, per-agent settings — and since 2026-09-23 the three Hermes tool pages that are **files in the agent's own home**: skills (`skills/<slug>/SKILL.md`, written verbatim so a pack's front matter survives), MCP servers (one block of `config.yaml`, edited in place with the comments kept) memory (`SOUL.md`, `MEMORY.md`, `USER.md`) and channels (`platforms:`, whose fields are read from the file rather than from a form the hub wrote). Plugins, jobs, presets and the journey are not built. Since 2026-09-24 the four pages act on **the selected profile's** Hermes home (`profiles/<slug>`, the root for the default one; a profile Hermes does not have says so), and the three live tools work: `testMcpServer` has **Hermes** connect to the server and list its tools (Hermes's own `/api/mcp/servers/{name}/test`, ADR 0015), `loginChannel` pairs **WhatsApp by QR** through Hermes's onboarding as a `channel_login` job whose progress carries the code, and `importSkills` installs an uploaded `SKILL.md` or zip into the profile's `skills/`, byte for byte, checked by Hermes's reading rules, all or nothing. The first two need a Hermes the hub supervises; Telegram's bot-creation flow is not a QR pairing and is not built |
| updates | 7 | 7 | release channels, publishing from an upload or a source URL the hub fetches itself, check, download with `Range`, settings whose token never comes back |
| jobs | 3 | 3 | list, get, cancel, with `/rt/jobs` events |
| meta | 2 | 2 | health, and `meta.get` — the hub's name, its build, the contract version it loaded, the realtime namespaces it actually opened, and whether it still needs an owner. Unauthenticated, because a client compares the contract version before it signs in |
| knowledge | 1 | 1 | `knowledge.listItems` — journal, notes and files in one page; the attachment operations it also implements are counted under `sessions`, whose tag declares them |
| audit | 1 | 1 | the Logs, Usage and Performance reports; `skills` still answers `501`, because nothing records skill use and zeros would read as a measurement |
| plugins | 1 | 1 | what is installed on this hub — an empty list until an installer exists |
| tasks | 27 | 27 | projects, the nine-column board with fractional ordering, subtasks, dependencies, comments, activity, worktree rows — and since 2026-09-23 **Hermes's own kanban on the same board**: read through `hermes kanban list` when the board opens, Hermes wins on every read, a move on a Hermes card is asked of Hermes first and a refusal comes back in Hermes's words, and a task given to Hermes goes on Hermes's board. And since 2026-09-24 **assigning starts the work**: `assignTask` with `start: true` opens a session of source `task` for the assignee (in the workspace's ordinary per-session folder), queues one run whose prompt is the task — title, brief, checklist as it stands, the instructions given — moves the task to `running` and answers `202` with the real job, run and session ids; when the run ends the task moves on its own (`review` with the agent's last words as the progress summary, `blocked` with the reason it failed, `ready` when stopped from the chat). Stop, unassign, reassign and a person's move out of `running` cancel the run for real; `dispatch` starts what it assigns; a restart settles the tasks it finds left `running`. Without `start` a task is only assigned and `TaskAssigned` answers `null` ids. A task given to Hermes is handed to Hermes's own board and never run by the hub. And since 2026-09-24 **Hermes's cards are fully editable from the board** when the hub manages Hermes: their title, description and priority, deleting them, comments (said on Hermes's card in the person's name; Hermes's own comments shown on the card), stopping their run and handing them to another workspace's Hermes profile all go through Hermes's own API (`hermes serve`, ADR 0015) — Hermes first, the reflection refreshed from Hermes's answer, a refusal in Hermes's words; opening the board starts that server in the background. Where the hub does not run Hermes (an external one), those writes are still refused as before. **Not built yet:** a git worktree per task (the row is still recorded in `creating` and nothing makes one), reporting into a project's room (`rooms` is 501), and `auto_start` And since 2026-09-24 (ADR 0016 stage 2, DECISIONS §31) `listTasks` takes `profiles=all` (one keyset over every profile the caller may enter), the board answers `profiles=all` too, a card's `assignee.name` is the registry's (it used to be the id), `dispatch` and the two worktree operations answer the contract's `JobAccepted` (`{job_id}`), and Hermes's board is read whenever anyone opens the board, not only someone who may enter the default profile |
| schedules | 20 | 23 | schedules with a real `next_run_at` (cron, interval, once, in the schedule's own timezone), run history, workflow definitions with validation, workflow-run history and cancel, and workflow import preview/confirm — and since 2026-09-23 **Hermes's own cron on the same page**: a schedule for the Hermes agent is created, edited, paused, deleted and fired *in Hermes's scheduler* through its `/api/jobs`, so it really runs; jobs Hermes made itself appear too, Hermes wins on every read, and the runs Hermes reports land in the history. And since 2026-09-23 **workflows run**: `runWorkflow` and `rerunWorkflowFromNode` walk the drawing step by step — `condition`, `delay` and `notify` done by the engine, `agent` as a real turn in a session of its own (source `workflow`), each step's output readable by the next as `{{steps.<id>.output}}`; cancel stops a run at once, a restart fails the runs it cut short, and conditions and templates are checked when the workflow is saved. `approval` steps are not built and fail saying so. `runNow` for a schedule that is not Hermes's still answers `501`, because nothing fires the hub's own schedules yet Since 2026-09-24 `schedules.list` pages for real (the `cursor`/`limit` it always declared, one keyset over every profile) and takes `profiles=all`; Hermes's cron is read whenever anyone opens the page |
| rooms | 0 | 28 | several agents in one room |
| devices | 0 | 17 | device registry and push |
| notify | 12 | 12 | the inbox — and since 2026-09-22 something actually writes to it: a run that finishes and an approval that is raised, in the recipient's own language, announced on `/rt/devices`. Per-kind preferences decide whether a notice is written at all, quiet hours are stored as given, and webhooks check their URL against private addresses before anything is sent, with an HMAC signature and a delivery record; since 2026-09-24 a webhook's recent deliveries are readable (`listWebhookDeliveries`). **The only delivery a webhook receives today is the test one**: nothing forwards the hub's events to a webhook yet, so the events it subscribes to are stored and not sent |

**Phase 4 of the roadmap is complete**: `knowledge`, `plugins`, the `updates`
channel and the `audit` dashboards all answer. Of Phase 1, `tasks` is complete
as a board, `schedules` as definitions and history, and `notify` entirely;
`rooms` is still 501, as is the Hermes-gateway half of `agents`. Phase 3 (phones and desktop) is last, by the
owner's decision on 2026-09-22.

**What answers is not always what works end to end.** Two places say so
themselves rather than in a footnote: a task worktree is recorded in `creating`,
because making a git worktree is not built — a started task works in its
session's ordinary folder under `/data/workspaces/<profile>/` instead; and the
three schedule operations that would start a run answer `501` rather than
recording a run that never happened. **Nothing in this hub starts a run except a
person typing in the chat, a workflow someone ran, a task someone assigned and
started (or dispatched), and Hermes's own scheduler and kanban for the schedules
and cards that live in them.**

## Clients
- **Web** (`packages/web`): first-run setup, login, chat with streaming,
  approvals and resume, sessions list, agents, models, the Tasks board,
  schedules, notifications, people, workspaces, knowledge, plugins, updates,
  about, settings, pairing. Screens whose module is still 501 say so explicitly
  instead of showing an empty page.
  The destinations still showing that placeholder all wait on a **module**:
  `rooms`, and the parts of `agents` its row above lists as not built. Since
  2026-09-24 none waits only on a screen: **Webhooks** lists, adds, edits, enables, deletes and test-sends
  (the test really arrives, signed, and its delivery is listed with the
  endpoint's status), and **Privacy** lists the app tokens and paired devices
  that can act as you and revokes them. Privacy's `redact_pii` switch is not
  shown, because nothing in the hub applies it yet.
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

## First run
A hub with no account writes a claim token to `<DATA_DIR>/setup-token.txt`,
logs it once, and the owner account is created from `/setup` in the browser or
`majlis setup` in a terminal (ADR 0011). `HUB_ADMIN_PASSWORD` still creates the
owner unattended and skips the screen.

## Runtime
A fresh install has **two** agents (ADOPTION-BACKLOG §2.15, owner's decision of
2026-09-22):

- **Hermes** runs inside the image, supervised by the hub (ADR 0008). Since
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
- PostgreSQL: the schema is SQLite-shaped so far; the hub refuses rather than
  pretending.
