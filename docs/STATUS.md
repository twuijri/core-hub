# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**182 of 251 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id. Measured on this
branch, 2026-09-22, by asking a booted hub which operations are still the
built-in stub — and `packages/server/tests/unit/status.test.ts` keeps this
number from claiming more than the hub answers.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 34 | 34 | first-run setup, sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles |
| sessions | 26 | 30 | sessions, messages, streamed runs, approvals, resume, fork, and the eight attachment operations (implemented by `knowledge`, which owns the bytes); only session categories are not built |
| models | 26 | 26 | providers, keys, catalogue, defaults, verification on save, speech (ADR 0010) |
| agents | 23 | 40 | registry, curated catalog (Hermes, the hub's own `direct` agent, four coding CLIs), install/remove/upgrade, discovery, restart, per-agent settings — and since 2026-09-23 the three Hermes tool pages that are **files in the agent's own home**: skills (`skills/<slug>/SKILL.md`, written verbatim so a pack's front matter survives), MCP servers (one block of `config.yaml`, edited in place with the comments kept) and memory (`SOUL.md`, `MEMORY.md`, `USER.md`). Channels, plugins, jobs, presets and the journey are not built; `importSkills` and `testMcpServer` stay 501, because neither imports bytes nor opens a connection yet |
| updates | 7 | 7 | release channels, publishing from an upload or a source URL the hub fetches itself, check, download with `Range`, settings whose token never comes back |
| jobs | 3 | 3 | list, get, cancel, with `/rt/jobs` events |
| meta | 2 | 2 | health, and `meta.get` — the hub's name, its build, the contract version it loaded, the realtime namespaces it actually opened, and whether it still needs an owner. Unauthenticated, because a client compares the contract version before it signs in |
| knowledge | 1 | 1 | `knowledge.listItems` — journal, notes and files in one page; the attachment operations it also implements are counted under `sessions`, whose tag declares them |
| audit | 1 | 1 | the Logs, Usage and Performance reports; `skills` still answers `501`, because nothing records skill use and zeros would read as a measurement |
| plugins | 1 | 1 | what is installed on this hub — an empty list until an installer exists |
| tasks | 27 | 27 | projects, the nine-column board with fractional ordering, subtasks, dependencies, comments, activity, worktree rows. Assigning does **not** start a run: the worker that opens a session is not built, and `TaskAssigned` answers `null` rather than an invented id |
| schedules | 20 | 23 | schedules with a real `next_run_at` (cron, interval, once, in the schedule's own timezone), run history, workflow definitions with validation, workflow-run history and cancel, and workflow import preview/confirm. The three that would **start** something — `runNow`, `runWorkflow`, `rerunWorkflowFromNode` — answer `501` with their operation ids |
| rooms | 0 | 28 | several agents in one room |
| devices | 0 | 17 | device registry and push |
| notify | 11 | 11 | the inbox — and since 2026-09-22 something actually writes to it: a run that finishes and an approval that is raised, in the recipient's own language, announced on `/rt/devices`. Per-kind preferences decide whether a notice is written at all, quiet hours are stored as given, and webhooks check their URL against private addresses before anything is sent, with an HMAC signature and a delivery record |

**Phase 4 of the roadmap is complete**: `knowledge`, `plugins`, the `updates`
channel and the `audit` dashboards all answer. Of Phase 1, `tasks` is complete
as a board, `schedules` as definitions and history, and `notify` entirely;
`rooms` is still 501, as is the Hermes-gateway half of `agents`. Phase 3 (phones and desktop) is last, by the
owner's decision on 2026-09-22.

**What answers is not always what works end to end.** Two places say so
themselves rather than in a footnote: assigning a task records the assignee and
returns `null` for the job, the run and the session, because nothing starts a
run from a task yet; a task worktree is recorded in `creating`, because
making a git worktree belongs to whatever runs the task; and the three schedule
operations that would start a run answer `501` rather than recording a run that
never happened. **Nothing in this hub starts a run except a person typing in the
chat.**

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

- **Hermes** runs inside the image, supervised by the hub (ADR 0008), and a run
  reaches it over its real API.
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
