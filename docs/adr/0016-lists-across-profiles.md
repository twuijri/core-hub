# ADR 0016 — Lists gather every profile; the top selector is the profile you are in

Status: accepted for stage 1 (2026-09-24, owner: «ايه», «كل البروفايلات افتراضيا», «نعم»,
then the correction «المفروض ما فيه خيار الكل. خيار الكل كان لتصنيف المحادثات بس…» and
«كل البروفايلات تكون بس لتصنيف المحادثات بس. الكرون جوب والمهام المفروض تطلع كل البروفايلات
بدون تصنيف»).
Builds on: ADR 0005 (workspaces are a filter), ADR 0014 (a workspace is a Hermes profile).
Refines, without superseding: ADR 0005 — the header still names the profile a request acts
in, but the lists no longer hide every other profile.

## Context
With two profiles, the owner's "designer" chats only showed after switching the top profile
selector to "designer", and going back to the "default" chats took another switch. The
selector did three jobs at once — which chats are listed, where a new chat is made, and
which profile's configuration a page edits — so seeing everything meant switching all day.

The Tasks board already shows every profile on one page (`tasks.getColumns` is global since
2026-09-23, each card naming its `profile`), with a profile filter on the page.

## The owner's words (2026-09-24)
Asked three questions, the owner answered:

1. Lists gather every profile the person may enter, each item with a badge of its profile? —
   «ايه».
2. What does the chats list show on entering the app? — «كل البروفايلات افتراضيا» (all
   profiles by default).
3. Does search always search across all of the person's profiles? — «نعم».

A first build put "All profiles" into the top selector. The owner corrected it: «المفروض ما
فيه خيار الكل. خيار الكل كان لتصنيف المحادثات بس… المفروض يفتح على اختيار البروفايل الي انا
عليه من فوق الصفحة على اليمين» — there is no "All" in the top selector; "All" was only for
sorting the chats; the app opens on the profile the person is in. And then: «كل البروفايلات
تكون بس لتصنيف المحادثات بس. الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون تصنيف» —
the "All / one profile" filter is for the chats only; schedules and tasks show every profile
with no filter at all.

## Decision
1. **The top selector is the profile the person is in** — always one concrete profile, never
   "All". The app opens on it (the last profile chosen, else the person's default, as before).
   New chats are made in it, and every per-profile configuration page (Models and providers,
   the agents' skills, MCP, memory and settings, Settings) edits it. It never filters a list.
2. **The chats list has its own filter**: "All profiles" — the default on every entry into the
   app, kept in memory only — or one profile. It belongs to the list (a small control at its
   top), is hidden for someone with one profile, and it and the top selector never move each
   other. Rows carry a badge of their profile whenever more than one profile is on screen.
3. **Search always searches every profile**, whatever the list filter or the top selector say;
   each result shows its profile's badge and opens in that profile.
4. **Tasks and Schedules show every profile, with no profile filter** (stage 2): each card or
   schedule carries its profile's badge when more than one profile is visible. The Tasks
   board's existing profile filter goes away then. The "All / one profile" filter exists on the
   chats list only.
5. **Who "all" is, is the server's rule.** Owners and admins enter every profile; a member the
   ones they are enrolled in — `auth`'s `listWorkspacesFor`, the same rule `X-Hub-Profile` is
   checked with. No client sends the list; nothing "all" returns could not have been reached
   one header at a time.
6. **Contract:** `sessions.list` takes `profiles=all`. The page then holds every profile the
   caller may enter, each item names its own `profile`, and the header must still name one of
   them. Paging is one keyset (`last_message_at desc`, `id`) over all of them in one
   statement, so pages neither repeat nor skip. Search is the same operation with `q`. Without
   `profiles`, the list is exactly what it was. (docs/contracts/DECISIONS.md §28.) The list
   filter narrowed to one profile is an ordinary list with that profile in the header.
7. **Realtime:** the handshake's `profiles: 'all'` joins the room of every profile the person
   may enter, by the same rule, on top of the handshake's `profile`. Envelopes already name
   their `profile`; `seq` stays per (namespace, profile), so a client resuming a session keeps
   the highest `seq` of that session's profile only (the web's reducer does).
8. **An item is opened in its own profile.** Every call about a session carries that
   session's `profile` in `X-Hub-Profile`. The web does it with a scope, not with the
   selector: `ProfileScope` gives everything inside a page — transcript, composer, models,
   agents, approvals — the item's profile, while the frame around it (`ChromeScope`: the
   sidebar, the top bar) keeps speaking for the person. Opening a designer chat never moves
   the top selector nor the list filter. The address carries the profile
   (`/chat/<id>?profile=designer`) once the person has more than one profile, so a reload or a
   shared link opens the chat where it lives; with one profile the addresses are unchanged.
9. **New chat** is made in the top selector's profile. The new-chat screen names it ("New chat
   in Default. To start it in another profile, switch the profile at the top of the page.")
   whenever there is more than one profile, and offers no second picker: one control decides
   where things are made, so nothing can disagree with it.

## Stages
1. **This ADR (web):** the chats list with its own filter, search across profiles, the top
   selector as the concrete profile, realtime for every permitted profile, and opening an item
   in its own profile.
2. **Tasks and Schedules:** both pages show every permitted profile with **no** profile
   filter (the Tasks board's filter dropdown is removed), each card and schedule with its
   profile's badge when more than one profile is visible; opening a task's conversation uses
   the item's profile instead of switching the top selector (`TasksScreen.openSession` still
   calls `setProfile(task.profile)` today). **Built 2026-09-24** (DECISIONS §32,
   `docs/changes/2026-09-24-twuijri-tasks-schedules-all-profiles.md`).
3. **Clients:** desktop behaves as the web. Phones: where the top selector lives is not
   decided (docs/clients/NAVIGATION.md: the owner does not want a permanent top bar there);
   the contract and the realtime handshake are already what they need.

## Consequences
- A list across profiles is one SQL statement over `workspace IN (…)`; the existing index on
  `(workspace, archived_at, last_message_at)` still serves each profile's part.
- The sessions socket of a person with several profiles receives every profile's
  `session.*` and `approval.*`. A client must apply events by the `profile` they name.
- A socket's rooms are fixed when it connects: a profile created, or an enrolment granted,
  after that is heard from the next reconnect (the web rebuilds its sockets when the person's
  profile changes).
- Links into a chat that carry no `profile` (notifications, a task's conversation) still open
  in the person's own profile, as before; the task's gains the item's profile in stage 2.

## Alternatives rejected
- **One list per profile, with switching** — what we had: it is the problem the owner raised.
- **"All profiles" in the top selector** — built first, corrected by the owner: the top
  selector is where you are and where things are made; a filter of the chats is the chats'.
- **A profile filter on Tasks and Schedules** — the owner wants every profile there, no filter.
- **A second "new chat in" picker** — two controls deciding where a chat is made can
  disagree; the top selector is the one.
- **Merging the profiles' configuration** (one set of models, agents and settings for all):
  a profile is a Hermes profile (ADR 0014) with its own config, keys and memory; gathering
  the lists does not mean mixing what each profile is.
- **`X-Hub-Profile: *`** — every other scoped operation would have to refuse it; the list is
  the one place "all" means something.
- **A second, global list operation** beside `sessions.list` — two lists with the same filters
  and cursor, drifting apart.
- **Opening another profile's chat by switching the selector** (what `openSession` does for
  tasks today) — it silently changes where the next chat is made.
