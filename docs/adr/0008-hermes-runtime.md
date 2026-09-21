# ADR 0008 — How the hub reaches Hermes: a supervised child, over its API server

Status: accepted (2026-09-21)

## Context
ADR 0006 makes Hermes Agent the always-present runtime and says the image ships
the hub and Hermes only. It left two things open: which of Hermes's three
programmatic surfaces the `hermes` adapter drives, and who starts and watches
the Hermes process inside the container. Hermes is Python (MIT); the hub is
Node. Everything below was read from Hermes's public documentation and MIT
source (`docs/inspirations/hermes-agent.md` has the URLs), never from the
owner's Studio fork (ADR 0004).

Facts that shaped the decision:

- Hermes's **API server** (`gateway/platforms/api_server.py`, port 8642) is one
  platform of the single long-lived `hermes gateway run` process. It exposes a
  run surface built for exactly our use: `POST /v1/runs` (202 + `run_id`),
  `GET /v1/runs/{id}/events` (SSE with `message.delta`, `reasoning.available`,
  `tool.started`/`tool.completed`, `approval.request`, `subagent.*`, and one
  terminal `run.completed | run.failed | run.cancelled | run.interrupted`
  carrying `output`, `usage` and the served `runtime`), `POST …/approval`
  (`{ choice }`), `POST …/stop`. A client-chosen `session_id` names the
  conversation; Hermes loads that transcript on the next run.
- The API server is **enabled by the presence of a strong `API_SERVER_KEY`**
  (≥ 16 characters, not a placeholder) in the gateway's environment
  (`gateway/config_env.py`); it refuses to start without one. `GET /health` is
  unauthenticated; everything else takes `Authorization: Bearer <key>`.
- The **TUI gateway JSON-RPC** surface is richer (steer, clarify questions,
  multi-attach) but is a WebSocket mounted inside the dashboard/desktop apps
  with an identity model of its own, and its documentation is thinner. ACP
  (`hermes acp`) would make Hermes "just another coding agent" and lose the
  session continuity, usage and approval semantics the run surface has.
- `hermes gateway run` runs in the foreground, reads `HERMES_HOME`, `API_SERVER_*`
  and its provider keys from the environment and from `HERMES_HOME/.env` /
  `config.yaml`, exits non-zero when nothing connects, and keeps per-profile
  state under `HERMES_HOME`. Hermes's own image runs it under s6 and warns:
  never two gateways on one home.

## Decision
1. **The adapter drives the API server run surface.** `start()` opens a
   conversation with `session_id = majlis-<hub session ulid>`; every turn is
   one `POST /v1/runs` plus its SSE stream; approvals and stops go to the run's
   endpoints. The TUI gateway stays a later option for steering and clarify
   questions; ACP is not used for Hermes.
2. **The hub supervises Hermes as a child process** (`hermes-runtime.ts`), not
   a sidecar container. On boot, in this order:
   - a gateway already answers `GET /health` at the endpoint → **external**:
     the hub uses it and owns nothing (a developer's own Hermes, or a second
     container the owner chose to run);
   - a `hermes` executable is on `PATH` → **managed**: spawn
     `hermes gateway run` with `HERMES_HOME=${DATA_DIR}/hermes`, a hub-minted
     `API_SERVER_KEY` (`${DATA_DIR}/keys/hermes-api.secret`, 0600),
     `API_SERVER_HOST=127.0.0.1`, `API_SERVER_PORT=8642`; pipe its stdout and
     stderr into the hub's logger; restart on exit with backoff (1 s … 60 s,
     reset after a minute of health); probe `/health` on an interval and
     reflect the state on the registry row (`agent.updated`); stop it with
     the hub (SIGTERM, then SIGKILL after 10 s);
   - neither → **absent**: the registry shows Hermes as not configured
     (ADR 0006) and everything else keeps working.
3. **The image bundles Hermes as a pinned git tag** installed with `uv` into
   `/opt/hermes/.venv` with a standalone CPython 3.12, on top of the Node
   runtime layer. No dashboard, no TUI, no Playwright, no messaging extras:
   the hub is the UI. The API server needs only Hermes's core dependencies.
4. **Secrets stay on Hermes's side of the line.** Model provider keys are set
   with `hermes config set …` / `hermes model` against `${DATA_DIR}/hermes`
   (or by editing `.env` there), never stored in the hub's database or passed
   through the hub's API. The only secret the hub owns is the API server key
   it minted, which never leaves the data volume and is never logged.
5. `agents.restart` restarts the managed child; for an external or absent
   runtime it answers `409 state_invalid` rather than pretending.

## Alternatives rejected
- **Sidecar container on 8642** (Hermes's official image next to the hub):
  two images to version, two volumes to explain, and the owner's rule that
  upgrades replace one image. Kept as the "external" mode for people who
  already run Hermes.
- **Hub inside Hermes's image**: 6 GB with browsers and ffmpeg, s6 as PID 1,
  and the hub would be a guest in another project's supervision tree.
- **TUI gateway WebSocket as the primary surface**: better steering and
  questions, but no documented standalone startup, an identity model made for
  the desktop app, and everything the run surface gives us it gives too. It is
  the right second step, not the first.
- **Chat Completions**: stateless, no approvals, no tool structure.

## Consequences
- One image, one volume: `${DATA_DIR}/hermes` holds memory, skills, sessions,
  provider keys; `${DATA_DIR}/keys/hermes-api.secret` the API key.
- An external gateway must be given the same key file (or the hub's key
  written into its environment); `docs/DEPLOY.md` says how.
- The event mapping Hermes → contract is a pure function (`runner.ts`),
  tested frame by frame against a scripted Hermes; the real conversation is
  a gated test (`HERMES_E2E=1`) that spends tokens only when asked.
- Free-text answers to agent questions (`clarify`) are not reachable over the
  run surface; the hub answers `409 state_invalid` for `answer` without a
  `decision` until the TUI gateway surface is added.
