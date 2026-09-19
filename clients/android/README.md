# Core Hub Mobile — Android

The native Android client of Core Hub (twuijri's personal fork of
[Hermes Studio](https://github.com/EKKOLearnAI/hermes-studio); see the root
`LICENSE` and `docs/PERSONAL-FORK.md`). It talks to the same HTTP and Socket.IO API
as the web client and renders a native, phone-shaped interface instead of wrapping a
web view — with the web app's design system and navigation, so it feels like the
same product (`docs/mobile/DESIGN-SPEC.md` is the authoritative spec).

## What works today (v1.4.0)

- **Replies stream in as they are written**, over the same `/chat-run` socket the
  web UI uses, with a stop button that calls the run off mid-sentence. If the
  socket cannot be reached the app quietly falls back to the REST wrapper, so a
  reverse proxy that blocks WebSockets costs you the streaming, not the answer
- **The reasoning is kept**, folded under the reply, and the composer says which
  tool the agent is running while it works
- **Manage conversations**: long-press to rename, pin, categorise, archive, export
  or delete one; the History page adds search over titles and message text, an
  "All profiles" and an "Archived" filter, and a batch selection that archives,
  restores, moves or deletes many at once
- **Manage profiles**: create, rename and delete them from the profiles screen
- **Group chat is a room, not a list**: create or duplicate a room, join one by
  its invite code, fill its seats from agent presets, and watch replies stream in
  with per-agent activity, typing, the execution queue and inline approvals. Room
  settings carry the workspace, the members, the invite link with its QR, agent
  handoff and its chains, the running summary, and "clear the context"
- **Workflows run from the phone**: the list shows a live status chip per workflow,
  a workflow shows its graph in execution order (read-only — the editor stays on
  the desktop), its schedules with enable/disable, and its runs. A run opens a node
  timeline with each node's status, timing, output, an inline approve/reject for a
  node that waits on a person, and rerun-from-node
- **Navigation is the web app's** (M2): the app bar hamburger opens an off-canvas
  drawer with the primary rail (New Chat, Search, Device connections, Agent Manager
  for super-admins, Models), the four-segment switch (Chat, Group Chat, Workflow,
  History), the grouped session list and the footer (profile, model, sign out,
  connection status, `Core Hub v{server version}`, language). Every agent tool —
  Jobs, Kanban, Channels, Skills, Plugins, MCP, Runtimes, Workflows, Ekko hub, Files,
  Logs, Connections, Journey, Webhooks, Insights, Memory, Models — lives under the
  Agent Manager; every one opens a native Android screen, none sends you to the
  website
- **Mobile Kanban inspired by modern task apps**: switch boards, search, create a
  task, inspect its result and runs, assign it, and comment. Hold a card and drag
  left or right to move it between stages, or use its Move menu for precise and
  accessible control
- **Skills are native and editable** for Hermes, Claude, and Codex targets: search,
  enable, pin, import a ZIP, open `SKILL.md`, edit it, save it, or delete a local
  skill
- **Plugins, MCP, and Petdex are native too**: inspect or toggle standalone plugins;
  add, edit, test, reload, and delete MCP servers without losing advanced JSON;
  and adopt, enable, or resize a companion from the phone
- **Channels are set up from the app**, on their own screen: enter a bot token (or
  the app id, secret and the rest — each channel asks for exactly the fields the
  server maps), turn a channel on or off, or remove its credentials. Saving writes
  into your server and it restarts the gateway itself, so the channel comes up ready
- **Scheduled jobs (Cron Jobs) are fully manageable** for the active profile:
  create and edit the schedule, prompt, model, skills, delivery target and repeat
  limit; pause or resume it, run it immediately, delete it, and read its run output.
  Every call uses the same profile-scoped endpoints and `X-Hermes-Profile` header
  as Studio.
- **Settings mirror the web's settings sidebar and page** (M2): the settings
  drawer lists Logs, Usage, Performance (super-admin), Skills Usage, Theme, Pets,
  Profiles (super-admin) and Settings; the Settings page carries the web's tabs in
  order — Current Account, Account Management, Webhooks, Display, Proxy, Compression,
  Privacy, Models — plus *This device* (appearance, language, reasoning, voice input,
  logo) and *About*. Agent, session and compression configuration sits in the Agent
  Manager. Every native value is read from and saved to the active profile through
  the same contracts as the web UI
- **Agent settings**: max turns, gateway timeout, restart drain timeout, tool
  enforcement, and **gateway auto-start where Studio keeps it** — including the
  profile policy, so a server with several profiles can start only the ones that
  actually answer on a channel
- **The system back button behaves**: it closes the drawer, walks back through the
  app — a conversation, a room, an Agent Manager tool, a settings page — returns the
  Group Chat, Workflow and History sections to Chat, and only closes the app from
  the Chat section
- **Confirmation before anything you cannot undo**: signing out and restarting a
  profile's gateway both ask first, naming the profile that will stop answering
- **Ready for other languages**: every string lives in one file, adding a language is
  a copy plus two lines, and a test fails the build on a missing key or a broken
  placeholder. Right-to-left layouts are handled too, mirrored icons included, and the
  language is picked in Settings or before signing in — see
  [docs/adding-a-language.md](docs/adding-a-language.md)
- **The same profile pictures Studio shows**: an uploaded avatar, or the Multiavatar
  generated from the profile name — rendered on the device and cached, so a launch
  draws them from disk instead of pulling them again
- **Your Studio logo as the app mark**, fetched from your own server (`/logo.png`) and
  cached; swap it for any picture on your phone from Settings → This device
- **First-run walkthrough** explaining what the app is and that you supply the
  Hermes Studio server yourself
- **Splash while the stored session is verified** — the sign-in form only appears when
  you actually need to sign in
- Sign in with your Studio server address, username and password (or the QR code above)
- Bearer token stored in `EncryptedSharedPreferences`, backed by the Android Keystore
- **Your existing conversations in the web's session list**: RECENT (count gear,
  1–100), Pinned, categories and Uncategorized groups with collapsible headers;
  two-line rows with pin, unread dot, title, `HH:mm` or `Sep 18`, the runtime avatar
  (Hermes, Ekko, Claude, Codex, Pi, Grok, OpenCode, DeepSeek), the profile chip and
  the category tag; a 500 ms long-press menu to rename, pin, categorise, archive or
  delete; search and bulk delete on the History page
- **Open any conversation and read its real history** pulled from the server, then keep
  talking in the same session
- **All profiles filter**, matching Studio's dropdown, or scope the list to one profile
- **Group chat tab**: rooms with agent and member counts, open a room to read its messages
- **Composer laid out like Studio's**: a full-width field with a `+` button and
  context chips underneath, and a single trailing button that is the microphone until
  you type, then becomes send
- **The `+` sheet** carries everything the conversation needs: Camera, Gallery and File
  tiles, plus the model and the reasoning effort — new controls become one more row
- **Change the model** per conversation, applied with `POST /api/studio/sessions/{id}/model`
- **Change reasoning effort** (default, low, medium, high), sent as `reasoning_effort`
  on every run, the same field the web composer sets
- Attachments upload to your server and ride along with the message as proper
  content blocks
- **Voice, on the device by default**: tap the microphone and the words appear in the
  composer as you speak (Android speech recognition in the app language, inserted at
  the caret); nothing is sent until you press send. Settings → Voice switches to the
  **Core Hub server** path instead, which records a 16 kHz WAV and transcribes it with
  the STT provider configured in Studio. The mic shows idle, listening, transcribing
  and error states, and every failure is shown in words
- **Settings → Voice** picks who reads a reply aloud, per profile: *Core Hub default*
  (whatever the server has active), any TTS provider Core Hub has configured for that
  profile, or *Device voice* (the Android engine, nothing leaves the phone). Picking a
  server provider also writes it with `PUT /api/studio/tts/settings/active`, the same
  endpoint the web's voice connections screen uses; nothing else on the phone ever
  changes the server's active provider
- **Sign in by scanning the QR code** Core Hub shows under Device connections → App →
  Direct connection: the server address comes from the code and the phone appears as
  a named device on the server. Username and password remain as the second option
- **The device token renews itself**: refreshed silently on launch when it has under a
  week left or was last refreshed more than a day ago, and once after any `401`, with
  the request retried; a revoked token sends you back to the login screen with a message
- Profiles screen to switch which agent a new chat talks to
- Start a fresh conversation at any time
- **Core Hub's "Pure Ink" light and dark palettes** from one token file
  (`ui/theme/CoreHubTokens.kt`), following the system or the setting; RTL-aware
  layout with per-string direction (Arabic titles and messages read correctly, code
  and model ids stay left-to-right)

## Changed in M1 (Core Hub mobile branch)

- Every Studio-owned call uses its canonical `/api/studio/*` route: sessions, session
  search and categories, conversation messages and context length, group-chat rooms,
  STT, TTS, file downloads, the chat-run REST wrapper, usage and performance. The
  "try `/api/studio`, then fall back to `/api/hermes`" negotiation is gone; the server's
  legacy shim is no longer relied on. Profiles, config, available models, skills,
  plugins, MCP, kanban and jobs stay under `/api/hermes/*`, where they are canonical
- QR pairing through `POST /api/auth/app-login` with a stable per-install `device_code`
  kept in `EncryptedSharedPreferences`, and silent renewal through
  `POST /api/auth/app-refresh`
- Dictation on the device with live text, the Core Hub server as a setting, and the
  server path corrected to the Studio contract (profile status first, PCM WAV, `provider`
  and `language` fields, `no_speech_detected` shown as a message)
- Network failures that used to vanish inside `runCatching { … }.getOrNull()` now reach
  the error bar

## Changed in M2 (design system + navigation)

- `ui/theme/CoreHubTokens.kt` is the single source of colours (light/dark), state
  alphas, type ramp, radii, shadows and metrics from `docs/mobile/DESIGN-SPEC.md`;
  `CoreHubTheme` maps them onto Material 3 so every component picks them up, and
  `CoreHubIcons` carries the web's line icons
- Off-canvas drawer + hamburger instead of three bottom tabs; Chat, Group Chat,
  Workflow and History are sections of the same shell; Agent Manager (super-admin),
  the settings drawer and the tabbed Settings page follow the web's order
- The session list, chat header, message bubbles and composer surfaces use the tokens
  (bubble radius 10, composer card 18 with the spec shadow, 16 sp input, pill buttons)
- Branding: the app is "Core Hub", the launcher icon is the vector mark on the splash
  colour, the bundled logo is the in-app mark until the server's is fetched, and the
  coding-agent avatars are bundled

## Changed in M3 (chat parity with the web client)

- **Message rows per the spec**: user bubbles end-aligned at 75 %, assistant rows with
  the 22 dp avatar and author label at 80 %, system notices with the inline-start
  warning border, slash-command acknowledgements, error rows, and pulsing dots while a
  reply has not produced text yet
- **Tool card and thinking block**: a collapsible "N tools" card (30 dp header, rotating
  chevron, wrench, up to three tool names, ✓ / ••• / ✕) whose lines open Thinking /
  Arguments / Result sections from `tool.completed` / `tool.failed` (truncation is
  labelled); a 💭 Thinking · Observed {duration} · {count} chars block fed by
  `reasoning.delta`, `thinking.delta` and `reasoning.available`. "Show tool calls" in
  the composer's ⚙ menu hides the card
- **Action row under every message**: play/pause voice (server TTS through
  `POST /api/studio/tts/synthesize`, falling back to Android TextToSpeech when the
  server cannot), copy, reference (quotes into the composer), fork (`/fork`), time
- **Spoken replies name their provider**, exactly like the web client: the app reads
  `GET /api/studio/tts/settings` for the active profile and sends `provider` plus that
  provider's stored options on every synthesize call. Leaving them out let the server
  resolve a provider on its own, which is `edge` (Microsoft's free voice) whenever the
  profile has no stored active provider and more than one is configured — the wrong
  voice, and often a failing one. When synthesis does fail, the banner now quotes the
  provider, the HTTP status and the server's own error body instead of a bare
  "could not be played" before it falls back to the device engine
- **Composer per the spec**: radius-18 card, 150 dp minimum, context indicator
  "{used} / {limit} · remaining {rest}" top-end (amber above 80 %), a borderless 16 sp
  textarea that never auto-focuses, and the toolbar [+ camera / gallery / files]
  [🧠 reasoning] [⚙ Voice mode · Show tool calls · Push] [model] … [mic] [send / stop].
  Pill labels collapse to icons on narrow phones. Attachments go through the chunked
  `POST /api/studio/app-uploads` (256 KiB PUTs, 50 MB max) with a progress chip that can
  be cancelled; a server without the route falls back to `/upload`
- **Run interactions inline**: approvals (once / session / always / reject) and
  clarifications (choices + free text) are cards in the stream, queued messages get
  run-next / interrupt / cancel, context compression and abort progress show as
  banners, `run.peer_user_message` turns appear as user rows, and
  `session.settings.updated` updates the model / reasoning / push pills
- **Files and media**: video (mp4, webm, mov, m4v) and audio (mp3, wav, ogg, m4a, aac,
  flac) linked from a reply play inline through the authenticated download route
  (bearer header, HTTP ranges); other files are download cards; `device://` links carry
  an "on the device" badge
- **Mobile consent**: the socket handshake sends `platform=android`; a
  `location.requested` event opens a consent dialog, then the runtime permission, then
  the platform `LocationManager` answers `location.respond` (WGS84, accuracy, timestamp).
  Calendar, reminder and health requests are declined until those integrations exist

## Changed in M4 (sessions, group chat, workflows, settings)

- **Sessions reach web parity**: pinned sessions and the RECENT count are device
  preferences per profile, category groups carry a ⋯ menu (rename, move every
  session, delete), the long-press menu adds pin, category, archive and export,
  and search asks the server (`/sessions/search?q=`) so it matches message text
  and not only titles. History adds the "All profiles" and "Archived" filters,
  unarchiving from the archived list, and a batch selection wired to
  `POST /sessions/batch-archive` and `/sessions/batch-delete`
- **Group chat**: `GET/POST /group-chat/rooms`, clone, config, workspace, invite
  code, the agent seats and presets, member removal, clear-context, the summary
  and the handoff chains, with attachments through the room's chunked upload. The
  `/group-chat` socket carries `message`, `message_stream_start/delta/end`,
  `message_reasoning_delta`, member and agent changes, typing, `room_agent_activity`,
  `execution_queue_updated`, `approval.*`, `clarify.*`, `room_updated` and
  `room_cleared`; the reducer that turns them into screen state is unit-tested
- **Workflows**: list, run with an optional input, stop, delete, import and export,
  schedules (create, edit, enable/disable, delete), a run's node sessions, inline
  node approvals and rerun-from-node — with the `/workflow` socket subscription
  keeping the chips and the timeline moving
- **Settings finish the web's tab order**: Models now shows the default model and
  changes it from the catalog, lists a provider's models with alias, visibility,
  context window and custom entries, restores a provider list and adds or removes
  a custom provider; Display carries the theme and background screen, the app
  language and the device text scale beside the server's display options
- **Every new string is in English and Arabic**, content text follows its own
  direction and paths, ids, models and cron expressions stay LTR

## Project structure

```
app/src/main/java/us/i3u/hermesstudio/
  AppViewModel.kt         state, navigation model (Screen, Tab), API orchestration
  MainActivity.kt         app entry, login, groups/rooms, profiles, Agent Manager,
                          settings group bodies, channels, shared pieces
  HermesApi.kt            the HTTP contract (/api/studio/*, /api/hermes/*, /health)
  ChatSocket.kt, GroupSocket.kt, WorkflowSocket.kt
                          Socket.IO /chat-run, /group-chat and /workflow
  GroupModels.kt          room, seat, member, message and preset parsing
  GroupRoomState.kt       the room reducer and the transcript builder
  WorkflowModels.kt       workflow parsing, graph ordering, the run timeline
  AppUploads.kt           chunked App upload planning (/api/studio/app-uploads)
  MobileLocation.kt       location consent → LocationManager → location.respond
  ui/theme/               CoreHubTokens, CoreHubTheme (Material mapping), CoreHubIcons
  ui/navigation/          drawer host + content, HomeShell (hamburger), settings drawer
  ui/sessions/            session grouping, list rows and menus, History, time format,
                          agent avatars
  ui/chat/                conversation screen, chat header, message rows (bubbles, tool
                          card, thinking block, action row, media), run cards
                          (approvals, queue, banners, location consent), composer,
                          chat formatters
  ui/groups/              the room list, a room, the settings sheet, seat/preset
                          dialogs
  ui/workflows/           the workflow list, one workflow, a run timeline, status
  ui/settings/            the tabbed Settings page
  AgentToolScreens.kt, CronJobs.kt, KanbanScreens.kt, Studio*Screens.kt   agent tools
app/src/main/res/         strings (values, values-ar), Core Hub drawables, launcher
app/src/test/             JVM tests (contract, translations, RTL, navigation structure,
                          session grouping, chat formatters, chunked uploads, run
                          events, the group-room reducer, the workflow timeline)
tools/mock-studio.py      a REST stand-in for a Core Hub server
```

## Screenshots

The screenshots below predate M2 (they still show the bottom tabs) and are kept until
the emulator captures are refreshed. To retake them on the new structure: sign in,
then capture (1) the Chat section with the drawer open, (2) a reply streaming in,
(3) the History page, (4) the Settings page tabs, (5) a group room, (6) Channels.
Save them as `docs/screenshots/{drawer,streaming,history,settings,room,channels}.png`.

| | |
| --- | --- |
| ![Your conversations](docs/screenshots/chats.png) | ![A reply streaming in](docs/screenshots/streaming.png) |
| ![A group room](docs/screenshots/room.png) | ![Channels](docs/screenshots/channels.png) |

## Install

Grab `hermes-studio-android.apk` from the
[latest build](https://github.com/twuijri/hermes-studio-mobile/releases/tag/latest-debug) and open it on your phone.

Android shows **"Play Protect hasn't seen an app from this developer before"** — that
appears for every app installed outside the Play Store. Choose **Install anyway**.

Every push to `main` rebuilds that release, so the link always points at the newest
build, and each build is signed with the same project key so it installs straight over
the previous version.

GitHub-built copies also check that rolling release at launch. When its published
commit differs from the installed build, the app offers to download the APK and
hands it to Android's package installer. Android still requires the user to approve
the installation and to allow this app as an update source once.

> Installed a build from before 2026-07-30? Uninstall the old app once, then install
> this one. Those builds were signed with a throwaway key that CI regenerated on every
> run, which is why Android refused to update them in place.

## How it talks to your server

| Purpose | Endpoint |
| --- | --- |
| Server version for the drawer footer | `GET /health` (`webui_version`) |
| Sign in with a password | `POST /api/auth/login` |
| Sign in by QR code | `POST /api/auth/app-login` |
| Renew the device token | `POST /api/auth/app-refresh` |
| Verify a stored token | `GET /api/auth/me` |
| Account security and IP locks | `POST /api/auth/change-password` · `POST /api/auth/change-username` · `GET` / `DELETE /api/auth/locked-ips` |
| Super-admin account management | `GET` · `POST /api/auth/users` · `PUT` · `DELETE /api/auth/users/{id}` |
| Profiles | `GET /api/hermes/profiles` |
| Conversations | `GET /api/studio/sessions?profile=…` |
| Search conversations | `GET /api/studio/sessions/search?q=…` |
| Conversation history | `GET /api/studio/sessions/conversations/{id}/messages` |
| Context window of a model | `GET /api/studio/sessions/context-length` |
| Group chat rooms | `GET /api/studio/group-chat/rooms` |
| Room detail and messages | `GET /api/studio/group-chat/rooms/{id}` |
| Upload an attachment | `POST /upload?profile=…` |
| Transcribe a recording (server voice input) | `GET /api/studio/stt/profile-status` · `POST /api/studio/stt/transcribe` |
| Spoken replies | `POST /api/studio/tts/synthesize` (always with `provider`) |
| Voice providers of a profile | `GET /api/studio/tts/settings` · `PUT /api/studio/tts/settings/active` |
| Generated files | `GET /api/studio/files/download` |
| Usage and performance | `GET /api/studio/usage/stats` · `GET /api/studio/performance/runtime` |
| Available models | `GET /api/hermes/available-models?profile=…` |
| Set a conversation's model | `POST /api/studio/sessions/{id}/model` |
| Profile default model | `GET /api/hermes/config` · `PUT /api/hermes/config/model` |
| Studio setting sections | `GET /api/hermes/config` · `PUT /api/hermes/config` |
| Model-provider credentials | `PUT /api/hermes/config/providers/{provider}` |
| Restart a profile's gateway | `POST /api/hermes/profiles/{name}/gateway/restart` |
| Send a message (streaming) | Socket.IO `/chat-run` — `run`, `abort` |
| Send a message (fallback) | `POST /api/studio/chat-run/runs` |
| Rename / delete a conversation | `POST /api/studio/sessions/{id}/rename` · `DELETE /api/studio/sessions/{id}` |
| Create / rename / delete a profile | `POST /api/hermes/profiles` · `POST /api/hermes/profiles/{name}/rename` · `DELETE /api/hermes/profiles/{name}` |
| Create / delete a room | `POST` · `DELETE /api/studio/group-chat/rooms` |
| Post into a room | Socket.IO `/group-chat` — `join`, `message` |
| Channel state and gateway auto-start | `GET /api/hermes/config` · `PUT /api/hermes/config` |
| Channel credentials | `PUT /api/hermes/config/credentials` · `DELETE /api/hermes/config/credentials/{platform}` |
| Scheduled jobs | `GET` · `POST /api/hermes/jobs` · `PATCH` · `DELETE /api/hermes/jobs/{id}` |
| Pause / resume / run a job | `POST /api/hermes/jobs/{id}/pause` · `resume` · `run` |
| Scheduled job run history | `GET /api/cron-history` · `GET /api/cron-history/{jobId}/{fileName}` |
| Kanban boards and tasks | `GET /api/hermes/kanban/boards` · `GET` / `POST /api/hermes/kanban` · `POST /api/hermes/kanban/tasks/bulk` |
| Kanban detail, comments, and assignees | `GET /api/hermes/kanban/{id}` · `POST /api/hermes/kanban/{id}/comments` · `GET /api/hermes/kanban/assignees` |
| Skills | `GET /api/hermes/skills` · `GET` / `PUT` / `DELETE /api/hermes/skills/{category}/{name}` · `PUT /api/hermes/skills/toggle` · `pin` |
| Plugins | `GET /api/hermes/plugins` · `POST /api/hermes/plugins/{key}/enable` · `disable` |
| MCP servers | `GET` · `POST /api/hermes/mcp/servers` · `PATCH` / `DELETE /api/hermes/mcp/servers/{name}` · `POST /api/hermes/mcp/reload` |
| Petdex and active pet | `GET /api/hermes/petdex/manifest` · `GET` / `PATCH /api/hermes/pets/active` · `POST /api/hermes/pets/adopt` |
| App mark | `GET /logo.png` (static, cached on the device) |

Both sockets authenticate with the same bearer token, passed in the Socket.IO
handshake (`auth.token`) rather than a header. `POST /api/studio/chat-run/runs` is the
server's own REST wrapper around `/chat-run`: the app uses it whenever the socket
cannot connect, which is why the app still works behind a proxy that drops
WebSocket upgrades.

All traffic goes to the address you enter (or the one inside the QR code), over HTTPS.
Nothing is sent anywhere else and there is no analytics. The app asks for `INTERNET`,
plus `RECORD_AUDIO` and `CAMERA` only at the moment you first use the microphone, the
camera, or the QR scanner. With voice input set to *This device*, speech goes through the
phone's own recognition service and never through this app's network code; with *Core
Hub server*, the WAV is kept in memory, sent to your server, and dropped. Camera captures
are written to the app cache, uploaded, and deleted immediately.

## Roadmap

- Editing the workflow graph itself (the phone lists it; the editor is desktop-only)
- Editing a profile's avatar from the app, not only reading it
- STT provider settings from the app (the TTS provider can already be chosen in
  Settings → Voice; editing a provider's own keys and models is still web-only)
- Native push notifications for finished runs, approvals, and scheduled reports
  after the Studio server implements the capability-gated APNs/FCM contract in
  [`../docs/push-notifications.md`](../docs/push-notifications.md)

## Build locally

```bash
gradle testDebugUnitTest assembleDebug
```

Requires JDK 17, Gradle 8.11.1 or newer (the Android Gradle plugin 8.9.2 refuses older
Gradle releases), and the Android SDK (compileSdk 35). CI builds the same target on every
push, so a local SDK is optional.

### Running it without a Studio server

`tools/mock-studio.py` answers the REST endpoints the app calls, with sample profiles,
conversations, accounts, settings, model providers, a room, scheduled jobs, Kanban,
skills, plugins, MCP servers, TTS providers, and Petdex — enough
to open and edit every screen. Its TTS routes reproduce the fallback bug on purpose:
a synthesize call that names no provider is resolved to `edge` and answered with a
502, `groq` answers a JSON error as HTTP 200, and `elevenlabs` (the profile's active
Arabic voice) answers real WAV bytes. `MockStudioVoiceTest` drives all of that through
the real `HermesApi`. It does not
speak Socket.IO, which makes it a good way to exercise the REST fallback: messages
still get answered, just not word by word.

```bash
python3 tools/mock-studio.py        # or: python3 tools/mock-studio.py 0
```

Sign in from a debug build at `http://10.0.2.2:8099` on an emulator, with any
username and password. Debug builds permit plain HTTP to that host; release builds
keep Android's default and refuse it.

## Contributing

Issues and pull requests are welcome — this is meant to be a community client.

**Translating it** is the easiest place to start and needs no Kotlin: copy one XML
file, translate it, add two lines. [docs/adding-a-language.md](docs/adding-a-language.md)
walks through it, and `gradle test` checks your work.

The native iOS client lives beside this project in [`../ios`](../ios/). Keep shared
API behavior and public release versions aligned when changing either platform.

## Credits

Generated profile pictures come from the Multiavatar generator, ported to Kotlin so the
app and the web UI draw the same face for the same profile. Avatars by
[Multiavatar.com](https://multiavatar.com) — its license ships in
`app/src/main/assets/multiavatar-LICENSE.txt`.

The Core Hub logo, vector mark and the coding-agent avatars are bundled from
`packages/client/public/` (same licence as the repository). The in-app mark still
prefers the logo read from the server you connect to, so replacing `logo.png` on that
server changes the mark here.

## License

Same as the repository — see the root [LICENSE](../../LICENSE) (BSL 1.1) and
`docs/PERSONAL-FORK.md`.
