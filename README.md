<p align="center"><img src="./packages/client/public/logo.png" alt="Core Hub" width="120" /></p>

<h1 align="center">Core Hub</h1>

<p align="center">
  A personal, non-commercial fork of <a href="https://github.com/EKKOLearnAI/hermes-studio">Ekko Studio</a>
  (formerly Hermes Studio) by EKKOLearnAI.<br/>
  Run Studio on your own server, use the desktop app as its client, and let your server-side agent
  operate your machine — with approvals, shared folders, and an audit trail.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-BSL%201.1-blue?style=flat-square" alt="License: BSL 1.1"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-studio"><img src="https://img.shields.io/badge/based%20on-Ekko%20Studio-6f42c1?style=flat-square" alt="Based on Ekko Studio"/></a>
  <img src="https://img.shields.io/badge/use-non--commercial-orange?style=flat-square" alt="Non-commercial use"/>
</p>

> **Attribution.** Core Hub is built on Ekko Studio, created by
> [EKKOLearnAI](https://github.com/EKKOLearnAI) and its contributors. The upstream
> [LICENSE](./LICENSE) (Business Source License 1.1) applies to this repository in full and is
> never removed or altered. Core Hub is an independent name for this derivative; it is not an
> official EKKOLearnAI product, is not affiliated with EKKOLearnAI, and claims no ownership of the
> upstream code, names, or hosted services. See [NOTICE.personal.md](./NOTICE.personal.md).

## What Core Hub adds

Core Hub keeps Ekko Studio's workspace — multi-agent chat, coding agents, workflows, Kanban,
devices, voice, and files — and adds the pieces needed to run it as **one server, many devices**:

- **Server-linked desktop mode.** The desktop app can run as a thin client of a Studio server you
  own. Hermes, its memory, models, skills, and profiles all live on the server; nothing is installed
  locally. The classic local mode is unchanged and stays the default for existing installs.
- **Device Agent.** From the linked desktop app, the server-side Hermes can operate your machine
  through Studio's existing device tools: run commands (started in folders you share, each one approved by you) and exchange files inside those folders,
  take screenshots and use the mouse and keyboard, and drive the app's agent browser. The device only
  connects outbound, every capability is opt-in, commands and screen access ask for approval, a
  visible banner with a Stop button shows while the screen is controlled, and every action is logged.
- **App connections.** MCP servers already registered on your computer with Claude Desktop,
  Claude Code, Codex, Cursor, or Windsurf (DaVinci Resolve, Blender, Figma, …) can be shared
  through the linked app; the server exposes them to the allowed agent profiles as managed MCP
  servers, so any app with an AI integration works with your Hermes without knowing Core Hub.
- **Device ↔ profile bindings.** Restrict each linked device to specific Hermes profiles from the
  server's Devices page, so a work profile only ever sees the work laptop.
- **Kanban board.** A drag-and-drop board built on Hermes' real task states, with an inbox strip,
  compact columns, status rings on cards, optimistic moves, and fast loads through direct reads of
  the Hermes task database.
- **Arabic-first UI.** Full Arabic locale, a content-direction contract so mixed Arabic/Latin text
  and inputs render correctly, and RTL-aware desktop pages.
- **Core Hub identity.** New name, logo, and desktop artifacts while every storage path, protocol
  identifier, API route, and tool name stays compatible with upstream, so updates keep merging.

Upstream features remain documented in [docs/UPSTREAM-README.md](./docs/UPSTREAM-README.md).
Official cloud subscriptions, product downloads, hosted services, and the auto-updater are
intentionally disabled in this fork.

## Getting started

### Server

Core Hub ships as a Docker image built from this repository. It is a drop-in replacement for an
existing Ekko Studio / Hermes Studio stack: change only the `image` line and keep your service name,
volumes, network, and environment as they are.

```yaml
services:
  core-hub:
    image: ghcr.io/twuijri/core-hub:latest
    ports:
      - "127.0.0.1:6060:6060"
    volumes:
      - hermes-data:/home/agent/.hermes
      - hermes-webui-data:/home/agent/.hermes-web-ui
    environment:
      HERMES_WEB_UI_HOME: /home/agent/.hermes-web-ui
      HERMES_WEBUI_STATE_DIR: /home/agent/.hermes-web-ui
    restart: unless-stopped
volumes:
  hermes-data:
  hermes-webui-data:
```

The image is public on GHCR, so `docker compose pull` needs no login. Put an HTTPS reverse proxy in
front of the container and never expose the port directly without authentication. To build the
image yourself:

```bash
docker compose -f compose.personal.yml build
docker compose -f compose.personal.yml up -d
```

Migration details, backups, and what stays untouched are in [deploy/README.md](./deploy/README.md).

### Desktop app

The desktop app is built from source (no auto-updater, no official downloads):

```bash
npm ci --ignore-scripts
npm run build:desktop:mac      # or build:desktop:win / build:desktop:linux
```

The `Manual Desktop Build` GitHub Actions workflow produces the same artifacts for macOS, Windows,
and Linux. After installing:

1. Open **Connection mode…** from the tray menu, choose **Connected to my server**, enter your
   server address, test the connection, and apply. The app restarts as a client of your server.
2. Open **Device access…** from the tray menu, paste the pairing link copied from the server's
   **Devices** page, and approve the request on the server under **Devices → Requests**.
3. Share at least one folder and enable the capabilities you want: commands, files, agent browser,
   screen. Each command asks for approval unless you choose "Always allow"; screen access asks once
   per connection and shows a Stop banner while active.

See [packages/desktop/README.md](./packages/desktop/README.md) and
[docs/DESKTOP-SERVER-MODE.md](./docs/DESKTOP-SERVER-MODE.md) (design, Arabic) for details.

## Development

Core Hub is a TypeScript monorepo: a Vue 3 client, a Koa server, an Electron desktop shell, and
agent packages. Node.js 24 is required.

```bash
npm ci --ignore-scripts
npm run harness:check     # repository conventions
npm run test              # Vitest (client, server, desktop, shared)
npm run test:e2e          # Playwright
npm run build             # client, server, and type checks
```

- [ARCHITECTURE.md](./ARCHITECTURE.md) — package boundaries and runtime flow.
- [DEVELOPMENT.md](./DEVELOPMENT.md) — commands, coding rules, and test rules.
- [AGENTS.md](./AGENTS.md) — the map coding agents read first.
- [docs/TEAM-RULES.md](./docs/TEAM-RULES.md) — contribution policy (Arabic): task branches, change
  records under `docs/changes/`, the `test` integration branch, and owner-only merges to `main`.
- [docs/KNOWLEDGE-WORKFLOW.md](./docs/KNOWLEDGE-WORKFLOW.md) — durable decisions and code knowledge.
- [docs/mobile-app-updates.md](./docs/mobile-app-updates.md) — server-side in-app updates for the
  Android test build: endpoints, error codes, and the update source settings.
- [docs/PERSONAL-FORK.md](./docs/PERSONAL-FORK.md) — fork rules and the upstream update procedure.

Updates from upstream are merged through a review branch with a license guard
(`scripts/check-personal-license.mjs`) that stops any update whose license differs from the
reviewed upstream license.

## Contributing

Pull requests are welcome for improvements that respect the license and the upstream attribution.
Every change needs a task branch, a change record, passing checks, and a pull request to `main`;
only the repository owner merges to `main`. Please read [docs/TEAM-RULES.md](./docs/TEAM-RULES.md)
before starting.

## Security

Do not open public issues for vulnerabilities; contact the maintainer privately through GitHub.
The Device Agent never listens on a port, only connects outbound to a server you paired with, and
refuses anything outside the folders and capabilities you enabled.

## License

Core Hub is distributed under the **Business Source License 1.1** of the upstream project, with
EKKOLearnAI as Licensor. Under its Additional Use Grant you may use this software for
**non-commercial purposes** — personal use, education, and research. Commercial use (including
selling, licensing, SaaS hosting, or embedding in a commercial product) requires a separate
commercial license from EKKOLearnAI. On the Change Date, **2029-05-10**, the license converts to
the Apache License 2.0.

- Full text: [LICENSE](./LICENSE)
- Derivative notice: [NOTICE.personal.md](./NOTICE.personal.md)
- Third-party licenses and contributor attribution are retained unchanged.

Core Hub does not relicense any upstream code. Hermes Agent, Ekko Agent, and the other agents
integrated by Studio remain the property of their respective authors under their own licenses.
