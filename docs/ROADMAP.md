# Roadmap

Each phase has a definition of done. Phases are sequential; work inside a phase
is parallel by module.

## Phase 0 — Foundation (this repository's first release)
- Workspace skeleton, CI, Docker, contract pipeline generating three clients.
- `auth` (owner account, app tokens, QR pairing), `agents` registry with the
  ACP and Hermes adapters, `sessions` with streaming, `models` basics.
- Done when: a phone app (our existing Android/iOS, re-pointed at `/api/v1`)
  can pair, list agents, open a session with Hermes and a coding agent, and
  stream a reply, with every call generated from the contract.

## Checkpoint A — first deployment on the owner's server
When Phase 0 is about 80 % done (pairing, agents registry with Hermes, one
streamed session), the image is deployed on the owner's host as a separate
test stack next to the fork, and the owner's phones are pointed at it. From
then on every phase ends with a redeploy of that stack; the fork keeps
running until Phase 5.

## Phase 1 — Working together
- `rooms` (multi-agent rooms), `board` (projects, kanban, agent assignment,
  worktree per task), `schedules` (cron + workflows), `notify`.
- Done when: a task can be assigned to an agent from the board, runs in its
  own worktree, reports progress in a room, and a schedule can run a standup.

## Phase 2 — Web client
- `packages/web` implementing `docs/clients/NAVIGATION.md` one-to-one.
- Done when: web parity test passes against the same navigation manifest the
  phones use.

## Phase 3 — Desktop
- `apps/desktop`: the web client in a shell plus local capabilities (local
  apps exposure, device agent).

## Phase 4 — Knowledge, plugins, updates, audit
- `knowledge`, `plugins`, `updates` channel, `audit` dashboards.

## Phase 5 — Replace the fork
- Migrate the owner's data from the Hermes Studio fork (export/import tool),
  retire the fork.
