# ADR 0014 — A workspace is a Hermes profile

Status: accepted (2026-09-23, owner: «ايه ايكو يخلي البروفايل العام يعكس البروفايل على هرمز لان
هرمز اساس عنده», then «خل الخيار اني ابنيه من الصفر او استنسخ من بروفايل محدد», «ايه»)
Builds on: ADR 0005 (workspaces), ADR 0008 (Hermes as the base runtime), ADR 0010 (shared
providers), ADR 0013 (conversations over the TUI gateway).

## Context
A workspace (a "profile" in the contract since the first draft, and «بروفايل» in the UI since
2026-09-23) has been the hub's own filter: rows carry it, nothing outside the hub knows it.
Hermes has profiles of its own — separate homes under `<HERMES_HOME>/profiles/<name>/`, each
with its config, `.env`, `SOUL.md`, memory, skills, cron and sessions — and Hermes is the base
the hub is built on. Ekko makes each of its profiles a Hermes profile; the owner wants the
same, so that a profile set up here is a profile Hermes can run, export and move.

Reading Hermes's MIT source (never the owner's Studio fork, ADR 0004):

- `hermes profile create <name>` makes a fresh profile (its bundled skills seeded);
  `--clone-from <source>` copies `config.yaml`, `.env`, `SOUL.md` and skills — not memory,
  sessions or messaging channels (their tokens would collide); `--no-alias` skips the wrapper
  scripts. It takes about a second.
- Profile ids match `^[a-z0-9][a-z0-9_-]{0,63}$`; `default` is the root home itself.
- A deleted profile leaves a tombstone at `profiles/.deleted/<name>`; Hermes's own listing
  (`_iter_named_profile_dirs`) is "directories with a valid id, not `default`, no tombstone".
- `hermes profile list` prints a table, not data.
- `hermes profile export` / `import` move a profile as a `.tar.gz`, credentials excluded and
  secrets scrubbed by Hermes itself.

## Decision
1. **The name is the slug.** A workspace's Hermes profile is the one named by its slug; the
   hub's default workspace is Hermes's `default`, whatever the owner named it at setup.
2. **Created in Hermes first.** `auth.createProfile` runs `hermes profile create` before the
   row exists: `clone_from` absent → from scratch; `clone_from: <slug>` → `--clone-from` that
   workspace's profile. When Hermes refuses, nothing is created and the answer is `409
   conflict` with `details: {reason: 'hermes_refused', message: <Hermes's last line>}` — the
   form other Hermes bridges (tasks, schedules) already use. The web asks the question
   outright: from scratch, or a copy of a profile the person picks.
3. **Hermes's profiles appear.** `auth.listProfiles` reads Hermes's profile directories the
   way Hermes does and adds a workspace for each one the hub does not know (owned by the hub
   owner, named after the profile). A slug any workspace already uses — an archived one
   included — is left alone, so archiving here is not undone by the next listing.
4. **Archive here keeps Hermes's profile.** Archiving a workspace folds it away and ends its
   memberships, as before; the Hermes profile and its data stay. Deleting a Hermes profile is
   a separate, explicit act, not part of this stage.
5. **No Hermes, no mirror.** Only where the hub can run `hermes` against its home (the same
   condition as the kanban bridge). Otherwise a workspace is the hub's own filter, as before.
6. **The port.** `auth` defines `ProfileMirror` and knows nothing of Hermes; `agents`
   implements it (`hermes-profiles.ts`); `modules/index.ts` joins them — the pattern of the
   kanban, cron and workflow bridges.

## Stages
1. This ADR: create from scratch or as a copy; Hermes's profiles listed as workspaces.
2. Export and import (`auth.exportProfile`, `auth.importProfile`, already in the contract):
   Hermes's own archive, so a profile moves between Ekko, the hub and any Hermes.
3. Conversations and the tool pages (skills, MCP, memory, channels) in the profile's home:
   the TUI gateway's `session.create` takes a `profile`; provider keys reach every profile.
4. Tasks and schedules per profile (Hermes's multiplexed gateway, `/p/<profile>/…`).

Progress (appended, the decision above unchanged):
- **Stage 3, conversations — built 2026-09-24** (`docs/changes/2026-09-24-twuijri-chat-runs-in-profile.md`).
  One TUI gateway serves every profile: `session.create` and `session.resume` take `profile`,
  and Hermes binds that profile's home, `.env` and terminal policy for the session's build and
  each turn (`tui_gateway/model_switch.py` §_session_profile_runtime_scope). Measured: ~217 MiB
  for the process after one profile's turn, ~224 MiB after three profiles' turns — so no
  process per profile. Keys reach every profile through the process environment (Hermes reads
  a profile's `.env`, then the environment); the hub's `providers:` blocks are written into
  every profile's `config.yaml`. A missing profile is made on first use as a copy of `default`.
  A resume in a profile adopts a conversation an older hub left in the default store (Hermes's
  own `_resume_adopt_stranded`). The tool pages act on the selected profile's home since
  PR #80, so stage 3 is complete.
- Observed while building stage 3: in Hermes v2026.9.14 `--clone-from` **does** copy
  `memories/MEMORY.md` and `memories/USER.md` (`hermes_cli/profiles.py` §_CLONE_SUBDIR_FILES) —
  the Context above says it does not; sessions and channels are still not copied.

## Consequences
- A Hermes profile whose name a hub slug cannot carry (`_`, or longer than 40) is not listed;
  it is logged once. Widening `ProfileSlug` touches every event schema and is its own change.
- Until stage 3, a conversation in any workspace still runs in Hermes's default profile.

## Alternatives rejected
- **Parse `hermes profile list`.** A table for people; the directory read is Hermes's own rule
  and needs no Python on every page load.
- **Copy files into `profiles/<name>/` from the hub.** Hermes decides what a profile and a
  clone are (and changes it: the channel stripping, the tombstones); running Hermes keeps it
  Hermes's decision.
