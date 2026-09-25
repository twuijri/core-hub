# Releasing and signing the apps

Who does what: building is automatic; **publishing is the owner's step** (TEAM-RULES §6). The
signed builds below produce files; nothing here uploads to a store, makes a GitHub release or
pushes a tag, except TestFlight when the owner ticks it on a manual run.

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
— never on a pull request. On a manual run the signed files are kept as workflow artifacts only
when `keep_artifacts` is ticked: the repository is public, so anyone signed in to GitHub can
download an artifact. A tag keeps them for 14 days.

| Workflow | Makes | Secrets |
|---|---|---|
| `android-signed.yml` | signed `app-release.apk` + `app-release.aab`, Firebase configured | `ANDROID_TEST_KEYSTORE_B64`, `ANDROID_TEST_KEYSTORE_PASSWORD`, `ANDROID_TEST_KEY_ALIAS`, `ANDROID_TEST_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON` |
| `ios-signed.yml` | App Store archive and `.ipa` (app + share extension); TestFlight when `upload_testflight` is ticked | `IOS_CSC_LINK`, `IOS_CSC_KEY_PASSWORD`, `ASC_API_KEY_ID`, `ASC_API_KEY_P8`, `ASC_API_ISSUER_ID` |
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
   Wait until App Store Connect has processed the build (TestFlight shows it).
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
