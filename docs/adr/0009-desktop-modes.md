# ADR 0009 — The desktop app has two modes and never bundles Hermes

Status: accepted (2026-09-21, owner decision)

## Context
The owner wants the desktop installer small (see the size rule in
`docs/ROADMAP.md` §Sizes) and wants people who already run Hermes Agent on
their machine to keep using that install rather than get a second copy.

## Decision
The desktop app (`apps/desktop`, the web client in a shell plus local
capabilities) ships **without** Hermes and offers two modes at first run:

1. **Local mode.** The app runs an embedded hub on the machine
   (`DATA_DIR` under the OS app-data folder) and needs a Hermes runtime:
   - if a Hermes install is already present (Hermes's own home directory
     and CLI on the PATH, or a gateway answering on its port), the app uses
     it as an *external* runtime (ADR 0008 mode `external`) — no duplicate;
   - otherwise the app offers "Install Hermes", which runs Hermes's own
     official installer from Hermes's site/repository into Hermes's own
     home, then adopts it. The app never carries a Hermes copy of its own.
2. **Remote mode.** The app connects to a Majlis hub on a server (pairing
   by QR or sign-in) and works entirely against that hub, exactly like the
   web client. A small **local helper** inside the app exposes the machine
   to the hub as MCP tools: control of the desktop and of local programs
   (editing suites and the like), local files the user allows. The helper is
   optional, off by default, and shows what it exposes.

The user can switch modes later; the data of each mode stays separate.

## Consequences
- `apps/desktop` depends only on `packages/contracts` and the web client;
  the embedded hub is the same `packages/server` build.
- The Hermes adapter's discovery (`agents.discover`, the runtime probe in
  ADR 0008) must detect an existing Hermes reliably on macOS, Windows and
  Linux; that detection gets its own tests.
- The local helper is an MCP server with its own manifest of tools and a
  permission screen; it is the only place local-machine capabilities live.
- Installer size target: small enough to download casually (the owner's
  rule: what a person downloads should stay in the low hundreds of MB, and
  any excess must buy a real feature).
