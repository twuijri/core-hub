# ADR 0029 — The model gateway: every coding agent runs on any model connected once in the hub

Status: **Accepted** by the owner, 2026-09-29 (the hybrid of the research in
`docs/research/model-gateway-2026-09.md`, PR #228). Phase 0 is DECISIONS §139; phase 1 is
DECISIONS §140. The details of phase 1 listed there as "proposed — owner to confirm" are the
implementer's choices inside this decision.

## Context
The owner's goal, in his words: any agent in Core Hub can talk to any model connected once in the
hub. Before this, a person added a provider once (ADR 0010) and the hub handed each coding agent only
the key of its own vendor — Claude Code an Anthropic key, Codex an OpenAI key — and the model picked
in the composer for a coding agent was never applied. The agents speak three different wires
(Anthropic Messages, OpenAI Responses, OpenAI Chat Completions), and most providers speak one or two
of them, so "any model" needs a translator.

The research compared building our own translator (weeks of work, tools, streaming and thinking in
three wires) with the off-the-shelf ones. CLIProxyAPI (router-for-me/CLIProxyAPI, MIT, Go, one static
binary of ~66 MB, ~20–23 MB compressed per platform) translates every pair of those wires, tools and
streaming included, and serves API-key upstreams of every kind the hub stores.

## Decision

### 1. Two pieces: our gateway in front, CLIProxyAPI behind it
```
agent ──(session token, model "corehub-main")──▶ hub gateway (127.0.0.1, its own port)
          ├─ token → profile, person, agent, conversation, current turn
          ├─ alias → the model the person picked for the turn → h<provider row>/<model>
          └──(the hub's internal key)──▶ CLIProxyAPI (127.0.0.1) ──(the row's real key)──▶ provider
```
- **The front door is ours**, in the hub's process (`modules/models/gateway/`): it knows the tokens,
  the turn, the provider rows and the usage ledger; CLIProxyAPI knows none of that.
- **CLIProxyAPI only translates.** The hub writes its whole configuration from the stored providers:
  loopback only, a random port, one client key only the hub knows, each provider row one upstream
  group routed by the prefix `h<row id>` (`force-model-prefix`), its chat models listed. Its management
  API and control panel are off (an empty secret key), no OAuth credential is ever given to it (its
  subscription sign-ins stay off: the hub never runs its login flags and its OAuth folder stays empty),
  plugins, LAN discovery, request logs and usage statistics are off.
- **Keys stay in the hub.** The one copy of provider keys outside the encrypted `secrets` table is
  CLIProxyAPI's configuration file, written `0600` in `<DATA_DIR>/gateway/` (`0700`) and removed when
  the process stops. An agent is handed only the gateway's address and its session token.
- **Hermes-held subscriptions are not lent** (the owner): a provider signed in to through Hermes
  (`auth_kind` `oauth`: ChatGPT/Codex, xAI, MiniMax, Nous) is never an upstream.

### 2. Routes (loopback only, not the hub's API port)
`POST /gateway/anthropic/v1/messages` (with `?beta=true`), `POST
/gateway/anthropic/v1/messages/count_tokens`, `HEAD|GET /gateway/anthropic/api/hello`,
`GET /gateway/anthropic/v1/models`, `POST /gateway/openai/v1/responses`,
`POST /gateway/openai/v1/chat/completions`, `GET /gateway/openai/v1/models`. They are an internal
surface between the hub and the programs it starts, not part of `/api/v1`: a listener of their own on
`127.0.0.1`, so a reverse proxy, a tunnel or the LAN — which reach the hub's port — never reach them;
a peer that is not loopback is refused as well. Errors come back in the envelope of the agent's own
wire; a provider's error passes through as it came (status, `retry-after`, body), because Claude Code
recovers by the provider's wording.

### 3. Tokens
One per agent process, minted when the hub starts it, 256 random bits, held in memory only, bound to
{profile, person, agent, conversation}; revoked when the hub closes the session, dead as soon as the
process exits, expired after 24 hours in any case. The runner sets the token's current turn (run id,
provider row, model) before each prompt and clears it after.

### 4. Model selection: aliases resolved per turn
Agents are started with fixed names (`corehub-main`, `corehub-small`); the gateway resolves either —
and any id it does not know, such as a vendor default a subagent asks for — to the model the turn
chose (the picker's choice, else the agent's default in the profile). A catalogue key
(`openrouter/qwen/…`) names its own model. The picker works for every coding agent with no switch
inside the agent.

### 5. Model source per agent
Each coding agent the gateway wires has a setting `model_source`: Automatic, the hub's models, or its
own account. In the container image Automatic is the hub (`COREHUB_AGENT_MODEL_SOURCE=hub`; the
owner: in Docker every coding agent uses the gateway); on a computer (the desktop app) it is the hub
unless the agent is signed in to its own account there. Whatever is chosen, an agent keeps its own
account when the hub has no model to give it — so nothing that worked before stops working. The card
says which one is in use (`Agent.model_source`).

### 6. Usage
The gateway reads each answer's usage as it streams past (unchanged) and reports the turn's running
totals per model into the run, priced from the model row (`estimated`). A call that ends after its turn
is added to that run's ledger row (`recordUsage` gains `accumulate`).

### 7. Shipping CLIProxyAPI
One pin (`scripts/cliproxy/pin.json`: version, one file and SHA-256 per platform), one script
(`scripts/cliproxy/fetch.mjs`) that refuses a file whose hash differs. The image downloads the Linux
build of its platform in its own stage into `/opt/corehub/bin` (root's, read-only to the hub). The
desktop installers carry their platform's build in `resources/cliproxy/` (after-pack) — rather than a
download on first use, because it is 14–23 MB per installer, works offline, and adds no code that
downloads and runs a program at runtime. A developer runs `pnpm cliproxy:fetch`. The hub supervises it
like Hermes's gateway: lines in its log under `cliproxy`, restarted with a backoff, stopped with the
hub. A change of providers starts a new process with the new file and stops the old one after its last
request (CLIProxyAPI 8.0.4 does not reliably reload its file), so no stream is cut.

## Consequences
- Claude Code runs on any provider the hub has — tested with a provider that speaks only Chat
  Completions, a tool call included — and Codex likewise through the Responses path. Anthropic does not
  support Claude Code on non-Claude models; features that call Anthropic directly (WebSearch's server
  tool, fast mode) do not work there.
- The image grows by ~22.6 MB compressed (68.3 MB on disk); each installer by ~14–23 MB.
- CLIProxyAPI is third-party code the hub runs. It is pinned, hash-checked, loopback-only and fed only
  what the hub writes; moving the pin is a reviewed change with the real-agent test in CI.
- Gemini CLI (Gemini wire), Grok Build and Pi are not wired yet (phases 2–3).

## Alternatives
- **Our own translator only** (the research's first recommendation): weeks, and the hardest parts
  (tools across wires, streaming state machines, thinking) are what CLIProxyAPI already does. It stays
  possible behind the same front door.
- **CLIProxyAPI alone, agents pointed at it directly:** its client keys are static and shared, it knows
  nothing of profiles, turns or the ledger, and it would need the picker's model name in every agent.
- **LiteLLM:** ~390 MB and Python dependencies; new-api: AGPL.
- **Lending Hermes-held subscriptions** through the gateway: refused by the owner.
