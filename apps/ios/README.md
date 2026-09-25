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

## Signing — a TODO for the owner

Running on a device or shipping needs the owner's Apple Developer account:

1. Pick the bundle id (proposed `io.github.twuijri.corehub`) and register it.
2. Set `DEVELOPMENT_TEAM` in `project.yml` (or in Xcode) and let Xcode manage signing.
3. Register the App Group `group.io.github.twuijri.corehub` for the app and the share extension
   (`io.github.twuijri.corehub.share`); until it is signed, a shared text does not reach the app.
4. For TestFlight: an App Store Connect record, an upload key, and a CI secret — not set up.

## Notifications — what works and what waits

While Core Hub is open (or just sent to the background, before iOS suspends it) the app listens
on `/rt/devices` and shows each notice the hub writes — a reply that finished, an agent waiting
for the person — as a local notification, quiet for the conversation on screen. **Push when the
app is closed needs APNs**: the hub's `devices` module (`devicesRegisterPush`) still answers 501,
and APNs needs the owner's Apple account (a push key or certificate). When both exist, the app
registers its device token with `devicesRegisterPush`; nothing else in the app has to change.

## Decisions (proposed — owner to confirm)

- iOS 17 minimum (Observation, `NavigationStack`, `UnevenRoundedRectangle`).
- The profile selector sits in the drawer's header, under the brand — not in a top bar,
  which the owner does not want on a phone.
- Plain `http://` hubs are allowed (`NSAllowsArbitraryLoads`): a self-hosted hub is often on a
  LAN or VPN address without TLS.
- The realtime client is our own Socket.IO v5 framing over `URLSessionWebSocketTask`, not a
  library: it is small, fully tested, and adds no dependency.
- Markdown: SwiftUI's inline Markdown per block, blocks split by our own small parser.
