# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**185 of 251 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id. Measured on this
branch, 2026-09-22, by asking a booted hub which operations are still the
built-in stub — and `packages/server/tests/unit/status.test.ts` keeps this
number from claiming more than the hub answers.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 34 | 34 | first-run setup, sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles — and since 2026-09-23 **a workspace is a Hermes profile** (ADR 0014): created in Hermes from scratch or as a copy, and Hermes's own profiles listed as workspaces. Export and import still only queue a job that nothing runs (stage 2), and a conversation still runs in Hermes's default profile (stage 3) |
| sessions | 26 | 30 | sessions, messages, streamed runs, approvals, resume, fork, and the eight attachment operations (implemented by `knowledge`, which owns the bytes); only session categories are not built |
| models | 26 | 26 | providers, keys, catalogue, defaults, verification on save, speech (ADR 0010) |
| agents | 26 | 40 | registry, curated catalog (Hermes, the hub's own `direct` agent, four coding CLIs), install/remove/upgrade, discovery, restart, per-agent settings — and since 2026-09-23 the three Hermes tool pages that are **files in the agent's own home**: skills (`skills/<slug>/SKILL.md`, written verbatim so a pack's front matter survives), MCP servers (one block of `config.yaml`, edited in place with the comments kept) memory (`SOUL.md`, `MEMORY.md`, `USER.md`) and channels (`platforms:`, whose fields are read from the file rather than from a form the hub wrote). Plugins, jobs, presets and the journey are not built; `importSkills`, `testMcpServer` and `loginChannel` stay 501, because nothing imports bytes, opens an MCP connection or pairs by QR yet |
| updates | 7 | 7 | release channels, publishing from an upload or a source URL the hub fetches itself, check, download with `Range`, settings whose token never comes back |
| jobs | 3 | 3 | list, get, cancel, with `/rt/jobs` events |
| meta | 2 | 2 | health, and `meta.get` — the hub's name, its build, the contract version it loaded, the realtime namespaces it actually opened, and whether it still needs an owner. Unauthenticated, because a client compares the contract version before it signs in |
| knowledge | 1 | 1 | `knowledge.listItems` — journal, notes and files in one page; the attachment operations it also implements are counted under `sessions`, whose tag declares them |
| audit | 1 | 1 | the Logs, Usage and Performance reports; `skills` still answers `501`, because nothing records skill use and zeros would read as a measurement |
| plugins | 1 | 1 | what is installed on this hub — an empty list until an installer exists |
| tasks | 27 | 27 | projects, the nine-column board with fractional ordering, subtasks, dependencies, comments, activity, worktree rows — and since 2026-09-23 **Hermes's own kanban on the same board**: read through `hermes kanban list` when the board opens, Hermes wins on every read, a move on a Hermes card is asked of Hermes first and a refusal comes back in Hermes's words, and a task given to Hermes goes on Hermes's board. And since 2026-09-24 **assigning starts the work**: `assignTask` with `start: true` opens a session of source `task` for the assignee (in the workspace's ordinary per-session folder), queues one run whose prompt is the task — title, brief, checklist as it stands, the instructions given — moves the task to `running` and answers `202` with the real job, run and session ids; when the run ends the task moves on its own (`review` with the agent's last words as the progress summary, `blocked` with the reason it failed, `ready` when stopped from the chat). Stop, unassign, reassign and a person's move out of `running` cancel the run for real; `dispatch` starts what it assigns; a restart settles the tasks it finds left `running`. Without `start` a task is only assigned and `TaskAssigned` answers `null` ids. A task given to Hermes is handed to Hermes's own board and never run by the hub. And since 2026-09-24 **Hermes's cards are fully editable from the board** when the hub manages Hermes: their title, description and priority, deleting them, comments (said on Hermes's card in the person's name; Hermes's own comments shown on the card), stopping their run and handing them to another workspace's Hermes profile all go through Hermes's own API (`hermes serve`, ADR 0015) — Hermes first, the reflection refreshed from Hermes's answer, a refusal in Hermes's words; opening the board starts that server in the background. Where the hub does not run Hermes (an external one), those writes are still refused as before. **Not built yet:** a git worktree per task (the row is still recorded in `creating` and nothing makes one), reporting into a project's room (`rooms` is 501), and `auto_start` |
| schedules | 20 | 23 | schedules with a real `next_run_at` (cron, interval, once, in the schedule's own timezone), run history, workflow definitions with validation, workflow-run history and cancel, and workflow import preview/confirm — and since 2026-09-23 **Hermes's own cron on the same page**: a schedule for the Hermes agent is created, edited, paused, deleted and fired *in Hermes's scheduler* through its `/api/jobs`, so it really runs; jobs Hermes made itself appear too, Hermes wins on every read, and the runs Hermes reports land in the history. And since 2026-09-23 **workflows run**: `runWorkflow` and `rerunWorkflowFromNode` walk the drawing step by step — `condition`, `delay` and `notify` done by the engine, `agent` as a real turn in a session of its own (source `workflow`), each step's output readable by the next as `{{steps.<id>.output}}`; cancel stops a run at once, a restart fails the runs it cut short, and conditions and templates are checked when the workflow is saved. `approval` steps are not built and fail saying so. `runNow` for a schedule that is not Hermes's still answers `501`, because nothing fires the hub's own schedules yet |
| rooms | 0 | 28 | several agents in one room |
| devices | 0 | 17 | device registry and push |
| notify | 11 | 11 | the inbox — and since 2026-09-22 something actually writes to it: a run that finishes and an approval that is raised, in the recipient's own language, announced on `/rt/devices`. Per-kind preferences decide whether a notice is written at all, quiet hours are stored as given, and webhooks check their URL against private addresses before anything is sent, with an HMAC signature and a delivery record |

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
  Ten destinations are still that placeholder, and they are two different
  things. Nine wait on a **module**: `rooms`, and the seven Hermes-gateway
  pages of `agents` (skills, MCP, memory, jobs, channels, plugins, the global
  agent). One waits only on a **screen**, because the hub already answers it:
  `webhooks` (`privacy` has no operations of its own).
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
