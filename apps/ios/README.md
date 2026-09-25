# Core Hub for iPhone and iPad (`apps/ios`)

A native SwiftUI client, written from scratch on the contract (ADR 0007) and the navigation
manifest (`docs/clients/navigation.json`). Minimum iOS 17 (proposed — owner to confirm).

## Layout

| Path | What |
|---|---|
| `project.yml` | XcodeGen spec; the `.xcodeproj` is generated, never committed or hand-edited |
| `CoreHub/App` | entry point and `AppModel` (who, which hub, which profile, language, theme) |
| `CoreHub/Auth` | sign-in, QR pairing, Keychain credentials |
| `CoreHub/Hub` | calls through the generated `CoreHubClient`, token refresh, one error type |
| `CoreHub/Realtime` | Socket.IO v5 over `URLSessionWebSocketTask` (no third-party library) |
| `CoreHub/Chat`, `CoreHub/Sessions` | the conversation, the chats list |
| `CoreHub/Screens` | search, global agent, Agents and an agent's pages, Tasks, Schedules, Rooms |
| `CoreHub/Navigation` | the registry and `surfaceRoutes.ios` (`Routes.swift`), checked by `NavigationParityTests` |
| `CoreHub/Shell`, `CoreHub/Settings` | the drawer, Settings and its pages |
| `CoreHub/i18n` | `ar.json` / `en.json` (checked by `pnpm i18n:check`) |
| `CoreHub/Generated` | `Tokens.swift`, `Product.swift` — generated, committed |
| `CoreHub/Phone` | local notices, dictation, spoken replies, This device's choices |
| `CoreHub/Share`, `CoreHubShare` | the share extension and the inbox it leaves shared text in |
| `CoreHubTests` | XCTest |
| `scripts/generate-swift.mjs` | writes `Generated/*` and `Resources/*.lproj/InfoPlist.strings` |

## Build

On a Mac with Xcode 16 or later, from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm contracts:generate              # needs Java 17+; writes packages/contracts/generated/swift
node apps/ios/scripts/generate-swift.mjs
brew install xcodegen
cd apps/ios && xcodegen generate && open CoreHub.xcodeproj
```

CI (`.github/workflows/ios.yml`) generates the Swift client on Linux, then builds and runs the
tests on a macOS runner's simulator. Nothing there is signed or published.

## Signing

The bundle ids are `com.twuijri.corehub` (the app) and `com.twuijri.corehub.share` (the share
extension), with the App Group `group.com.twuijri.corehub`, in the owner's team `58QWJ228ZE`
(`DEVELOPMENT_TEAM` in `project.yml`; Xcode signs automatically on a developer's Mac). A signed
App Store build and an optional TestFlight upload come from `.github/workflows/ios-signed.yml`,
run by hand or by a release tag, never on a pull request — how it signs and what the owner sets in
the Apple consoles: `docs/RELEASING.md`. The app icon (`CoreHub/Resources/Assets.xcassets/AppIcon`,
named by `ASSETCATALOG_COMPILER_APPICON_NAME` in `project.yml`) is generated from the Core Hub mark
by `pnpm icons:build` at the repository root; never edit its PNGs by hand.

## Notifications — push, and the fallback

While Core Hub is open (or just sent to the background, before iOS suspends it) the app listens
on `/rt/devices` and shows each notice the hub writes — a reply that finished, an agent waiting
for the person — as a local notification, quiet for the conversation on screen.

**Push (APNs, `CoreHub/Phone/Push.swift`).** Right after sign-in the app asks once for
notifications; with a yes it registers for remote notifications and sends the device token (hex)
to the hub with `devices.registerPush` (`provider: apns`), on the device the pairing made or — for
a username-and-password sign-in — on this install registered as a device (`devices.register`, its
stable `device_key`). It does so again at each launch, since iOS may change the token. A pushed
notice shows as a normal notification; in front, one the socket already showed is not shown again,
and a tap opens the conversation, task board or schedule it is about (the push's `resource`).
Signing out removes the registration first (`devices.unregisterPush`). The app carries the
`aps-environment` entitlement: `production` in Release (App Store, TestFlight), `development` in
Debug from Xcode (`COREHUB_APS_ENVIRONMENT` in `project.yml`); the signed workflow checks
`production`.

**Fallback.** Without push — notifications not allowed, no APNs sender set up on the hub, or an
error — iOS wakes the app now and then (`BGAppRefreshTask`, at most every 15 minutes, when iOS
decides) to read the unread notices and show the new ones. While push is active that background
look is not scheduled. This device says which case holds. Each notice is shown once, whichever
path saw it first.

What the hub needs for push: an APNs sender in Device connections → Push senders (the `.p8` key,
Key ID, Team ID `58QWJ228ZE`, bundle id `com.twuijri.corehub`, environment `production` for a
TestFlight or App Store build, `sandbox` for a Debug build from Xcode).

## Decisions (proposed — owner to confirm)

- iOS 17 minimum (Observation, `NavigationStack`, `UnevenRoundedRectangle`).
- The profile selector sits in the drawer's header, under the brand — not in a top bar,
  which the owner does not want on a phone.
- Plain `http://` hubs are allowed (`NSAllowsArbitraryLoads`): a self-hosted hub is often on a
  LAN or VPN address without TLS.
- The realtime client is our own Socket.IO v5 framing over `URLSessionWebSocketTask`, not a
  library: it is small, fully tested, and adds no dependency.
- Markdown: SwiftUI's inline Markdown per block, blocks split by our own small parser.
