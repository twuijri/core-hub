# Releasing and signing the apps

Who does what: building is automatic; **publishing is the owner's step** (TEAM-RULES §6). The
owner pushes a `v*` tag (or runs *Publish release* for an existing one); from there the GitHub
release is made by `publish-release.yml` (below). Nothing here uploads to a store, except
TestFlight when the owner ticks it on a manual run; the Microsoft Store upload is done by hand in
Partner Center.

## Where each platform ships (owner, 2026-09-25)

| Platform | Ships as | Signed | Updates |
|---|---|---|---|
| Windows | `.exe` (NSIS) on the GitHub release | no (SmartScreen: *More info → Run anyway*) | the app's own GitHub check |
| Windows | Microsoft Store (MSIX) | by the Store | the Store; the app's check is off |
| macOS | notarised `.dmg` on the GitHub release (`desktop-signed.yml`) | Developer ID | the app's own GitHub check |
| Linux | AppImage and `.deb` on the GitHub release | no | the app's own GitHub check |
| Android | signed `.apk` on the GitHub release; Google Play later | test key | — |
| iOS | TestFlight / App Store only, no file on the release | App Store | the App Store |

The Mac App Store is not planned.

## One version (owner, 2026-09-26)

Every Core Hub deliverable carries **one version**: the root `package.json` `version`, starting
at **1.1.0** — the hub (`/api/v1/health`, `/api/v1/meta`, the image's
`org.opencontainers.image.version`), the web client's printed version, the desktop app, the
Android `versionName` and the iOS `CFBundleShortVersionString`. It starts at 1.1.0 because the
old fork's apps used the same ids and reached 1.0.2 on TestFlight; the new ones must be newer.

Where it lives:

| Deliverable | Reads it from |
|---|---|
| Hub | `COREHUB_VERSION` when the image stamps it, else the root `package.json` (the server's own `package.json` in the desktop app's embedded hub) |
| Web client | `COREHUB_VERSION` at build time, else the root `package.json` (`packages/web/vite.config.ts`) |
| Image | `ARG COREHUB_VERSION` in `packages/server/Dockerfile` (default = the root version); `release.yml` passes the tag's version, or `<version>-preview.<run>` for a manual run |
| Desktop | `COREHUB_VERSION` (a tag, or the `version` input), else the root `package.json` (`apps/desktop/scripts/package.mjs`) |
| Android `versionName` | the root `package.json`, read by Gradle (`apps/android/app/build.gradle.kts`) |
| iOS `MARKETING_VERSION` | `apps/ios/project.yml` — a copy, because XcodeGen cannot read JSON |

The root version is a plain `X.Y.Z` (the App Store takes nothing else). **`pnpm version:check`**
(`scripts/version-check.mjs`, run in CI's "Lint, typecheck, contracts, client tests, build" job)
fails when a workspace `package.json`, the iOS `MARKETING_VERSION` or the Dockerfile default
differs from it, when Android's `versionName` is written out instead of read, and — on a `v*`
tag (the release and signed workflows run it there) — when the tag says another version.

To release: bump the root `package.json` only, run `pnpm version:check --write` (it copies the
version into every place above that keeps a copy), commit through a pull request, and once it is
on `main` tag that commit `vX.Y.Z` (the owner's step).

**Build numbers.** The signed workflows set Android's `versionCode` and iOS's
`CURRENT_PROJECT_VERSION` (`CFBundleVersion`) to the workflow's run number **+ 100**, computed in
a step (GitHub expressions cannot add), so every build is newer than the last and newer than the
old app's builds under the same ids (up to 63). A local or pull-request build is 1.

## App identity (owner, 2026-09-25)

| Platform | Identifier |
|---|---|
| Android `applicationId` | `com.twuijri.corehub` (the Kotlin packages stay `hub.core.android`, the `namespace`) |
| iOS app | `com.twuijri.corehub` |
| iOS share extension | `com.twuijri.corehub.share` |
| iOS App Group | `group.com.twuijri.corehub` |
| Desktop (`appId`, macOS bundle id) | `com.twuijri.corehub` |
| Apple team | `58QWJ228ZE` |
| Firebase project | `core-hub-66772` (Android app `com.twuijri.corehub`) |

The hub's APNs sender (`COREHUB_APNS_BUNDLE_ID`, or Device connections → Push senders) takes
`com.twuijri.corehub`.

## Pull requests stay unsigned

`android.yml`, `ios.yml` and `desktop.yml` build on every pull request without any secret, as
before: a debug APK, the iOS simulator build and tests, and unsigned installers. A fork builds
the same way. Android applies the Firebase plugin only when `apps/android/app/google-services.json`
exists (it is git-ignored), and signs a release only when `COREHUB_ANDROID_KEYSTORE` is set;
electron-builder signs macOS only when `CSC_LINK` is set.

## Signed builds

Three workflows, each run **only** by hand (Actions → Run workflow) or by a `v*` tag on `main`
— never on a pull request. `ios-signed.yml` runs on the tag itself; `android-signed.yml` and
`desktop-signed.yml` run on it through `publish-release.yml`, which calls them and attaches their
files to the release. On a manual run the signed files are kept as workflow artifacts only when
`keep_artifacts` is ticked: the repository is public, so anyone signed in to GitHub can download
an artifact. A release keeps them for 14 days. A release's Android `versionCode` is
*Publish release*'s run number **+ 1000**, so it is always newer than a build made by hand
(+ 100).

| Workflow | Makes | Secrets |
|---|---|---|
| `android-signed.yml` | signed `app-release.apk` + `app-release.aab`, Firebase configured | `ANDROID_TEST_KEYSTORE_B64`, `ANDROID_TEST_KEYSTORE_PASSWORD`, `ANDROID_TEST_KEY_ALIAS`, `ANDROID_TEST_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON` |
| `ios-signed.yml` | App Store archive and `.ipa` (app + share extension); TestFlight when `upload_testflight` is ticked, then the TestFlight groups in `testflight_groups` (default `Owner`) | `IOS_CSC_LINK`, `IOS_CSC_KEY_PASSWORD`, `ASC_API_KEY_ID`, `ASC_API_KEY_P8`, `ASC_API_ISSUER_ID` |
| `desktop-signed.yml` | macOS dmg signed with Developer ID and notarised | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

How each handles its secrets: they reach only the steps that need them, as environment
variables; files are written with `printf %s` into the runner's temp folder (the Firebase file
where its Gradle plugin reads it) and removed in an `always()` step; nothing prints a value; the
Android job keeps no Gradle cache.

### Android

The keystore (`ANDROID_TEST_*`) is a test key, not a Play upload key. `versionCode` is the
workflow's run number + 100 (`COREHUB_ANDROID_VERSION_CODE`, see One version above).
`GOOGLE_SERVICES_JSON` is the file Firebase gives for the Android app (as JSON, or base64); the
Google Services plugin refuses a file without a client for `com.twuijri.corehub`. Only a build
with that file has push: after sign-in the app takes an FCM token and registers it with the hub
(`devices.registerPush`), and a tapped push opens the page its notice is about. Any other build
(a pull request, a fork, a local debug build) links Firebase Messaging but never starts it, says
on This device that it has no push, and keeps the 15-minute background check.

A developer who wants the same locally: put `google-services.json` in `apps/android/app/`, and
export `COREHUB_ANDROID_KEYSTORE` (a path), `COREHUB_ANDROID_KEYSTORE_PASSWORD`,
`COREHUB_ANDROID_KEY_ALIAS` and `COREHUB_ANDROID_KEY_PASSWORD` before
`./gradlew assembleRelease bundleRelease`.

### iOS

1. The Apple Distribution certificate (`IOS_CSC_LINK`, a base64 `.p12`) goes into a temporary
   keychain, deleted at the end.
2. `apps/ios/scripts/asc-profiles.mjs` signs in to the App Store Connect API with the key
   (`ASC_API_*`), finds that certificate in the team, and reuses or creates one App Store
   profile per bundle id (named `CoreHub CI <bundle id> <certificate id>`). It never deletes
   anything. Why not only `-allowProvisioningUpdates`: with automatic signing, `xcodebuild
   archive` signs for development first, which needs a development certificate on the runner
   and devices registered in the team; the App Store profiles need neither.
3. `xcodebuild archive` (manual signing, those profiles) and `xcodebuild -exportArchive`
   (`app-store-connect`) run with `-allowProvisioningUpdates` and the same key
   (`-authenticationKeyPath/ID/IssuerID`), so Xcode can fetch anything missing itself.
   `CFBundleVersion` is the workflow's run number + 100; `CFBundleShortVersionString` is
   `project.yml`'s `MARKETING_VERSION` (the root version) unless a manual run gives `version`.
4. The job checks both bundle ids, the entitlements (the App Group, and `aps-environment`
   `production`, which push needs) and the signature.
5. `upload_testflight` (a manual run only, off by default) uploads with `xcrun altool` and the
   same key.
6. After the upload, `apps/ios/scripts/testflight-distribute.mjs` adds the build to the TestFlight
   groups named in `testflight_groups` (comma-separated, default `Owner`; empty adds none). App
   Store Connect adds builds to an internal group by itself only when they come from Xcode's own
   upload ("Automatic for Xcode Builds"), not from altool, so without this step each build had to
   be added by hand. With the same key it finds the app by bundle id, waits until App Store
   Connect has processed the build (`processingState` `VALID`), and adds it to each group.
   - **Internal groups** (such as `Owner`) get the build straight away; no review.
   - **External groups** get it too, but their testers see it only after **Beta App Review**
     approves it. The workflow never submits for review; that stays the owner's step in App Store
     Connect.
   - **Slow processing**: after 30 minutes the step stops waiting and leaves a warning, not a
     failure; the upload succeeded, and the build can be added by hand (TestFlight → the group →
     Builds → +).
   - **Missing export compliance** (`MISSING_EXPORT_COMPLIANCE`) is a warning: the app declares
     `ITSAppUsesNonExemptEncryption = false`, so it should not happen; if it does, answer it on the
     build in TestFlight. The build is still added and becomes installable once answered.
   - A build Apple rejected, an unknown app or an unknown group name fails the step; the error
     lists the app's groups.

   The script's tests run in CI (`pnpm scripts:test`) against a fake App Store Connect.

On a developer's Mac, Xcode signs automatically with team `58QWJ228ZE`
(`DEVELOPMENT_TEAM` in `apps/ios/project.yml`).

### Desktop (macOS)

electron-builder's own variables: `CSC_LINK`/`CSC_KEY_PASSWORD` (from `MAC_CSC_*`, a Developer ID
Application `.p12`) sign the app with the hardened runtime, and `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` notarise it with `notarytool` and staple the
ticket. The job checks `codesign`, Gatekeeper (`spctl`) and the stapled ticket. Windows and Linux
installers stay unsigned (`desktop.yml`).

## What the owner does in the consoles

- **App Store Connect API key**: role *Admin*, or *App Manager* with access to Certificates,
  Identifiers & Profiles — the job creates the App Store profiles.
- **App IDs**: `com.twuijri.corehub` (Push Notifications, App Groups) and
  `com.twuijri.corehub.share` (App Groups), each with `group.com.twuijri.corehub` **assigned**
  in its App Groups configuration; a profile carries only the groups assigned there.
- **TestFlight**: an app record in App Store Connect for `com.twuijri.corehub`. The app icon
  App Store Connect requires is in the app (`apps/ios/CoreHub/Resources/Assets.xcassets`, made by
  `pnpm icons:build`).
- **Play**: nothing yet; the signed AAB is ready for an internal-testing track when the owner
  decides. The listing's 512 px icon is `apps/android/store/icon-512.png`.

## App Store submission

Owner's decision (2026-09-25): the iPhone app goes to the App Store (no Mac App Store; Google Play
later). The listing, screenshots, privacy policy and review notes are prepared in the repository
([docs/store/apple/README.md](store/apple/README.md)); **submitting is always the owner's own step
in App Store Connect**. No workflow submits for review.

Once, and again when the listing or the screenshots change:

1. **Listing and screenshots.** Actions → *iOS store screenshots* → Run workflow on `main`. Look
   at the artifact `corehub-store-screenshots`; when they are right, run it again with **upload**
   ticked. It sends the listing (`apps/ios/fastlane/metadata`) and the light screenshots to the
   version (the root version, or the `version` input), creating that version in App Store Connect
   if it is missing. For text alone: *iOS store listing* with **upload**.
2. **App Privacy** (App Store Connect → the app → App Privacy): "No, we do not collect data from
   this app", and the privacy policy URL
   `https://github.com/twuijri/core-hub/blob/main/docs/privacy.md` (the checklist:
   [docs/store/apple/README.md → App Privacy](store/apple/README.md#app-privacy-nutrition-label)).
3. **Age rating** (App Information → Age Rating): the answers in
   [docs/store/apple/README.md → Age rating](store/apple/README.md#age-rating-answers-to-app-store-connects-questionnaire).

For each version:

1. **A build.** Actions → *iOS signed build* → Run workflow with **upload_testflight** ticked.
   The run waits until App Store Connect has processed the build and adds it to the `Owner`
   TestFlight group (or the groups in **testflight_groups**), so it reaches the owner's devices
   without adding it by hand.
2. **Pick the build.** App Store Connect → the app → the version in "Prepare for Submission" →
   **Build** → choose the build from TestFlight.
3. **App Review Information.** Tick **Sign-in required** and enter the demo account's username
   and password (only there, never in the repository). Paste the notes from
   [docs/store/apple/review-notes.md](store/apple/review-notes.md) into **Notes**, with the demo
   hub's address in place of `<DEMO_HUB_URL>`, and fill in the contact (name, phone, email).
   Check first that the demo hub answers and its model replies.
4. **Export compliance.** Nothing to answer: the app declares `ITSAppUsesNonExemptEncryption =
   false` (`apps/ios/project.yml`), so App Store Connect does not ask.
5. **Version details.** Check the version's text and screenshots, and the release choice
   (manual or automatic after approval).
6. **Add for Review**, then **Submit to App Review** on the page that follows.

## The GitHub release (`publish-release.yml`)

On a `v*` tag on `main`, one workflow builds every file of the release and then, in its last job
(the only one with `contents: write`, through `GITHUB_TOKEN`), creates the tag's GitHub release —
or updates it if it exists — attaches the files and marks it **latest**:

| File on the release | Built by |
|---|---|
| `Core-Hub-Setup-X.Y.Z-x64.exe` | `desktop.yml` (Windows, NSIS, unsigned) |
| `Core-Hub-X.Y.Z-x64.msix` | `desktop.yml` (Windows, the Store package, unsigned) |
| `Core-Hub-X.Y.Z-arm64.dmg` | `desktop-signed.yml` (signed and notarised) |
| `Core-Hub-X.Y.Z-x86_64.AppImage`, `corehub_X.Y.Z_amd64.deb` | `desktop.yml` (Linux) |
| `Core-Hub-X.Y.Z-android.apk` | `android-signed.yml` (Gradle's `app-release.apk`, renamed) |

The names are fixed in one place, `apps/desktop/scripts/release-assets.mjs`, and a unit test
(`apps/desktop/tests/unit/release-assets.test.ts`) keeps them equal to electron-builder's
`artifactName`s and to what the app's update check picks (`assetFor` in
`apps/desktop/src/shared/updates.ts`: the `.exe` on Windows — never the `.msix` —, the dmg on
macOS, the AppImage, else the `.deb`, on Linux). The app reads GitHub's release list, not
electron-updater's `latest*.yml`, so no such file is made. The job refuses to publish when any
file is missing.

The notes are short and in English: the downloads, the SmartScreen step for the `.exe`, and the
titles of the pull requests merged since the previous version tag (GitHub's own *generate release
notes* list, at most 20, with the full-changelog link).

One workflow with job dependencies, not `workflow_run`: the release job starts only when every
build of the same run succeeded, for the tag's commit, and reads their artifacts directly. The
image (`release.yml`) and iOS (`ios-signed.yml`) still run on the tag on their own.

**An existing tag** — Actions → *Publish release* → *Run workflow* on `main`, `tag` = e.g.
`v1.1.0`. It builds that tag's code with the workflows on `main`. A tag whose code predates the
Microsoft Store package (**v1.1.0** does) gets its release without the `.msix`, and its notes say
the Store package starts with a later version. For the Store, release a version made after this
change (for example 1.1.1: bump the root `package.json`, `pnpm version:check --write`, merge, tag).

## Windows

### The `.exe` (unsigned)

The NSIS installer is not code-signed, so Windows SmartScreen may say *Windows protected your PC*:
**More info → Run anyway**. The release notes say so. It keeps the app's own update check
(GitHub releases, ADR 0023). For later: [SignPath Foundation](https://signpath.org) signs open
source projects for free; that would remove the warning.

### Microsoft Store (MSIX)

The product in Partner Center (public values, in `apps/desktop/electron-builder.config.cjs`):

| | |
|---|---|
| Identity Name | `AbdulazizAltuwijri.CoreHub` |
| Publisher | `CN=814A0A23-0E7E-4406-8883-4E483DF08BDA` |
| Publisher display name | `Abdulaziz Altuwijri` |
| Store ID | `9MT62R5V3P5N` |
| Package family name | `AbdulazizAltuwijri.CoreHub_ndbdgnrvvdj6j` |

- electron-builder's `appx` target makes it: display name *Core Hub*, languages `en-US` and `ar`,
  the brand tiles in `apps/desktop/assets/appx` (made by `pnpm icons:build`, each at 100/200/400 %
  and the taskbar sizes), the `corehub://` protocol, x64, Windows 10 1809 or later.
- Version `X.Y.Z.0` (`msixVersion` in `release-assets.mjs`): the Store keeps the fourth part and
  requires it to be 0. A preview suffix is dropped.
- It is a second packaging run, `COREHUB_CHANNEL=store pnpm --filter @corehub/desktop package
  --win` (`scripts/package.mjs`), which stamps `corehubChannel: store` into the app. That build
  never checks GitHub (and Electron's `process.windowsStore` turns the check off inside any MSIX
  too); This device → Updates says *Updates come from the Microsoft Store* and links the Store
  page.
- Unsigned: the Store signs what it publishes. Windows installs only a signed package, so the
  `.msix` on the release is the file to upload to Partner Center (and to sign yourself for a
  sideload test), not for people to install.

**Checked on every pull request** (`desktop.yml`, Windows job): the manifest (identity,
publisher, `X.Y.Z.0`, both languages, protocol, tiles, `runFullTrust`) and the store stamp inside
the app; then a copy signed with a throwaway certificate for the same publisher is installed,
its package family name must equal Partner Center's, and it is started as Windows starts a Store
app, in local mode: the embedded hub must answer `/api/v1/health` and write its database.

**How the app behaves inside the MSIX** (desktop bridge, full trust, file-system virtualisation).
The first point is what the pull-request run shows; the Hermes points follow from how Microsoft
documents MSIX virtualisation and are not run in CI (they need Hermes's installer and network):

- *The embedded hub* runs from the read-only install folder (`WindowsApps`) but writes only to its
  data folder, `%APPDATA%\Core Hub\local-hub`. Inside the package Windows redirects that to the
  package's own folder, `%LOCALAPPDATA%\Packages\AbdulazizAltuwijri.CoreHub_ndbdgnrvvdj6j\LocalCache\Roaming\Core Hub`
  — writable, and seen the same way by the app and the hub it starts. **Uninstalling the Store app
  deletes that folder**, and with it the local hub's data (the `.exe` build keeps it).
- *Hermes already installed* (by its own installer, outside the app) is found: the app reads the
  real `%LOCALAPPDATA%\hermes` and PATH through the merged view.
- *Install Hermes from the app* runs Hermes's installer as a child of the app, so it runs inside
  the package too: what it writes under `%LOCALAPPDATA%` and its PATH change (`HKCU`) are the
  package's private copies. The app and its hub see that Hermes; a terminal outside does not, and
  uninstalling the Store app removes it. The local hub runs Hermes with a home inside its own data
  folder, so that is consistent — but a person who also wants Hermes in a terminal should install
  it with Hermes's installer themselves (the `.exe` build has no such limit).
- *The `corehub://` protocol* comes from the manifest; the app does not register it itself. It
  does not set its own AppUserModelID either (the package gives it one; a different one would
  lose its notifications).
- The local helper listens on 127.0.0.1 as in the `.exe` build (a full-trust app may).

### The first Microsoft Store submission (by hand)

1. Download `Core-Hub-X.Y.Z-x64.msix` from the version's GitHub release (Assets).
2. [Partner Center](https://partner.microsoft.com/dashboard) → Apps and games → **Core Hub** →
   **Start submission**.
3. **Pricing and availability**: markets, *Free*, visibility (public, or private for a first
   test).
4. **Properties**: category *Productivity* (secondary *Developer tools*); privacy policy URL (the
   app signs people in to a hub — required); support contact and website
   (`https://github.com/twuijri/core-hub`).
5. **Age ratings**: the IARC questionnaire. The app shows what AI agents and the hub's other
   members write, so answer *yes* to users interacting and sharing content; no violence, no
   purchases.
6. **Packages**: upload the `.msix`. Partner Center reads the identity, the version `X.Y.Z.0`, x64
   and the languages from it. It asks why the package needs the restricted capability
   `runFullTrust`: *Core Hub is a desktop (Electron) app packaged with the Desktop Bridge; it runs
   as a full-trust Win32 process and starts its embedded hub as a child process.*
7. **Store listings**: add English and Arabic; the texts are drafted in
   `docs/store/microsoft/listing-en.md` and `listing-ar.md` (description, short description,
   features, search terms, what's new). Screenshots: at least one per language, 1366×768 or
   larger.
8. **Submission options**: publish as soon as it passes, or manually.
9. **Submit to the Store**. Certification takes up to a few business days.

A later version: the same steps from *Update* on the existing submission, with the new `.msix`
(its version must be higher).

**Later, optional — automating the upload** (not built): the Microsoft Store Developer CLI
(`msstore`) can publish an MSIX from a workflow. It needs an Entra ID (Azure AD) app registered
in Partner Center (Account settings → User management → Azure AD applications, role *Manager*),
and its tenant id, client id and secret as repository secrets; a job after the release would run
`msstore publish Core-Hub-X.Y.Z-x64.msix -id 9MT62R5V3P5N`. Until the owner decides, the upload
stays manual.
