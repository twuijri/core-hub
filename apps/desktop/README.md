# @corehub/desktop

The Core Hub desktop app: the web client (`packages/web`) in an Electron shell, in the two
modes of ADR 0009. Why Electron and how the window reaches the hub: ADR 0020.

```bash
pnpm install --frozen-lockfile
pnpm --filter @corehub/desktop electron:install   # the Electron runtime (~100 MB, once)
pnpm build                                          # web client first, then dist/ here
pnpm --filter @corehub/desktop exec electron .      # run it
pnpm --filter @corehub/desktop test                 # unit tests (no Electron needed)
xvfb-run -a pnpm --filter @corehub/desktop test:smoke   # Electron against the e2e hub
pnpm --filter @corehub/desktop package              # this platform's installers → release/
```

Installers (ADR 0023): AppImage + deb on Linux, dmg on macOS, NSIS on Windows, unsigned on
pull requests. `COREHUB_VERSION` stamps the version. CI builds all three in
`.github/workflows/desktop.yml` as artifacts; nothing is published. The macOS dmg signed with
Developer ID and notarised comes from `.github/workflows/desktop-signed.yml` (by hand or a release
tag; `docs/RELEASING.md`): packaging signs only when `CSC_LINK` is set. Windows signing is not set
up. The icons in `assets/` (window, tray, `icon.icns`, `icon.ico`, `icons/NxN.png` for Linux) are
generated from the Core Hub mark by `pnpm icons:build` at the repository root; never edit them by
hand.

- `src/main` — the main process: first-run window, app window, tray, menus, IPC, and the
  loopback origin (`proxy.ts`) that serves the web client and forwards `/api` and `/rt`.
- `src/preload` — the bridge (`window.corehubDesktop`), typed by the web client in
  `packages/web/src/desktop/bridge-types.ts`.
- `src/renderer` — the first-run screen.
- `src/shared` — pure logic shared by all three, unit-tested.
- `src/i18n` — the app's own words, Arabic and English (`pnpm i18n:check`).

Environment for tests and portable setups: `COREHUB_DESKTOP_USER_DATA` (where settings and
each hub's storage live), `COREHUB_DESKTOP_NO_TRAY=1`, `COREHUB_DESKTOP_WEB_DIR`,
`COREHUB_DESKTOP_DEVTOOLS=1`, `COREHUB_DESKTOP_NO_AUTO_UPDATE=1`,
`COREHUB_DESKTOP_HERMES_GATEWAY` (where to look for a running Hermes gateway),
`COREHUB_DESKTOP_SMOKE_EXECUTABLE` (run the smoke journeys against a packaged app).
