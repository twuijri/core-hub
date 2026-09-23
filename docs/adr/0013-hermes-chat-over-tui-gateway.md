# ADR 0013 — Hermes conversations over its TUI gateway, not the API server's run surface

Status: accepted (2026-09-23, owner: «ايه طبق الي تقول»)
Supersedes: the **conversation** half of ADR 0008. The supervised `hermes gateway run`
process, its API server and everything else ADR 0008 decides stay as they are.

## Context
ADR 0008 chose Hermes's API server run surface (`/v1/runs`) for conversations, and set the
TUI gateway aside as "a WebSocket mounted inside the dashboard/desktop apps … its
documentation is thinner". Using `/v1/runs` for a day of real conversations on the test
stack showed what that surface does not carry, each seen by the owner:

- **No reasoning.** `reasoning.available` on `/v1/runs` is the first 500 characters of the
  reply's own text (`_relay_thinking(agent, content)`, `agent/turn_response_intake.py`),
  so "Thought for 44s" repeated the answer; the adapter now drops it (PR #43).
- **No tool results.** `tool.completed` carries a name, a duration and an error flag; every
  tool row said "No output".
- **No questions.** Hermes's `clarify` tool (a question, up to four choices, a free-text
  answer) has no callback on the API server, so the model is told it is unavailable and
  writes the choices as text. The owner wants them as a card, like Codex and Claude.

Reading Hermes's MIT source again (never the owner's Studio fork, ADR 0004):

- The TUI gateway is **not** only a dashboard WebSocket. `python -m tui_gateway.entry` runs it
  over **stdio**: newline-delimited JSON-RPC both ways, `gateway.ready` first. The WebSocket
  (`/api/ws`) is a second transport of the same dispatcher (`tui_gateway/ws.py`).
- It is Hermes's **own** conversation surface: the TUI, the desktop app and the dashboard's
  chat all use it (`tui_gateway/AGENTS.md`).
- Its wire is **declared**: every method, event and server→client request is a Pydantic
  model, rendered to `apps/shared/src/gateway-contract.openrpc.json` (215 methods, 67 events,
  13 request kinds) and checked by Hermes's own tests.
- What we need is in it: `session.create` / `prompt.submit` / `session.interrupt`;
  `message.delta`, **`reasoning.delta`**, `tool.start` (full `args`), `tool.complete`
  (`result_text`, `duration_s`), `message.complete` (text, usage, status); and the requests
  **`clarify`** (`{question, choices}` → `{answer}`, `""` = skip) and `approval`.
- `clarify` waits `agent.clarify_timeout` seconds (`config.yaml`; 3600 by default, `≤ 0` =
  never). The owner accepted a five-minute limit (2026-09-23).
- It runs in the image as it ships: `docker run … python -m tui_gateway.entry` answered
  `gateway.ready` against `ghcr.io/twuijri/majlis:latest` on 2026-09-23.

## Decision
1. **Conversations with the Hermes agent go through the TUI gateway over stdio.** The hub
   supervises one `python -m tui_gateway.entry` child per hub, beside `hermes gateway run`,
   with the same `HERMES_HOME` and the same provider environment, restarted when it exits
   and when the providers change. One hub session is one TUI gateway session; its id is kept
   so the next turn continues the same conversation.
2. **The API server stays** for what only the gateway process does: messaging platforms,
   Hermes's cron (`/api/jobs`, ADR-less bridge PR #42), the kanban dispatcher, health.
3. **A Hermes reached from outside** (ADR 0008's `external` mode) keeps `/v1/runs`, because
   stdio needs the process beside the hub. It loses reasoning, tool output and questions,
   and says so rather than inventing them.
4. **Questions are questions.** `clarify` becomes an approval of kind `question`
   (`answer_mode: both`) that the web draws as a card above the composer: the question, the
   choices, a line to write one's own, Skip and Send. Skip answers `""`, as Hermes defines.
   While a run waits on a person the hub's silence timer does not run (PR in this change).
5. The conversation (text, reasoning, tools, approvals, stop) and the questions land
   together: the questions were the reason for the change, and the real-Hermes test covers
   both in one turn.

## Alternatives rejected
- **Stay on `/v1/runs` and add a hub tool for questions** (an MCP `ask_user` the hub serves to
  Hermes). Smaller, and it was started, but it leaves Hermes's own `clarify` unused, needs the
  hub to guess which conversation an MCP call belongs to, and fixes neither reasoning nor tool
  output.
- **Ask Hermes to add `clarify` to its API server.** The right fix upstream, and not ours to
  schedule; the TUI gateway already has it.
- **The dashboard's WebSocket (`/api/ws`) instead of stdio.** Same dispatcher, plus a third
  process and a session-token identity model to carry; stdio needs neither.

## Consequences
- A second Hermes process in the container. Both are Hermes's own and share one home, as
  Hermes's dashboard and gateway already do.
- The wire is Hermes's declared contract. The adapter reads the declared fields defensively
  (an absent field is an absent value, never a crash), and a Hermes upgrade is checked by the
  real-Hermes test against the new image (the release pins one Hermes tag, ADR 0008).
- Tests: a unit fake that speaks the same frames, and a real-Hermes test that runs the image's
  `tui_gateway` with a scripted OpenAI-compatible model standing in for the provider, so
  `clarify` is exercised end to end without a key.
