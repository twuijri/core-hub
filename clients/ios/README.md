# Core Hub — iOS

The native SwiftUI client of [Core Hub](https://github.com/twuijri/core-hub) (twuijri's fork of Hermes Studio). It talks to the same `/api/studio/*` REST routes and Socket.IO namespaces as the web client and keeps the bearer token in the iOS Keychain.

The version follows the core (`package.json` at the repository root); see `docs/mobile/PLAN.md`.

## Design system (M2)

`HermesStudio/Theme/CoreHubTokens.swift` is the single source of the "Pure Ink" design system from `docs/mobile/DESIGN-SPEC.md`:

- `CoreHubTokens.PaletteHex.light/.dark` — the raw hex values (unit-tested); `CoreHubTokens.Palette.*` — dynamic `Color`s that follow the effective colour scheme (system, or the user's light/dark choice through `preferredColorScheme`). State formulas: `hover` = accent @ 6 %, `selected` = accent @ 12 %, `inputBorderIdle` = accent @ 18 %.
- `Typography` (14 base; 16/600 titles; 13 nav/session; 12 author; 11 meta; 10/600 uppercase group headers; monospaced code; inputs never below 16 pt), `Radius` (6/8/10/14/18/999/4/5), `Shadow` (card, composer light/dark, focused), `Motion` (150/250 ms), `Layout` (sidebar 240, header 60, drawer ≤ 300, …).
- The app tint is `Palette.accent`; every view touched in M2 uses tokens only.

Icons: `Theme/IconPath.swift` parses the 24-viewBox SVG path data written in the spec (`M/m L/l H/h V/v C/c A/a Z` plus circles and rounded rects; arcs become cubic curves) and `Theme/CoreHubIcons.swift` lists the rail, segment and header icons drawn with stroke 1.8 and round caps. Directional icons (`chevronForward`, `back`, `chat`, `workflow`, `history`) mirror in RTL. `CoreHubMarkView` draws the vector Core Hub mark.

Agent avatars: `Theme/AgentAvatar.swift` maps a session's runtime id to the bundled assets `Agent-*` (copied from `packages/client/public/coding-agents/`; SVGs are used as vector imagesets, large PNGs were downscaled to 256 px) exactly like the web's `chat-agent-avatar.ts`.

## Navigation (M2)

`Features/RootShell.swift` replaces the old tab bar with the web's mobile layout: a navigation bar with a hamburger and an off-canvas drawer (`Features/SidebarDrawer.swift`, 250 ms slide, 40 % scrim, swipe to close, edge swipe to open):

1. Primary rail — New Chat, Search, Device connections, Agent Manager (super-admin only), Models.
2. Conversation switch — Chat · Group Chat · Workflow · History (`ConversationMode`).
3. The list of the current mode — sessions (`Features/SessionListView.swift`), group rooms or workflows.
4. Footer — profile selector, model selector (default model for new chats), Sign Out + username chip, connection dot from `GET /health`, "Core Hub v{server version}", language and theme switches, and the gear that swaps the drawer to the settings list (Logs, Usage, Performance (sa), Skills Usage, Theme, Pets, Profiles (sa), Settings) with a Back row.

The Settings page (`Features/SettingsView.swift`) follows the web order — Current Account, Account Management (sa), Webhooks (sa), Display, Proxy, Compression, Privacy, Models, Voice, This device — and keeps every previous screen reachable under Advanced (Agent, Memory, Session reset, Approvals, Skill approvals, Voice, Gateway auto-start, Ekko, Runtime Versions) and Workspace tools (Global Agent, Files, Journey, Scheduled Jobs, Kanban, Channels, Skills, Plugins, MCP, Connections).

Session list rows follow `SessionListItem.vue`: pin, unread dot, title with per-string direction, time (`SessionTimeFormatter`: same day → `HH:mm`, else "Sep 18"), 18 pt agent avatar, profile chip and category tag; long-press context menu (rename, pin, category, archive, session settings, delete), swipe to delete/archive and a 50 % ✕. Groups: RECENT (count 1–100, default 10, gear to change) → Pinned → categories → Uncategorized (`SessionGrouping`, `SessionBrowserPrefs`; pins, collapse state and the recent count are local to the device like the web's localStorage prefs).

The chat header shows the title (16/600, per-string direction) with the workspace chip (last path segment) and a ⋯ menu (refresh, new conversation, new conversation with agent, fork, rename, session settings, archive, delete).

## Chat (M3)

`Features/ConversationView.swift` owns one conversation; everything below it lives in `Features/Chat/`.

- **Socket.** `Core/SocketIO.swift` keeps one `/chat-run` connection open for the whole conversation (`auth: { token }`, `query: { profile, platform: 'ios' }` — the platform registers the phone as a mobile device target), emits `app.resume` on every connect, reconnects with exponential backoff (≤ 30 s) and immediately when the app returns to the foreground. `ChatSocket.events(for:json:sessionID:)` is the pure server→client mapping (`message.delta/interim`, `reasoning.*`, `tool.started/completed/failed` with truncation flags, `subagent.*`, `run.*`, `approval.*`, `clarify.*`, `compression.*`, `abort.*`, `usage.updated`, `session.command`, `session.title/workspace/settings.updated`, `resumed`, `location.requested`, `calendar/reminder/health.requested`). Client→server: `run`, `abort`, `approval.respond`, `clarify.respond`, `insert/steer/cancel_queued_run`, `location.respond`; calendar/reminder/health requests are answered `denied` for now.
- **State.** `Core/ChatStream.swift` — `ChatStreamState` and the pure `ChatRunReducer` (lines of kind user/assistant/system/command/error/interaction, interim text, thinking timestamps, tool upserts, queue, compression, abort, peer messages, settings, location), plus `ToolSummary`, `ThinkingFormat`, `ReferenceQuote`, `ContextUsageFormat` and `ReasoningEffortOption`. All unit-tested in `HermesStudioTests/ChatParityTests.swift`.
- **Rows.** `MessageRow.swift` (user ≤ 75 %, assistant with 22 pt agent avatar ≤ 80 %, system with a 3 pt warning border, command, error, streaming dots, attachment chips), `ToolSummaryCard.swift` (30 pt header, chevron, wrench, "N tools", ≤ 3 names + N, ✓/•••/Error; 11 pt mono lines with Thinking/Arguments/Result), `ThinkingBlock.swift` (💭 Thinking · Observed {duration} · {count} chars), `MessageActionRow.swift` (speech play/pause, copy, reference, fork, time), `InteractionCard.swift` (approval choices / clarification answer inline in the stream), `ChatBanners.swift` (queued runs, compression, abort, reconnecting, workspace changes).
- **Composer.** `ChatComposer.swift`: radius-18 card, min 150 pt, reference chip, attachment strip with progress and cancel, 16 pt input with per-string direction (never auto-focused), toolbar [+ attach (camera / photo library / files)] [🧠 reasoning] [⚙ Voice mode · Show tool calls · Push] [model ≤ 190 pt] … [mic 30] [send / stop 30] and a queue button while a run streams; context indicator top-end ("45.0k / 256.0k · remaining 211.0k", amber above 80 %). Labels collapse to icons under 380 pt.
- **Attachments.** `Core/AppUploads.swift`: chunked `/api/studio/app-uploads` (client id, ≤ 256 KiB raw chunks, complete → `{ name, path }` used in the content block, DELETE on cancel, 50 MB cap). Pickers in `AttachmentPickers.swift`.
- **Media.** `Core/MediaLinks.swift` + `MediaPlayers.swift`: absolute paths and `device://<id>/<path>` links stream from `/api/studio/files/download?path=…` with the bearer header (`AVURLAsset` + `AVURLAssetHTTPHeaderFieldsKey`); video (mp4/webm/mov/m4v) and audio (mp3/wav/ogg/m4a/aac/flac) play inline, other files are download cards, device files carry the "On the device" badge.
- **Speech.** `Core/MessageSpeaker.swift`: per-message play/pause of the synthesized reply, optional auto-play (Voice mode), and the `AVSpeechSynthesizer` fallback. Which voice speaks, and how the request is built, is in "Spoken replies" below.
- **Consent.** `LocationConsentSheet.swift` + `Core/LocationConsent.swift`: `location.requested` → sheet with the purpose → one CoreLocation fix → `location.respond` (`success` with WGS-84 coordinates, `denied`, or `error`). Requires `NSLocationWhenInUseUsageDescription`.

## Sessions, group chat, workflows and settings (M4)

**Sessions.** Search across titles and message text with snippets (`GET /api/studio/sessions/search`), the archived list from the History groups endpoint with Unarchive, an "All profiles" filter shared by the drawer and History, batch mode (archive / unarchive / delete / move to category), category ⋯ menus, export through the share sheet, session settings (model, reasoning effort, push, workspace, category, usage, current context) and paginated history with "load earlier" (`/messages/paginated`). Pure helpers: `SessionBatchSelection`, `MessagePaging`, `BatchResult`, `SaveState`.

**Group chat** (`Features/GroupChat/`, models and transport in `Core/GroupChat*.swift`).

- **REST.** `Core/GroupChatAPI.swift` covers rooms (list, detail with paging, create, clone, delete), `config` / `workspace` / `invite-code`, the agent seats, members, `clear-context`, the room summary, the handoff chains, `rooms/join/{code}`, the agent presets and both attachment routes (multipart and the chunked `attachment-uploads`).
- **Socket.** `Core/GroupChatSocket.swift` keeps one `/group-chat` connection per room: `auth: { token }`, an acknowledged `join` on every (re)connect, exponential backoff, and the pure `GroupRoomSocket.events(for:json:roomID:)` mapping (`message`, `message_stream_start/delta/end`, `message_reasoning_delta`, `member_joined/left/kicked/updated`, `agents_updated`, `typing`/`stop_typing`, `room_agent_activity`, `execution_queue_updated`, `message_retracted`, `room_summary_updated`, `handoff_updated`, `approval.*`, `clarify.*`, `room_updated`, `room_cleared`, `context_status`). Sending uses the acknowledged `message`, `interrupt_agent`, `cancel_execution_queue_item`, `approval.respond`, `clarify.respond` and `load_messages`. Structured `mentions` are deliberately **not** sent: the server resolves @mentions from the text for human senders and rejects metadata that does not match exactly, so the @ menu only inserts text.
- **State.** `Core/GroupChatStream.swift` — `GroupRoomState` + the pure `GroupRoomReducer`, and `GroupRunLines`, which folds every message of one agent run (assistant + `tool` messages sharing a `run_id`) into one M3 `ChatLine` so the room reuses the message row, the tool card and the thinking block.
- **Screens.** `GroupRoomsView` (rooms with agent avatars and member counts, create, join by code, rename, duplicate, delete), `GroupRoomView` (transcript, per-agent activity with interrupt, typing, execution queue, inline approvals/clarifications, stopped handoff chains with Continue, "load earlier", `RoomComposer` with attachments and the @ menu), `RoomSettingsView` (name, summary policy and handoff depth, workspace, invite code with the CoreImage QR and share link, seats with preset CRUD, members, clear context, summary) and `RoomAgentEditorView`.

**Workflows** (`Features/Workflow/`). The list carries live status chips from the `/workflow` socket (`WorkflowLiveStatuses` owns the acknowledged `workflows.list` and `workflow.status.subscribe`), plus create, import (preview → confirm → cancel) and delete. The workflow screen runs (optional input, start nodes, timeout), stops, lists the runs and links to the schedules and the read-only graph summary. The run screen merges the persisted node sessions with the live `nodeStatuses` (`WorkflowGraph.timeline`), shows status, duration and errors, offers the inline approval on blocked nodes, loads a node's output from its session, and can rerun from a node. Schedules show a human cron description (`CronDescription`) with an enable/disable switch. Graphs are never edited on the phone.

**Settings.** The web tab order: Current Account, Account Management (super-admin, `/api/auth/users` CRUD), Webhooks (super-admin), Display (server theme and background, app language, device text size, chat display), Proxy, Compression, Privacy, Models — then Voice (which voice speaks the reply, see "Spoken replies"), This device, Advanced, Workspace tools and About. The Models tab (`Features/Settings/ModelCatalogView.swift`) reads `/api/hermes/available-models` and edits the default model, the provider pools (key, base URL, name, custom pools), the visibility rule, the custom models, the aliases and the context limits. Every control shows Saving / Saved or the server error (`SaveButton`, `SaveStateLabel`).

Every Studio request now carries `X-Hermes-Profile`: `APIClient.activeProfile` is the default header and `AppStore` keeps it in step with the selected profile.

## Connecting to Core Hub (M1)

- **QR pairing (recommended).** In Core Hub open *Settings → App connections → Create LAN pairing code* and scan it with **Scan QR code** on the login screen. The app calls `POST /api/auth/app-login` with a stable `device_code` (a UUID generated once and kept in the Keychain), the editable device name, `device_brand: Apple` and the hardware model. The token, its expiry and the connection id are stored together as one Keychain item.
- **Silent refresh.** `POST /api/auth/app-refresh` runs on launch when fewer than 7 days remain or the last refresh is older than 24 h, and once after any 401 (the failed request is retried with the new token). A 401 from the refresh itself signs the device out with a message. Decision logic: `AppTokenRefreshPolicy` (unit-tested).
- **Username/password** sign-in remains available under *Sign in with username and password*.
- **Canonical routes.** Sessions, messages, search, categories, usage, performance, group chat, files, STT, TTS and the REST chat-run endpoint use `/api/studio/*`. Profiles, config, models, skills, plugins, MCP, Kanban and jobs stay under `/api/hermes/*`. Bearer tokens are sent only in the `Authorization` header — never in a URL query — so downloads (agent files, workspace files, Kanban attachments) are fetched with `URLSession` and opened from a local copy.

## Voice input (M1)

- **Default: this device.** Apple Speech (`SFSpeechRecognizer` + `AVAudioEngine`) with partial results; the words appear live in the composer and the final text stays there. Nothing is sent automatically.
- **Option: Core Hub server** (*Settings → This device → Voice input*). The app checks `GET /api/studio/stt/profile-status` first and explains any `reason`, records 16 kHz mono 16-bit PCM WAV, and posts it to `POST /api/studio/stt/transcribe` as multipart (`provider`, optional `language`, file part `audio` = `voice.wav`). `no_speech_detected` and every other failure are shown in the banner.
- When on-device recognition is unavailable or its permission is denied, the app falls back to the server path for that attempt; when the server cannot transcribe, it falls back to the device with a banner naming the language it used. Neither direction is silent.
- Mic button states: idle → listening → transcribing → error.

### Dictation language

`Core/SpeechLanguage.swift` owns this; the views have no logic.

The app language is **not** the dictation language — an English phone running an English app is a normal way to speak Arabic, and following the UI was why the mic returned English words for Arabic speech. The default now follows the **keyboards the owner actually types with**: `UITextInputMode.activeInputModes` (public UIKit, no permission) gives each enabled keyboard's `primaryLanguage`, and the first one Apple Speech supports wins — preferring a keyboard that is *not* the app language when more than one is enabled, then the app language, then the device locale. `emoji` and `dictation` are input modes too and are dropped. The list is read at dictation time, not cached, because a keyboard can be added at any moment.

*Settings → Voice → Dictation language* (`Features/Settings/SpeechInputLanguageView.swift`) offers, per profile:

- **Follow my keyboard languages** — the default described above, on device.
- **Follow the app language** — `ar-SA` / `en-US` / the device locale, the behaviour before this preference existed, on device.
- **A specific language** — every locale in `SFSpeechRecognizer.supportedLocales()`, named by its own endonym (`العربية (المملكة العربية السعودية)`, not "Arabic"), Arabic first, then English, then the rest by name. A locale the recogniser does not support is never offered, and a stored one that stops being supported falls back to the keyboard default instead of pinning dictation to something that cannot run.
- **Let the Core Hub server detect it** — the only choice that leaves the device. Apple's recogniser takes one concrete locale and cannot detect across languages, so this records WAV and posts it to `/api/studio/stt/transcribe` with **no** `language` field. It is labelled as such in the picker and on the recording strip, is never a default, and is never entered by fallback.

The pick is stored per profile on the device (`Preferences.speechLanguage(for:)`: empty = keyboards, `app`, `server`, or a BCP-47 identifier) and reaches **both** paths — the recogniser's locale and the server's optional `language` hint (`ar-SA` → `ar`). The last three languages picked are remembered per profile (`Preferences.recentSpeechLanguages(for:)`) and shown in a "Recent" section.

**Long-press the mic** in the composer to open the same list as a sheet, so one Arabic dictation costs a gesture instead of a trip through Settings; the recording strip shows the language currently listening (or "Core Hub server"), so a wrong language is visible before the transcript comes back wrong.

Server-side caveat, verified in `packages/server/src/modules/studio/controllers/stt.ts`: the transcribe controller does **not** read the multipart `language` field — every provider takes its language from the profile's stored STT settings (`input.settings.language`). The hint is sent for forward compatibility and matches what the web client does, but today the server ignores it, so "let the server detect it" really means "whatever the profile's STT provider does with no language pinned in Studio → Voice". Fixing that is a server change and is out of scope here.

Required Info.plist strings: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSLocationWhenInUseUsageDescription`. `ITSAppUsesNonExemptEncryption` is `false` (the app only uses the system HTTPS stack), so TestFlight no longer asks about export compliance on every upload.

## Spoken replies

The chat "speak" button uses the **profile's Core Hub voice**, exactly like the web client. `Core/VoiceOutput.swift` loads `GET /api/studio/tts/settings` (`settings` + `activeProvider`) per profile and `POST /api/studio/tts/synthesize` then carries `provider` plus that provider's stored options (`voice`, `model`, `rate`, …). The API key never leaves the server — the settings endpoint only reports that one exists (`[stored]`) — and `baseUrlPresets` is a UI history list, so neither is echoed back; empty values are dropped because the server's `mergeStoredTtsOptions` treats a present-but-empty option as an override. The response's `X-TTS-Provider` / `X-TTS-Engine` say what actually ran.

Sending no `provider` was the bug: the server then resolves one itself and falls back to `edge` (Microsoft's free voice) whenever the profile has no stored active provider, so the phone spoke in a different voice than the browser.

*Settings → Voice → Spoken replies* (`Features/Settings/VoiceOutputSettingsView.swift`) lists the providers configured for the active profile with the server's active one marked, plus this iPhone's built-in voice. The pick is stored per profile on the device (`Preferences.ttsVoice(for:)`); nothing stored means "follow the profile", which is the default. Picking a **server** provider also writes `PUT /api/studio/tts/settings/active`, and only when it differs from what the server already has; picking the device voice never writes anything to the server. On-device speech stays the default for voice **input** (M1 decision); this setting is only about the spoken reply.

Failures are named, not swallowed: `TtsFailure` carries the provider, the HTTP status and the server's `{ error, detail }` text, a JSON body returned with HTTP 200 is detected before it reaches `AVAudioPlayer`, and only then does the device voice take over — with a banner saying which provider failed and why.

## Branding and distribution

Display name **Core Hub** (`CFBundleDisplayName`, both locales). The app icon is the Core Hub mark (`packages/client/public/core-hub-mark.svg`, #101010) at 60 % width on the splash colour #f7f7f4: `swift Scripts/generate_app_icons.swift HermesStudio/Resources Design/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` regenerates every size on macOS (the checked-in PNGs were rasterised from the same geometry with PIL on Linux). `AppIcon.svg` is a copy of the vector master. The in-app logo (`AppMark`) prefers the server's custom logo and otherwise draws the mark; `CoreHubLogo` holds `logo.png`.

The app target carries the icon as an asset catalog set, `HermesStudio/Resources/Assets.xcassets/AppIcon.appiconset`, holding the single 1024 px master that Xcode downsizes for every device. `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` and `CFBundleIconName` in `Info.plist` are what App Store Connect checks; loose `CFBundleIconFiles` entries are not accepted for uploads and were removed. `Design/Assets.xcassets` keeps the same master for design work.

## Arabic / RTL

`environment(\.layoutDirection)` follows the app language. Content (session titles, chat titles, messages) resolves direction per string (`DirectionalText`, `MarkdownText.layoutDirection`); code, paths and model ids are forced LTR (`TechnicalText`); spacing is logical (leading/trailing) and directional icons mirror.

## Install on a personal iPhone

1. Open `HermesStudio.xcodeproj` in Xcode.
2. Select the `HermesStudio` target, open **Signing & Capabilities**, and choose your Apple ID's Personal Team.
3. Connect the iPhone, choose it as the run destination and press Run.
4. If iOS asks, enable Developer Mode and trust the developer profile in **Settings > General > VPN & Device Management**.

A free Personal Team installation normally needs to be signed again after seven days. TestFlight and App Store distribution require the paid Apple Developer Program.

## Project structure notes

`HermesStudio.xcodeproj` uses Xcode 16 synchronized folders (`PBXFileSystemSynchronizedRootGroup`), so every `.swift` file under `HermesStudio/` and `HermesStudioTests/` is part of the matching target automatically; no `PBXBuildFile` entries are needed when adding files. Unit tests for pure logic live in `HermesStudioTests/` (`HermesStudioTests.swift`: contracts, QR pairing, refresh policy, STT; `CoreHubDesignTests.swift`: tokens, icon path parser, session grouping, time formatter, avatar mapping, browser prefs; `ChatParityTests.swift`: socket event mapping, stream reducer, tool/thinking/context formatting, chunked uploads, media links, location payload; `M4ParityTests.swift`: the group-chat event map and room reducer, the run→line converter, room drafts, invites and mentions, the workflow socket, status styling, cron descriptions and the graph timeline, the model catalog, account-management bodies, message paging and batch selection; `VoiceOutputTests.swift`: TTS settings decoding, the synthesize request body, provider selection and every spoken-reply error path; `SpeechLanguageTests.swift`: dictation-language preference resolution, the keyboard-derived default, supported-locale filtering and ordering, the multipart hint for both paths, the recent-language memory and every fallback).
