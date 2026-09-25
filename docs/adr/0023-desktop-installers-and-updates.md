# ADR 0023 — Desktop installers, and an update check that only tells

Status: **proposed — owner to confirm** (2026-09-25). Builds on ADR 0020–0022.

## Context
The desktop app needs installers people can download, and a way to learn a newer one exists.
The owner's rules: what people download should stay in the low hundreds of MB
(`docs/ROADMAP.md` §Sizes); releases and signing are his decisions (TEAM-RULES §1, §6); no
silent auto-update without his decision.

## Decision (proposed)
1. **electron-builder 26** builds, per platform: **AppImage and .deb** on Linux (x64), a
   **.dmg** for Apple silicon (arm64) on macOS — not Intel: `argon2` 0.45 ships no darwin-x64
   binary, so an Intel build could not run local mode — an **NSIS** installer on Windows (x64,
   per-user, directory selectable). Configuration: `apps/desktop/electron-builder.config.cjs`;
   command: `pnpm --filter @corehub/desktop package` after `pnpm build`.
2. The app archive holds only the bundled main process, preload, first-run screen and web
   client — no `node_modules`. The embedded hub (ADR 0021) sits beside it in
   `resources/hub`, and an `afterPack` hook keeps only the installer's own platform's SQLite
   and argon2 binaries. Chromium's strings are kept for Arabic and English only.
3. `corehub://` is declared by the Linux `.desktop` entry and registered by the app itself on
   macOS and Windows once installed.
4. **CI builds installers without publishing**: `.github/workflows/desktop.yml` runs on
   changes to `apps/desktop` (and by hand, with a version to stamp), keeps the files as
   14-day workflow artifacts, writes their sizes to the job summary, and on Linux runs the
   smoke journeys against the packaged app. Attaching them to a GitHub release stays the
   owner's step.
5. **Code signing is a TODO for the owner**: no Apple Developer ID / notarisation and no
   Windows Authenticode certificate are configured. Unsigned builds open with a Gatekeeper /
   SmartScreen warning.
6. **The update check** reads `api.github.com/repos/twuijri/core-hub/releases` (no token,
   nothing sent but the app's version in the User-Agent), on its own at most once a day
   (a switch in This device turns that off) and whenever the person presses "Check now". A
   release counts when published, newer, and carrying an installer for this platform and
   architecture; pre-releases are offered only to a pre-release app (the `test` channel). The
   answer is a notice — in This device, and once per version from the OS — with a link to the
   installer and the release notes. **Nothing is downloaded or installed by the app.**

## Measured (Linux x64, this machine, 2026-09-25, version 0.0.0)
| Installer | Size |
|---|---|
| `Core-Hub-0.0.0-x86_64.AppImage` | 125.8 MB |
| `corehub_0.0.0_amd64.deb` | 99.9 MB |

Of the unpacked 298 MB → ~290 MB after pruning, 219 MB is the Electron binary itself; the
app's own part (web client, main process, embedded hub) is ~16 MB. macOS and Windows sizes
come from the first run of the workflow.

## Alternatives rejected
- **electron-updater (silent background updates)**: needs signed builds on macOS, a feed
  published with every release, and it installs without asking — the owner has not decided
  that.
- **The hub's own `updates` shelf** (`updates.*` in the contract): right for phones that talk
  to one hub, but in local mode the hub is the app, and a remote hub may lag the app's
  releases. The GitHub check works in both modes; the shelf can be added as a second source.
- **Squirrel.Windows / MSI**: NSIS is electron-builder's default, installs per user without
  admin rights, and lets the person pick the folder.
