# ADR 0020 — The desktop app is an Electron shell around the bundled web client

Status: **proposed — owner to confirm** (2026-09-25). Written while the owner was away
(«كمل كل الشغل … اي قرار تحتاجه مني اجله»); every choice below can be reversed before the
first installer is published.

## Context
ADR 0009 fixes what the desktop app is — the web client in a shell, remote or local mode,
never bundling Hermes — but not what the shell is made of. Two shells fit:

- **Electron**: Chromium and Node in one runtime. The main process is Node, so local mode
  can run the hub (`packages/server`) with the runtime the app already carries
  (`ELECTRON_RUN_AS_NODE`), and the window is the same engine the web client is tested
  with (Playwright's Chromium).
- **Tauri**: a Rust shell over the operating system's own web view (WebView2 on Windows,
  WKWebView on macOS, WebKitGTK on Linux). The shell is small, but local mode needs a Node
  runtime next to it (a sidecar), and the page is drawn by three different engines.

The owner's size rule (`docs/ROADMAP.md` §Sizes): what people download should stay in the
low hundreds of MB, less is better, and anything above must buy a real feature.

Measured on this machine (Linux x64, 2026-09-25):

| Piece | Size |
|---|---|
| Electron 44.4.5 runtime, as downloaded (zip) | 123.0 MB |
| Electron 44.4.5 runtime, `tar | xz -6` | 91.8 MB |
| Node 24.21.0 binary (what a Tauri sidecar would carry), `xz -6` | 29.9 MB |
| The web client the app serves, without source maps | 1.6 MB |

Tauri itself was **not measured**: this machine has no Rust toolchain, and adding one to
the repository's build only to measure it was not worth it. Its shell is commonly a few
MB; with the Node sidecar local mode needs, a Tauri installer would land around 35–45 MB
before the hub's own dependencies, against roughly 95–110 MB for Electron. The installer
sizes actually produced are reported by the packaging change (PR 4 of the desktop work).

## Decision (proposed)
1. **Electron**, pinned to an exact version (`44.4.5`), is the shell.
2. The app serves the **bundled** web client from a loopback origin it owns
   (`http://127.0.0.1:<port>`, the port kept across launches so the web client's storage
   survives) and forwards `/api` and `/rt` — requests, server-sent events and WebSocket
   upgrades — to the hub of the current mode. The web client stays same-origin and
   unchanged; no hub needs CORS; no token crosses an origin. Requests whose `Host` is not
   the loopback address are refused (DNS rebinding).
3. Each hub gets its own storage partition (`persist:hub-<hash of its origin>`), so a
   sign-in never reaches another hub and switching hubs or modes keeps each one's data.
4. The web client learns it is on the `desktop` surface from a bridge the preload puts on
   `window` (`corehubDesktop`, typed by the web client in
   `packages/web/src/desktop/bridge-types.ts`). `navigation.json` gives the desktop its
   routes as `"$extends": "web"` plus `this_device`, so a destination is added once.
5. Windows are sandboxed with context isolation and no Node; the main process checks the
   sender of every IPC call; only notifications and the clipboard are granted; any other
   origin opens in the system browser.
6. `corehub://` links: `open/<app path>`, `connect?hub=` (fills the address, never
   connects by itself) and `pair?hub=&id=&code=` (asks before pairing). Only an installed
   app registers the scheme.

## Alternatives rejected
- **Tauri**: ~55–65 MB smaller, but local mode needs a Node sidecar anyway (so the gap
  narrows to the Chromium engine), three rendering engines to test the Arabic/RTL layout
  on instead of one, WebKitGTK's weaker support on Linux, and a Rust toolchain in every
  build. Worth revisiting if the size ever becomes the reason people do not install it.
- **Loading the hub's own web client** (`loadURL(hubUrl)`) instead of the bundled one: no
  proxy needed, but the desktop's `this_device` page and bridge would depend on whatever
  build the hub serves, and local mode would need the hub's port to be stable anyway.
- **A custom protocol (`app://`) for the page**: WebSockets cannot be served from a custom
  protocol, so the realtime channel would fall back to long polling.
- **A configurable API base in the web client plus CORS on the hub**: a change to every
  hub for the benefit of one client, and bearer tokens crossing origins.

## Consequences
- The installer carries Chromium: roughly 95–110 MB compressed on each platform, inside
  the owner's rule but not small.
- `electron` is excluded from install scripts (`pnpm-workspace.yaml` `allowBuilds`); the
  desktop jobs download the runtime with `pnpm --filter @corehub/desktop electron:install`.
- Native modules of the embedded hub (`better-sqlite3`, `argon2`) must be built for
  Electron's ABI when local mode is packaged.
- Code signing and notarisation are not done; the owner decides (PR 4).
