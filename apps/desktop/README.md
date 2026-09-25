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
```

- `src/main` — the main process: first-run window, app window, tray, menus, IPC, and the
  loopback origin (`proxy.ts`) that serves the web client and forwards `/api` and `/rt`.
- `src/preload` — the bridge (`window.corehubDesktop`), typed by the web client in
  `packages/web/src/desktop/bridge-types.ts`.
- `src/renderer` — the first-run screen.
- `src/shared` — pure logic shared by all three, unit-tested.
- `src/i18n` — the app's own words, Arabic and English (`pnpm i18n:check`).

Environment for tests and portable setups: `COREHUB_DESKTOP_USER_DATA` (where settings and
each hub's storage live), `COREHUB_DESKTOP_NO_TRAY=1`, `COREHUB_DESKTOP_WEB_DIR`,
`COREHUB_DESKTOP_DEVTOOLS=1`.
