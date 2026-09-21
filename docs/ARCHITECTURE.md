# Architecture

## One sentence
Majlis is a server that owns the truth about agents, sessions, rooms, tasks
and schedules, exposes it through one versioned contract (REST + realtime),
and drives agents through adapters; every client renders that contract.

## The three layers (and nothing between them)

```
clients      web · desktop · android · ios        (render the contract, no business rules)
   │  REST /api/v1/*   +   realtime /rt (Socket.IO namespaces)
server       modules (domain) ─ app (composition) ─ adapters (agents, storage)
   │  ACP (JSON-RPC over stdio) · Hermes gateway API · process harness
agents       Hermes Agent · Claude Code · Codex · OpenCode · Gemini CLI · …
```

Rules that keep the layers honest:
- A client never talks to an agent directly and never decides workflow state.
  If a client needs a rule, the rule moves into the server and the contract.
- The server never renders. It answers, streams and stores.
- Agents are replaceable. Everything agent-specific lives in one adapter; the
  rest of the server sees the `AgentAdapter` interface only
  (`docs/adr/0002-agent-connectivity.md`).

## Modules (server)
`packages/server/src/modules/<name>/` with `index.ts` as the only import
surface. A module owns its tables, its routes, its events and its tests.

| Module | Owns | Inspired by |
|---|---|---|
| `auth` | users, roles (owner, admin, member), passwords, app tokens, device pairing (QR) | our mobile pairing |
| `agents` | registry of agents, adapters, install/version state, per-agent settings, capabilities | Ekko idea: one manager; AionUi: ACP auto-detect |
| `sessions` | chat sessions, messages, streaming runs, tool calls, approvals | Ekko idea |
| `rooms` | multi-agent rooms, seats, mentions, handoffs, room memory | Ekko idea (unique) |
| `tasks` | Tasks (a kanban-style section) and their projects, assignment to agents, transitions, worktrees per task | clawboard, Vibe Kanban, Multica, Claw-Kanban |
| `schedules` | cron jobs, workflows (DAG of runs), run history, approvals inside runs | Multica standups, Proliferate workflows |
| `knowledge` | journal, notes/memory browser, files/attachments, search | clawboard |
| `models` | providers, keys (secrets), model catalogue, fallbacks, STT/TTS providers | Ekko idea |
| `devices` | phones/computers linked to the hub, capabilities they expose, media relay | our device:// rule |
| `notify` | push/APNs/FCM, in-app notices, webhooks out | — |
| `updates` | release channels for the clients, in-app update source | our test track |
| `audit` | usage, costs, logs, performance snapshots | clawboard stats, Multica audit |
| `plugins` | Docker/MCP based extensions and skills exposure | clawboard plugins, ACP skills |

Composition lives in `packages/server/src/app/` (routes mount order, sockets,
DB, config). No module imports `app`.

## Hermes is the base (ADR 0006)
Hermes Agent is the always-present runtime the hub is built around; coding
agents are optional installs from the registry. Memory, skills, jobs and
channels are Hermes's; rooms, tasks and schedules may use any installed
agent.

## Data ownership
- One database (SQLite file by default, PostgreSQL optional) owned by the
  server. Agents keep their own state in their own homes; the hub stores
  references and transcripts it received, never the agent's private files.
- Secrets are stored encrypted at rest, masked on every read (`[stored]`),
  never logged, never returned to a client.
- Every row that a client can show carries `created_at`, `updated_at`,
  `profile` (workspace scope) and `owner_id`.

## Contract
`packages/contracts` holds the OpenAPI document and the realtime event
schemas (JSON Schema). From it we generate: the server's route types, the
TypeScript client, the Kotlin client and the Swift client. A hand-typed path
string in a client is a CI failure. Versioning: `/api/v1`; breaking changes
create `/api/v2` and an ADR.

## Realtime
Socket.IO namespaces mirror modules that stream: `/rt/sessions`, `/rt/rooms`,
`/rt/tasks`, `/rt/schedules`, `/rt/devices`. Events are named
`<entity>.<verb>` (`message.delta`, `run.failed`, `task.moved`) and are
declared in the contract with their payload schema.

## Invariants (tested)
1. A message, task or run is created by exactly one module and referenced by
   id elsewhere.
2. A stale or unknown id is a 404 with `{ error, code }`; nothing on the server
   guesses or auto-creates.
3. Every request carries a workspace scope (`X-Hub-Profile`); every query is
   filtered by it.
4. Long work (installs, runs) is a job with progress events; HTTP returns the
   job id immediately.
5. The server starts with zero configuration beyond a data directory;
   everything else is set from the UI and stored. The owner account is created
   on first run from a client, with the claim token the hub writes into that
   directory (ADR 0011); `HUB_ADMIN_PASSWORD` stays as the optional unattended
   path. Four environment variables exist and none of them is required.

## Clean room
This code base is written from `docs/` specifications. Contributors, human or
AI, do not open Hermes Studio / Ekko Studio source while working here. See
`docs/adr/0004-clean-room.md`.
