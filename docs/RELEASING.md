# Releasing and signing the apps

Who does what: building is automatic; **publishing is the owner's step** (TEAM-RULES §6). The
signed builds below produce files; nothing here uploads to a store, makes a GitHub release or
pushes a tag, except TestFlight when the owner ticks it on a manual run.

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
workflow's run number (`COREHUB_ANDROID_VERSION_CODE`), so each build is newer than the last.
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
   `CFBundleVersion` is the workflow's run number.
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
- **TestFlight**: an app record in App Store Connect for `com.twuijri.corehub`, and an app
  icon in the app (none yet) — App Store Connect refuses a build without one.
- **Play**: nothing yet; the signed AAB is ready for an internal-testing track when the owner
  decides.
