# ADR 0021 — Local mode: the embedded hub, and the Hermes it finds

Status: **proposed — owner to confirm** (2026-09-25). Builds on ADR 0008, ADR 0009 and
ADR 0020.

## Context
ADR 0009 says local mode runs "an embedded hub on the machine" with `DATA_DIR` under the OS
app-data folder, uses an existing Hermes install when there is one, and otherwise offers
Hermes's own installer — never carrying Hermes. It leaves open how the hub is carried and
started, what "uses the existing install" means for Hermes's data, and how the installer is
run.

What was found while building it:
- The server's two native modules (`better-sqlite3` 13, `argon2` 0.45) are N-API and ship
  prebuilt binaries for Linux, macOS and Windows in their npm packages. Electron 44's Node
  loads them unrebuilt (checked with `ELECTRON_RUN_AS_NODE`).
- The hub already decides by itself how to reach Hermes (ADR 0008): a gateway answering on
  8642 is used as it is (`external`); a `hermes` program on `PATH` is run as a child with the
  home `${DATA_DIR}/hermes` (`managed`); otherwise Hermes is shown as not installed.
- Hermes's installers (`install.sh`, `install.ps1` on hermes-agent.nousresearch.com) put the
  program in `~/.local/bin` (Windows: `%LOCALAPPDATA%\hermes\bin`) and the home in `~/.hermes`
  (`%LOCALAPPDATA%\hermes`), accept `--non-interactive` / `-NonInteractive` to skip their setup
  wizard, and `--skip-browser` / `-SkipBrowser`.

## Decision (proposed)
1. **The hub is carried as one bundle** (`dist/hub`: the server's code as a single ES module,
   its migrations, the contract files, and the two native modules with their prebuilt
   binaries) outside the app archive, and started as a child process with Electron's own
   Node. No second Node runtime, no rebuild step.
2. **It listens on 127.0.0.1 only**, on a free port, and does not serve the web client (the
   app does, ADR 0020). Its data is `<app data>/local-hub`, apart from each remote hub's
   storage partition; the window uses the partition `persist:local`.
3. **"Uses the existing install" means the program, not the home.** The app finds the
   `hermes` program (PATH, then the installers' places, per platform) and puts its folder
   first on the hub's `PATH`; the hub then runs it with its own home under `local-hub`
   (ADR 0008 `managed`). A gateway already running is used as it is (`external`). Sharing
   `~/.hermes` itself was rejected: Hermes warns against two gateways on one home, and the
   person's own Hermes may be running on it. Provider keys are added once in Core Hub
   (ADR 0010), which writes them into the hub's Hermes home.
4. **Installing Hermes** downloads Hermes's own script from its site at the moment the person
   presses the button (the screen shows exactly what will run), saves it to a temporary file
   and runs it with an argument array (`--non-interactive --skip-browser`), streaming its
   output. Then the app looks again and starts local mode. Nothing of Hermes is ever in the
   installer.
5. **Local mode also starts without Hermes**, when the person says so: the hub works, and its
   agents show Hermes as not installed until it is.
6. A hub that stops on its own is not restarted in a loop: the app returns to the first-run
   screen and says so. Quitting the app stops the hub (SIGTERM, then SIGKILL after 10 s).

## Alternatives rejected
- **Rebuilding native modules for Electron** (`@electron/rebuild`): unnecessary with N-API
  prebuilds, and it would need a compiler on every build machine.
- **`pnpm deploy` of the server with its `node_modules`**: 99 MB of symlinked store to ship
  and dereference, against 28 MB for the bundle (17 MB of it the SQLite binaries of every
  platform, which packaging prunes to one).
- **Using `~/.hermes` as the hub's Hermes home**: see decision 3.
- **Piping the installer into a shell** (`curl … | bash`): the same script, but without the
  chance to show and log what runs, and a shell string instead of arguments.

## Consequences
- Local mode on a machine with Hermes's gateway already running uses that gateway; the hub's
  API key must match it (ADR 0008 `external`), which a personal Hermes will not have — the
  agents page then says Hermes refused. Documented as a known limit.
- `COREHUB_DESKTOP_HERMES_GATEWAY` points the app's own check at another address (a gateway
  on another port, or none in a test).
