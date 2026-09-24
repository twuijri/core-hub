<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/core-hub-mark-dark.svg">
    <img src="docs/assets/core-hub-mark-light.svg" alt="Core Hub" width="96" height="96">
  </picture>
</p>

# Core Hub

**One self-hosted hub for every AI agent you use: chat, tasks, schedules and workflows,
from the web today and from the desktop and your phone next.**

Core Hub is a server you run on your own machine. It is built around
[Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT), which ships inside the
image, and it adds a curated catalog of coding agents you install on demand. Everything the
hub knows is exposed through one versioned contract (REST + realtime), and every client (web,
terminal and, later, desktop and mobile) is a thin surface over that same contract.

- **Self-hosted:** one container, one data volume. Your keys, conversations and agent homes
  stay on your box.
- **Hermes is the base:** memory, skills, MCP, jobs, plugins and channels are Hermes's own,
  managed from the hub ([ADR 0006](docs/adr/0006-hermes-is-the-base.md)).
- **One contract:** clients never talk to an agent directly and never decide workflow state
  ([ADR 0003](docs/adr/0003-contract-first.md), [ADR 0007](docs/adr/0007-clients-from-scratch.md)).

## Contents

- [Highlights](#highlights)
- [Quick start with Docker](#quick-start-with-docker)
- [Updating](#updating)
- [Architecture at a glance](#architecture-at-a-glance)
- [Development](#development)
- [Contributing](#contributing)
- [Project status and roadmap](#project-status-and-roadmap)
- [License](#license)

## Highlights

- **Chat:** streamed replies with the model's reasoning, every tool call with its arguments
  and result, approvals and questions from the agent as cards, resume and fork, attachments,
  and a long history paged back without losing your place.
- **Profiles:** each profile is a real Hermes profile with its own config, memory, skills and
  sessions ([ADR 0014](docs/adr/0014-workspaces-are-hermes-profiles.md)). Create one from
  scratch or as a copy, export it as an archive and import it elsewhere.
- **Tasks board:** a nine-column board with projects, subtasks, dependencies and comments.
  Assigning a task to an agent starts a real run, and the card moves on its own when the run
  ends. Hermes's own kanban appears on the same board.
- **Schedules and workflows:** cron, interval and one-off schedules in their own timezone,
  with "run if missed" and overlap options. Workflows run step by step (agent, condition,
  delay, notify) and pause at approval steps until someone approves or denies.
- **Agents:** a curated catalog (Hermes, a built-in `direct` agent that calls the model
  provider itself, Claude Code, Codex, Gemini CLI and opencode). Per profile: skills, MCP
  servers (with a live connection test), memory, jobs, plugins and messaging channels.
  WhatsApp pairs by QR code; Telegram is in progress.
- **Providers:** add a model provider once, as shared by every profile or owned by one
  profile. The hub stores keys encrypted and hands them to every agent that needs them
  ([ADR 0010](docs/adr/0010-one-credential-store.md)). Local servers such as LM Studio,
  Ollama or LiteLLM work too.
- **Users and roles:** owner, admin and member. A member enters only the profiles explicitly
  granted to them. App tokens and QR device pairing are built in.
- **Realtime:** Socket.IO namespaces per module, so chats, boards, schedules and jobs update
  live across every open client.
- **Also included:** an inbox with notifications and signed webhooks, knowledge (journal,
  notes, files), logs, usage and performance reports, and an update channel for clients.
- **Sealed image:** the hub's code and Hermes's code are read-only inside the container. An
  agent cannot change either; every file that is written lives in `/data`.

## Quick start with Docker

The image is published for `linux/amd64` and `linux/arm64` as
`ghcr.io/twuijri/core-hub:latest`. Save this as `docker-compose.yml`:

```yaml
services:
  hub:
    image: ghcr.io/twuijri/core-hub:latest
    restart: unless-stopped
    ports:
      - '${HUB_PORT:-8080}:8080'
    environment:
      DATA_DIR: /data
      PORT: '8080'
      # Optional, unattended installs only: creates the owner `admin` on first boot.
      HUB_ADMIN_PASSWORD: ${HUB_ADMIN_PASSWORD:-}
    volumes:
      - hub-data:/data
    # Lets the container reach a model server on the host (LM Studio, Ollama).
    extra_hosts:
      - 'host.docker.internal:host-gateway'

volumes:
  hub-data:
```

Then start it and read the first-run setup token:

```bash
docker compose up -d
docker compose logs hub                             # the setup token is printed once at boot
docker compose exec hub cat /data/setup-token.txt   # or read it from the data volume
```

1. Open `http://<host>:8080`. A fresh hub shows **Create the owner account**.
2. Paste the setup token, choose a username and a password, and you are signed in. The token
   is then deleted. Until the owner exists, every restart makes a new token
   ([ADR 0011](docs/adr/0011-first-run-setup.md)).
3. Go to **Models**, add a provider, and start chatting with Hermes.

For unattended installs, set `HUB_ADMIN_PASSWORD` before the first boot instead. The hub then
creates the owner `admin` with that password, writes no token and skips the setup screen.

**Configuration.** Four variables are the whole configuration:

| Variable | Meaning |
| --- | --- |
| `DATA_DIR` | Where everything is stored (`/data`, the `hub-data` volume). |
| `PORT` / `HUB_PORT` | The hub listens on `8080` inside; `HUB_PORT` publishes it on the host. |
| `HUB_ADMIN_PASSWORD` | Optional. Creates the owner unattended on first boot; ignored afterwards. |
| `DATABASE_URL` | Optional PostgreSQL instead of the SQLite file. |

**Where data lives.** Everything the hub writes is in the data volume:

| Path | What |
| --- | --- |
| `/data/hub.sqlite` | the hub's database |
| `/data/keys/` | signing and encryption keys. **Back up `/data/keys/data.key`**: without it, stored provider keys cannot be read. |
| `/data/hermes/` | Hermes's home: config, memories, skills, sessions, cron |
| `/data/agents/<id>/` | coding agents installed from the catalog |
| `/data/workspaces/<profile>/` | each conversation's working folder |

The full operator's guide, including local model servers, an external Hermes and a smoke
checklist, is [docs/DEPLOY.md](docs/DEPLOY.md).

## Updating

Replace the image only. The data volume is never touched:

```bash
docker compose pull && docker compose up -d
```

## Architecture at a glance

```
clients   web · terminal · (desktop · android · ios)     render the contract, no business rules
   │  REST /api/v1/*  +  realtime /rt (Socket.IO)
server    modules (domain) · app (composition) · adapters (agents, storage)
   │  Hermes TUI gateway and API · ACP (JSON-RPC over stdio) · process harness
agents    Hermes Agent · Claude Code · Codex · Gemini CLI · opencode
```

| Package | Role |
| --- | --- |
| [`packages/contracts`](packages/contracts) | The OpenAPI document and realtime event schemas, and the clients generated from them. |
| [`packages/server`](packages/server) | The hub: Fastify, Socket.IO and Drizzle (SQLite by default). |
| [`packages/web`](packages/web) | The web client: Vite and React, generated from the contract. The hub serves it at `/`. |
| [`packages/cli`](packages/cli) | The reference terminal client: setup, login, pairing, agents, models and chat. |
| [`packages/ui-tokens`](packages/ui-tokens) | Shared design tokens for every client. |

Server modules live in `packages/server/src/modules/<name>/`, each owning its own tables,
routes, events and tests: `auth`, `agents`, `sessions`, `models`, `tasks`, `schedules`,
`knowledge`, `notify`, `updates`, `audit`, `plugins`, `rooms` and `devices`.

Read more in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the decisions in
[docs/adr/](docs/adr/), the contract in [docs/contracts/](docs/contracts/) and the shared
navigation map in [docs/clients/NAVIGATION.md](docs/clients/NAVIGATION.md).

## Development

Node 24 (pinned in `.nvmrc`) and pnpm through Corepack:

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile

pnpm dev        # the hub on :8080, SQLite under ./.data
pnpm web:dev    # the web client on :5173, proxying /api and /rt to :8080
```

The first boot prints a setup token; create the owner on `/setup`, or set
`HUB_ADMIN_PASSWORD` to skip the screen. The terminal client works against any hub:

```bash
pnpm --filter ./packages/cli build
node packages/cli/dist/bin.js setup --server http://127.0.0.1:8080
node packages/cli/dist/bin.js login --server http://127.0.0.1:8080
```

The checks CI runs:

```bash
pnpm lint typecheck test contract:test contracts:lint contracts:check-clients nav:check i18n:check build
pnpm web:e2e    # Playwright journeys against a real hub
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the details, and
[docs/harness/validation.md](docs/harness/validation.md) says which checks each kind of
change needs.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and
[docs/TEAM-RULES.md](docs/TEAM-RULES.md) before opening a pull request. They bind people and
AI agents alike. In short:

- **Clean room:** no code is copied from other studios
  ([ADR 0004](docs/adr/0004-clean-room.md)). Ideas are credited in
  [docs/inspirations/](docs/inspirations/).
- **Contract first:** an operation or event goes into `packages/contracts` before the server,
  and the server before the clients.
- **One task, one branch, one change record** under [docs/changes/](docs/changes/), with the
  real output of the checks you ran.
- **Arabic and English:** every user-facing string exists in both.
- Pull requests are written in English. Only the owner merges into `main`.

## Project status and roadmap

- **Working today:** the hub, Hermes inside the image, the web client and the terminal client.
  Chat, profiles, Tasks, Schedules and workflows, Models, users, notifications, knowledge and
  updates all answer.
- **Not built yet:** multi-agent rooms, device registry and push, a git worktree per task,
  and parts of the agent pages (presets, Telegram setup).
- **Next:** the desktop app and the Android and iOS clients, then migrating from the previous
  studio.

Every contract operation that is not built answers `501` with its id; nothing fakes a success.
[docs/STATUS.md](docs/STATUS.md) is the module-by-module account, and
[docs/ROADMAP.md](docs/ROADMAP.md) has the phases and what "done" means for each.

## License

Core Hub is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE)
for the copyright notice that must travel with copies.

Third-party components reused under their own licences, and the projects whose ideas were
adopted, are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Agent names and
marks belong to their owners; Core Hub is not affiliated with or endorsed by them.
