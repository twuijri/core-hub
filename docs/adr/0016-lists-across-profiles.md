# ADR 0016 — Lists gather every profile; the selector is for creating and filtering

Status: accepted for stage 1 (2026-09-24, owner: «ايه», «كل البروفايلات افتراضيا», «نعم»);
two choices below are proposals the owner still has to confirm (§Decisions for the owner).
Builds on: ADR 0005 (workspaces are a filter), ADR 0014 (a workspace is a Hermes profile).
Refines, without superseding: ADR 0005's "switching workspace changes the header and
refetches" — it still does, but the lists no longer hide every other profile.

## Context
With two profiles, the owner's "designer" chats only showed after switching the top profile
selector to "designer", and going back to the "default" chats took another switch. The
selector did three jobs at once — which chats are listed, where a new chat is made, and
which profile's configuration a page edits — so seeing everything meant switching all day.

The Tasks board already stopped doing this on 2026-09-23 (`tasks.getColumns` is global: one
board for every profile, each card naming its `profile`, a `profile` filter on the page).

## The owner's words (2026-09-24)
Asked three questions, the owner answered:

1. Lists gather every profile the person may enter, each item with a badge of its profile;
   the top selector is for creating (a new chat or task is made in the selected profile) and
   for filtering? — «ايه».
2. What do the lists show on entering the app? — «كل البروفايلات افتراضيا» (all profiles by
   default, not the last profile chosen).
3. Does search always search across all of the person's profiles? — «نعم».

## Decision
1. **Who "all" is, is the server's rule.** Owners and admins enter every profile; a member
   the ones they are enrolled in (an empty enrolment is every profile) — `auth`'s
   `listWorkspacesFor`, the same rule `X-Hub-Profile` is checked with. No client sends the
   list; nothing "all" returns could not have been reached one header at a time.
2. **Contract:** `sessions.list` takes `profiles=all`. The page then holds every profile the
   caller may enter, each item names its own `profile`, and the header must still name one
   of them. Paging is one keyset (`last_message_at desc`, `id`) over all of them in one
   statement, so pages neither repeat nor skip. Search is the same operation with `q`, so it
   crosses profiles the same way and each hit carries its `profile` and `match`. Without
   `profiles`, the list is exactly what it was. (docs/contracts/DECISIONS.md §28.)
3. **Realtime:** the handshake's `profiles: 'all'` joins the room of every profile the person
   may enter, by the same rule, on top of the handshake's `profile`. Envelopes already name
   their `profile`; `seq` stays per (namespace, profile), so a client resuming a session keeps
   the highest `seq` of that session's profile only (the web's reducer does).
4. **An item is opened in its own profile.** Every call about a session carries that
   session's `profile` in `X-Hub-Profile`. The web does it with a scope, not with the
   selector: `ProfileScope` gives everything inside a page — transcript, composer, models,
   agents, approvals — the item's profile, while the frame around it (`ChromeScope`: the
   sidebar, the top bar) keeps speaking for the person. Opening a designer chat never moves
   the selector, and the chats list stays as it was. The address carries the profile
   (`/chat/<id>?profile=designer`) once the person has more than one profile, so a reload or
   a shared link opens the chat where it lives; with one profile the addresses are unchanged.
5. **The selector.** On a list page (new chat, chat, search) it offers *All profiles* — the
   default on every entry into the app, kept in memory only, so a reload starts on *All*
   again — and each profile, which narrows the lists and becomes where new chats are made.
   With one profile there is no *All* and no badge.
6. **Per-profile configuration pages** (Models and providers, the agents' skills, MCP, memory
   and settings, Settings) edit one profile. There the selector shows a concrete profile and
   offers no *All*: it says which profile is being edited, and choosing another changes what
   the page edits — and where new things are made — without changing what the lists show.
7. **Search** always searches every profile, whatever the selector says; each result shows
   its profile's badge and opens in that profile.

## Stages
1. **This ADR (web):** the chats list, search, the selector's two meanings, realtime for
   every permitted profile, and opening an item in its own profile.
2. **Tasks and Schedules:** the board opens on *All* by default with a badge per card (it is
   global already, with its own filter), and opening a task's conversation uses the item's
   profile instead of switching the selector (`TasksScreen.openSession` still calls
   `setProfile(task.profile)` today). The Schedules page the same. Not in this PR: another
   PR touching the Tasks screen was open.
3. **Clients:** desktop behaves as the web. Phones: where the selector lives is not decided
   (docs/clients/NAVIGATION.md: the owner does not want a permanent top bar there); the
   contract and the realtime handshake are already what they need.

## Decisions for the owner
- **Where "New chat" is made while *All* is selected:** in the person's own profile — the
  last profile they chose, else their default (`default_profile`). The new-chat screen says
  so ("New chat in: Default") whenever there is more than one profile, and changing it there
  changes where the chat is made. Proposed; the alternative is to ask every time.
- **Choosing a profile on a configuration page does not narrow the lists** (it only says which
  profile the page edits, and where new things are made). Proposed as the least surprising:
  the lists keep the view the person left them in.

## Consequences
- A list across profiles is one SQL statement over `workspace IN (…)`; the existing index on
  `(workspace, archived_at, last_message_at)` still serves each profile's part.
- The sessions socket of a person with several profiles receives every profile's
  `session.*` and `approval.*`. A client must apply events by the `profile` they name.
- A socket's rooms are fixed when it connects: a profile created, or an enrolment granted,
  after that is heard from the next reconnect (the web rebuilds its sockets when the person's
  profile changes).
- Links into a chat that carry no `profile` (notifications, a task's conversation) still open
  in the person's own profile, as before; they gain the item's profile in stage 2.

## Alternatives rejected
- **One list per profile, with switching** — what we had: it is the problem the owner raised.
- **Merging the profiles' configuration** (one set of models, agents and settings for all):
  a profile is a Hermes profile (ADR 0014) with its own config, keys and memory; gathering
  the lists does not mean mixing what each profile is.
- **`X-Hub-Profile: *`** — every other scoped operation would have to refuse it; the list is
  the one place "all" means something.
- **A second, global list operation** beside `sessions.list` — two lists with the same filters
  and cursor, drifting apart.
- **Opening another profile's chat by switching the selector** (what `openSession` does for
  tasks today) — it silently changes where the next chat is made and what the lists show.
