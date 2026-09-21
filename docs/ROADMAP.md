# Roadmap

Each phase has a definition of done. Phases are sequential; work inside a phase
is parallel by module.

## Phase 0 — Foundation (this repository's first release)
- Workspace skeleton, CI, Docker, contract pipeline generating three clients.
- `auth` (owner account, app tokens, QR pairing), `agents` registry with the
  ACP and Hermes adapters, `sessions` with streaming, `models` basics.
- Done when: the in-repo reference client (`packages/cli`, generated from the
  contract) can pair, list agents, open a session with Hermes and a coding
  agent, and stream a reply. No old client is involved (ADR 0007).

## Checkpoint A — first deployment on the owner's server
When Phase 0 is about 80 % done (pairing, agents registry with Hermes, one
streamed session), the image is deployed on the owner's host as a separate
test stack next to the fork, reachable from the reference client and from the
web client once it exists. From then on every phase ends with a redeploy of
that stack; the fork keeps running until Phase 5.

## Phase 1 — Working together
- `rooms` (multi-agent rooms), `tasks` (a kanban-style section: projects,
  agent assignment, worktree per task), `schedules` (cron + workflows),
  `notify`.
- Done when: a task can be assigned to an agent from the Tasks section, runs
  in its own worktree, reports progress in a room, and a schedule can run a
  standup.

## Phase 2 — Web client
- `packages/web` implementing `docs/clients/NAVIGATION.md` one-to-one.
- Done when: web parity test passes against the same navigation manifest the
  phones use.

## Phase 3 — Phones and desktop
- `apps/android`, `apps/ios`: new native clients from the contract and the
  navigation manifest (ADR 0007); `apps/desktop`: the web client in a shell
  plus local capabilities, in the two modes of ADR 0009 (never bundling Hermes).

## Phase 3b — Desktop details
- `apps/desktop`: the web client in a shell plus local capabilities (local
  apps exposure, device agent).

## Phase 4 — Knowledge, plugins, updates, audit
- `knowledge`, `plugins`, `updates` channel, `audit` dashboards.

## Phase 5 — Replace the fork
- Migrate the owner's data from the Hermes Studio fork (export/import tool),
  retire the fork.

## Sizes (owner's rule, 2026-09-21)
What people download is what matters: the Docker image (compressed pull
size) and the desktop installer. Low hundreds of MB is fine; going above it
is fine only when a real feature needs it, never by neglect. Report the
compressed pull size as the headline number. Repository size is irrelevant.
