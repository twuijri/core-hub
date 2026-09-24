# ADR 0015 — Hermes's dashboard is an internal API, started on demand

Status: proposed (2026-09-24; the owner proposed running Hermes's own dashboard inside the
container instead of calling private functions)

## Context
The Tasks board mirrors Hermes's kanban through its CLI (`hermes kanban …`, PR #38 and the
kanban bridge). The CLI moves cards, but it cannot **edit a card's title or body**, delete
it, comment, reassign it or terminate its run. Hermes can do all of that — through its
dashboard's kanban plugin API (`plugins/kanban/dashboard/plugin_api.py` in Hermes's MIT
source): `PATCH /api/plugins/kanban/tasks/{id}` (title, body, priority, status, assignee),
`DELETE /tasks/{id}`, `POST /tasks/{id}/comments`, `POST /tasks/{id}/reassign`,
`POST /runs/{id}/terminate` and more. Today the hub answers `409 hermes_owns_text` because
the edit would be overwritten at the next read.

What was measured (2026-09-24, image `v2026.9.14` of Hermes):

- `hermes dashboard --skip-build` refuses to start in our image, which prunes the web UI:
  "--skip-build was passed but no web dist found at …/hermes_cli/web_dist". With a stub
  `index.html` it starts.
- **`hermes serve`** is the headless form of the same command (`cmd_dashboard` with
  `headless_backend`): the same FastAPI app and the same plugin routes, no UI to build or
  mount — it is what Hermes's desktop app starts as its backend. It starts in the image **as
  it ships**, no stub needed. `--port 0` lets the OS pick the port, and Hermes prints
  `HERMES_BACKEND_READY port=N` on stdout once the socket is bound.
- Every non-public call needs `X-Hermes-Session-Token: <token>`; the token is
  `HERMES_DASHBOARD_SESSION_TOKEN` from the environment, else random per start
  (`hermes_cli/web_server.py` §_resolve_session_token). Without it: `401`, even on the
  loopback.
- With the token, a `PATCH` of an Arabic title and body and a priority was read back by
  `hermes kanban show --json`; `POST …/comments` answered `{"ok": true}`; a bad status came
  back as `400 {"detail": "unknown status: bogus"}`.
- Cost, sealed image, as the hub's user, beside a running hub and gateway
  (`scripts/image-sealed-check.mjs`, two runs): **ready in 1.0–3.8 s, 132–133 MiB
  resident**. From the real-Hermes test on this machine: first call including the container
  start and the `PATCH` **1.2 s**, 173–175 MiB for the whole container; a restart plus a
  board read 1.2–1.3 s.
- Hermes's own idle exit (`web_server_idle_exit.py`) applies only to the desktop app's SSH
  backends; nothing stops a plain `serve` but its parent.
- At start the server also seeds bundled skills and starts discovery of configured MCP
  servers in the background (`_dashboard_prepare_runtime`) — the same as `hermes dashboard`.
  A backend that believes the desktop app spawned it (`HERMES_DESKTOP=1`) also ticks cron
  in-process.

## Decision
1. **The hub runs `hermes serve --host 127.0.0.1 --port 0` as an internal API**, never
   exposed to users or to the network. It is a child of the hub beside `hermes gateway run`,
   against the same `HERMES_HOME`, in the agents module (`agents/hermes-dashboard.ts`).
2. **Only where the hub supervises Hermes** (`managed`). An external or absent Hermes has no
   dashboard; the composition hands out `null` and callers keep what they do today.
3. **On demand**: started by the first call (callers that arrive during the start share it),
   stopped after **10 minutes** without a call (a constant in code), started again by the
   next call, started again when it died, stopped with the hub. A call that could not
   connect because the server had just died is retried once on a fresh one; nothing else is
   retried.
4. **A token the hub mints once**, `${DATA_DIR}/keys/hermes-dashboard.secret` (0600, like the
   API server key), handed to Hermes in its environment and sent on every call. It is never
   logged, never on a command line, never returned by any hub API. `HERMES_DESKTOP` is
   removed from the child's environment, so cron is never ticked twice.
5. **Hermes's words**: an error answer becomes `HermesDashboardRefusal` carrying Hermes's
   `detail` verbatim and its status, so a refusal reads the way the CLI's refusals do
   (`tasks/hermes-kanban.ts` §HermesRefusal). No server to call is
   `HermesDashboardUnavailable`.
6. **No image change.** `serve` needs no web UI, so the image stays as sealed as it is; the
   sealed-image check proves the server starts there, refuses a call without the token,
   answers one with it, and changes nothing under `/app` or `/opt/hermes`.

## Alternatives rejected
- **Call Hermes's private kanban functions through `python -c`.** Works today, but binds the
  hub to Hermes's internals (`kanban_db.*`, direct SQL in the plugin), which Hermes changes
  without notice; the plugin API is the surface Hermes's own UI depends on.
- **`hermes dashboard` with a stub `web_dist/index.html` built into the image.** The owner's
  first plan, and it works; but it adds a file whose only job is to satisfy a check, when
  `serve` is the documented headless mode of the very same server.
- **An always-on dashboard.** 130–170 MiB for as long as the hub runs, for edits that happen
  a few times a day.
- **Exposing Hermes's dashboard to people.** A second UI with its own look, its own sign-in
  and a second path to every setting; the hub is the UI (ADR 0006).

## Consequences
- While it runs: one more Python process, ~130–170 MiB, which goes away after 10 idle
  minutes. Configured MCP servers are started by it too while it runs.
- The first call after an idle stop waits for the start: ~1–4 s measured.
- One more secret in `/data/keys`. Anyone who can read the data volume could call the API —
  the same as the API server key beside it, and only on the container's loopback.
- One server for the root home. One server per Hermes profile (`--isolated`) and profile
  routing are out of scope; Hermes keeps one kanban for every profile, so the Tasks mirror
  does not need them.
- A Hermes upgrade is checked by the real-Hermes test (`hermes-dashboard.real.test.ts`) and
  the sealed-image check against the new image.
- **First user: the Tasks board (2026-09-24).** A Hermes card's title, description and
  priority (`PATCH …/tasks/{id}`), its deletion (`DELETE`), comments (`POST …/comments`, the
  person's display name as `author`), handing it to another workspace's profile (`POST
  …/reassign`, with `reclaim_first` when it is running) and stopping its run (`POST
  …/runs/{run_id}/terminate`, or `…/reclaim` when there is no run) go through this server;
  opening a card reads it and its comments with `GET …/tasks/{id}`. The hub's priorities map
  to Hermes's integers as `low -1`, `normal 0`, `high 1`, `urgent 2` (read back: below zero is
  low, two and up is urgent). Opening the board calls `warm()`, which starts the server in the
  background and counts as a use, so the ten idle minutes run from the last time anyone looked.
  `tasks/hermes-api.real.test.ts` runs those writes through the hub's routes against the image.
