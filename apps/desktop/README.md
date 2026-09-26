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

Installers (ADR 0023): AppImage + deb on Linux, dmg (+ the zip macOS updates from) on macOS, NSIS
and the Microsoft Store MSIX on Windows (`COREHUB_CHANNEL=store pnpm --filter @corehub/desktop
package --win`; that build never checks GitHub for updates), unsigned on pull requests. Packaging
also writes the update feeds (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) that
`release-assets.mjs` puts on the release.

Updates (DECISIONS §109, `src/shared/updates.ts` decides): the Windows `.exe`, the macOS app and the
AppImage use electron-updater (`src/main/auto-update.ts`) — about ten seconds after start and every
six hours they read the latest release's feed, download a newer version in the background, and
the page shows *Restart to update* / *Later* (`packages/web/src/desktop/UpdateNotice.tsx`); nothing
restarts on its own, and a downloaded version is installed on quit. The `.deb` (and a development
run) only asks GitHub's releases API and links the download page (`src/main/updates.ts`). The Store
build never looks. *Check for updates…* sits in the app menu (macOS), Help (Windows, Linux) and the
tray; the switch is in Settings → This device (`desktop.json`, `updates.auto`). A real update can
only be tried between two published releases that carry the feeds (1.1.3 → the next). A `v*` tag's GitHub release gets
them from `.github/workflows/publish-release.yml`; names and notes: `scripts/release-assets.mjs`. `COREHUB_VERSION` stamps the version; without it the app carries the root
`package.json` version, like every Core Hub deliverable (`docs/RELEASING.md`). CI builds all three in
`.github/workflows/desktop.yml` as artifacts; nothing is published. The macOS dmg signed with
Developer ID and notarised comes from `.github/workflows/desktop-signed.yml` (by hand or a release
tag; `docs/RELEASING.md`): packaging signs only when `CSC_LINK` is set. Windows signing is not set
up. The icons in `assets/` (window, tray, `icon.icns`, `icon.ico`, `icons/NxN.png` for Linux, `appx/` Store tiles) are
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
`COREHUB_DESKTOP_SMOKE_EXECUTABLE` (run the smoke journeys against a packaged app),
`COREHUB_CHANNEL=store` (behave as the Microsoft Store build: no update check).

Between the app and its local hub (not for people to set): `COREHUB_DESKTOP_PORT` (the port the
hub used last, asked for again so a Cloudflare tunnel keeps pointing at it) and the IPC messages
of `src/shared/hub-ipc.ts` (the way in from outside, DECISIONS §95). The app keeps `cloudflared`,
fetched on first use at the version and SHA-256 pinned in `src/shared/relay.ts`, in
`<app data>/tools`.
