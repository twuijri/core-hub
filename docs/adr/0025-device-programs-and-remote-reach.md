# ADR 0025 — Programs on this computer, and a hub on a server that reaches them

Status: **proposed — owner to confirm** (2026-09-27). The owner decided the scope on 2026-09-26
(«ايه»); the choices below that he did not name are marked as proposed. Builds on ADR 0009,
ADR 0020, ADR 0021 and ADR 0022 (amended by this one), and on DECISIONS §67 and §74.

## Context
The owner runs Core Hub on a server and the desktop app in remote mode. He wants an agent to
drive programs on his own computer — DaVinci Resolve first — from a chat on that hub: create a
project, import clips, build a timeline, render an MP4, and see the MP4 in the chat.

What Core Hub had: a local helper (ADR 0022) — an MCP server on 127.0.0.1 with file tools, off
by default, which only the hub on the same computer can reach; device capability requests
(§74) that a person can make of their own device, answered once within 30 s; and the hub's own
tools for agents over MCP (§67). Nothing let an agent ask a device, nothing on the desktop
answered a request while the window was closed, and nothing started another program.

Programs that want to be used by an assistant ship an **MCP server** and register it with
Claude Desktop (a config entry, or an installed extension — an MCP Bundle unpacked with its
`manifest.json`), Claude Code, Codex, Cursor or Windsurf. DaVinci Resolve's integration is one:
it drives Resolve through Resolve's own scripting API, which answers the running app only,
needs "External scripting using: Local", and, in recent versions, the Studio edition.

The behaviour of the owner's earlier app was read from an observer's plain-words spec, never
from its code (ADR 0004).

## Decision
1. **Reach: an outbound connection from the app's main process.** When this computer is
   paired with a hub, the main process keeps its own Socket.IO connection to that hub's
   `/rt/devices` with the device token pairing gave it (sealed by the OS keychain in the app's
   settings), reconnecting with back-off from 1 s up to a minute, from the tray too. Nothing
   listens on the computer; no tunnel, no relay. A token the hub refuses (unlinked there) is not
   tried again until the person links again. Linking from the page makes a pairing with the
   person's own sign-in and hands it to the app, which claims it; the token never reaches the
   page. The token is renewed on connect, at most once a day.
2. **The hub asks through the device requests of §74, one request per tool call.** The
   desktop answers `files` (the helper's own tools, plus `send_file`) and `apps` (`call` one
   tool of a program, or `status` of a long call). A run token may make those two kinds only,
   for the run's own person (§89). A program keeps running between calls, so an open project
   survives from one call to the next.
3. **Long work answers "running".** A program call that has not finished after a soft
   deadline (20 s after the person allowed it) answers `{state: running, call_id, progress}`;
   the program carries on, and `status` returns its progress or its result. Each capability has
   its own wait (`files` 60 s, `apps` 120 s — the person may be asked first; others 30 s). A
   computer with no live connection is answered "offline" at once for `files`, `apps` and
   `screen`.
4. **The agent's side: the `devices` group of the hub's own tools** (§67): `devices.list` (the
   person's computers this profile may use, their folders — the default one marked — and their
   programs with each tool's schema), `list_folder`, `read_file`, `write_file`, `open`,
   `fetch_file`, `run` and `run_status`. The group is off until an admin switches it on, even
   where the hub's tools are already on; `write_file`, `open` and `run` are writes, so they also
   need that group's "allow changes". Generic tools, not one per program: Hermes lists the hub's
   tools per profile and before any run names a person, so it cannot be told which person's
   programs to list; `devices.list` says what there is, per person, when asked.
5. **Profiles.** A device serves every profile of its person until the person narrows it
   (`Device.profiles`); a request from any other profile is refused (§89). A program is off
   until the person picks the profiles it serves, on the computer; the hub lists and the device
   answers only for those.
6. **Programs are found, never installed.** The app reads the MCP registrations of Claude
   Desktop (and its installed extensions), Claude Code, Codex, Cursor and Windsurf where each
   keeps them on macOS, Windows (including the Store build of Claude Desktop) and Linux; the same
   server registered twice is listed once; a server on the network is listed but not passed
   through; one switched off where it was registered is not offered. Placeholders the app can
   fill are filled (an extension's folder, the home and user folders, environment variables);
   a setting only the person has (a secret an extension asked for in Claude Desktop, which the
   app never reads from Claude's store) makes the program **needs setup**, and the person gives
   it in Core Hub, where it is sealed by the OS keychain.
7. **The helper runs them, and is the only way to them.** A program's MCP server is started as
   a child of the app — an argument array, never a shell string; on Windows the app finds the
   program through `PATH`/`PATHEXT` and starts a `.cmd` through `cmd.exe` with every argument
   quoted and escaped — and its tools are reached through the helper: in local mode as the
   helper's own tools (`<program>__<tool>`, offered to the profile the request names in
   `X-Corehub-Profile`), in remote mode through the device requests. So ADR 0022's rules cover
   them: the permission screen, the activity list, the consent.
8. **Consent: once per session, on the computer, in both modes.** Before an agent uses a
   program, a native dialog asks: Allow once, Allow for this session, or Deny. "This session"
   lasts until the app quits or the program is switched off or its settings change. Every call —
   a program's, a file tool's, from this computer or from a hub — is in the activity list.
9. **Files for the chat.** `devices.fetch_file` has the computer upload a file from a shared
   folder with the contract's resumable upload (≤ 50 MB), and the hub puts that attachment on
   the reply of the run that asked. A video in a reply plays in place from a one-attachment
   stream ticket with byte ranges (§90).
10. **DaVinci Resolve's readiness** is checked on the page: its integration found and switched
    on, Resolve running (`pgrep`, or `tasklist` on Windows), and Resolve itself asked through its
    documented scripting environment (`RESOLVE_SCRIPT_API`, `RESOLVE_SCRIPT_LIB`,
    `DaVinciResolveScript.scriptapp("Resolve")`) for its product name — which tells the Studio
    edition, and, when it does not answer while running, that "External scripting: Local" or
    Studio is missing. Each missing thing comes with the step that fixes it. On macOS, Windows
    and Linux (Resolve runs on all three).
11. **Not in this phase**: screen control, running commands, remote (URL) MCP servers passed
    through, waking a computer that is offline, an interactive terminal.

## Alternatives rejected
- **One managed MCP entry per program in each profile's Hermes config**, pointing at a bridge
  on the hub: many entries to keep in step, a process per entry, and nothing on the hub would
  know who asked; the device-request road already names the person and the profile.
- **A long-lived stream per program (a raw pipe through the hub)**: it does not fit §74's
  request/answer and its job; one request per tool call keeps consent, logging and timeouts
  per call, and the program's session lives on the computer anyway.
- **Waiting inside one request for a render to finish**: a request would have to live for
  minutes; "running" plus `status` keeps every request short and a slow render visible.
- **A tunnel or port on the computer** for a hub on a server: an inbound door to the person's
  computer, which the outbound connection makes unnecessary.
- **Reading secrets the person gave Claude Desktop**: they are that app's, kept by it; the
  person gives them to Core Hub once instead.
- **Per-program tools in the hub's tool list** (`resolve.render`): Hermes lists a profile's
  tools before any run names a person, so it would list everybody's programs or nobody's.

## Consequences
- An agent in a profile whose `devices` group is on can, for the run's own person and within
  what that person shared, read and write shared folders and run the programs switched on for
  that profile. A program runs with the person's account rights; the consent dialog and the
  activity list are what stand between an agent and it. The records name this the main risk.
- A render over 50 MB cannot come back into the chat in this version (the resumable upload's
  limit); it stays in the shared folder, where the agent can say where it is.
- The web's "This device" page groups the helper switch, the device connection (or the local
  address), the folders, the programs and the recent use, each folded away.
- The owner's real-Mac check is in docs/changes/2026-09-27-twuijri-device-programs.md.

## Amends ADR 0022
- **Decision 2** ("Off by default … each starts off"): turning the helper on with no folder
  shared makes `~/Core Hub` (Windows `%USERPROFILE%\Core Hub`) and shares it **writable**; it is
  the default place for program output. The owner, 2026-09-26: «كنا قلنا اذا المستخدم ما اختار
  مجلد حنا نسوي مجلد في اليوزر الأساسي لنا نحط فيه ملفاتنا مثل كلود». It is listed like any
  other folder, marked, and can be unshared; a folder already shared is never replaced.
- **Decision 3** (the tools): programs the person switched on add their tools, as in 7 above.
- **Decision 7** ("A hub on a server cannot reach a loopback address"): it reaches this
  computer through the device connection (1 above); the page says so.
