# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**111 of 251 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id. Measured on this
branch, 2026-09-22, by asking a booted hub which operations are still the
built-in stub — and `packages/server/tests/unit/status.test.ts` keeps this
number from claiming more than the hub answers.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 34 | 34 | first-run setup, sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles |
| sessions | 26 | 30 | sessions, messages, streamed runs, approvals, resume, fork, and the eight attachment operations (implemented by `knowledge`, which owns the bytes); only session categories are not built |
| models | 26 | 26 | providers, keys, catalogue, defaults, verification on save, speech (ADR 0010) |
| agents | 11 | 40 | registry, curated catalog (Hermes, the hub's own `direct` agent, four coding CLIs), install/remove/upgrade, discovery, restart, per-agent settings; the Hermes-gateway screens (skills, MCP, memory, channels, plugins, presets) are not built |
| updates | 7 | 7 | release channels, publishing from an upload or a source URL the hub fetches itself, check, download with `Range`, settings whose token never comes back |
| jobs | 3 | 3 | list, get, cancel, with `/rt/jobs` events |
| meta | 1 | 2 | health |
| knowledge | 1 | 1 | `knowledge.listItems` — journal, notes and files in one page; the attachment operations it also implements are counted under `sessions`, whose tag declares them |
| audit | 1 | 1 | the Logs, Usage and Performance reports; `skills` still answers `501`, because nothing records skill use and zeros would read as a measurement |
| plugins | 1 | 1 | what is installed on this hub — an empty list until an installer exists |
| rooms | 0 | 28 | several agents in one room |
| tasks | 0 | 27 | the Tasks section |
| schedules | 0 | 23 | scheduled and recurring work |
| devices | 0 | 17 | device registry and push |
| notify | 0 | 11 | notifications and webhooks |

**Phase 4 of the roadmap is complete**: `knowledge`, `plugins`, the `updates`
channel and the `audit` dashboards all answer. What is left before the phones
and the desktop (Phase 3, which the owner put last on 2026-09-22) is Phase 1 —
`rooms`, `tasks`, `schedules`, `notify` — and the Hermes-gateway half of
`agents`.

## Clients
- **Web** (`packages/web`): first-run setup, login, chat with streaming,
  approvals and resume, sessions list, agents, models, settings, pairing.
  Screens whose module is still 501 say so explicitly instead of showing an
  empty page.
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
