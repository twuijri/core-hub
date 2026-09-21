# What works today

Measured on this branch by asking a booted hub which contract operations are
still the built-in 501 stub. Regenerate it the same way after a phase:
every operation that answers `501 not_implemented` is not built yet.

**64 of 245 contract operations are implemented.** Nothing fakes a success:
an unbuilt operation answers `501` with its operation id.

| module | implemented | total | what that means |
|---|---|---|---|
| auth | 32 | 32 | sign-in, refresh, users, workspaces, app tokens, QR pairing, profiles |
| sessions | 17 | 29 | sessions, messages, streamed runs, approvals, resume; attachments and session categories are not built |
| agents | 11 | 40 | registry, curated catalog, install/remove/upgrade, discovery, restart; the Hermes-gateway screens (skills, MCP, memory, channels, plugins, presets) are not built |
| jobs | 3 | 3 | list, get, cancel, with `/rt/jobs` events |
| meta | 1 | 2 | health |
| models | 0 | 23 | providers, keys, catalogue, defaults, speech — in progress (ADR 0010) |
| tasks | 0 | 27 | the Tasks section |
| rooms | 0 | 28 | several agents in one room |
| schedules | 0 | 23 | scheduled and recurring work |
| devices | 0 | 17 | device registry and push |
| notify | 0 | 11 | notifications and webhooks |
| updates | 0 | 7 | in-app updates |
| knowledge | 0 | 1 | documents and attachments |
| audit | 0 | 1 | the usage report screen |
| plugins | 0 | 1 | plugin bindings |

## Clients
- **Web** (`packages/web`): login, chat with streaming, approvals and resume,
  sessions list, agents, settings, pairing. Screens whose module is still 501
  say so explicitly instead of showing an empty page.
- **Terminal** (`packages/cli`): the reference client — login, pairing,
  agents, sessions, an interactive `chat` with resume and approvals.
- Desktop, Android and iOS: not started (ADR 0007, ADR 0009).

## Runtime
Hermes runs inside the image, supervised by the hub (ADR 0008), and a run
reaches it over its real API. A model provider must be configured before it
can answer; until then a run fails with Hermes's own message. Coding agents
install on demand from the curated catalog into the data volume (ADR 0006).

## Proven against fakes, not yet against the real thing
- A full turn with a real model reply (needs a provider key on the owner's box).
- The catalog's pinned versions actually installing and starting on a machine.
- PostgreSQL: the schema is SQLite-shaped so far; the hub refuses rather than
  pretending.
