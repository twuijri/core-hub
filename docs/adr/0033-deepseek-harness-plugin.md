# ADR 0033 — A Core Hub plugin for DeepSeek Harness: the harness on the person's computer, linked to their hub

Status: **Accepted** by the owner, 2026-11-22. What the owner decided:
- Build a plugin for DeepSeek Harness (`@deepseek-ai/dsh`).
  - It links the harness on his computer to his Core Hub server.
  - The harness gets the hub's models through the hub's gateway.
  - He can talk to Hermes on the server, with its memory and MCP, from inside the harness. He can also talk to the harness itself, which then uses only the hub's models.
  - The server's Hermes can reach his computer's files, MCP programs and screen through the plugin.
- The plugin should, in the near future and at least for the owner, be able to replace the Core Hub desktop app.
  - For now it lives **beside** the app. Replacing the app is a later decision.
- Screen work follows the approach he approved:
  - Hermes never drives the screen itself. It hands the plugin a task in words.
  - The plugin runs a local harness session with Computer Use, on a hub model.
  - It returns the outcome and one screenshot.
- Every phase listed in this ADR is approved («كمل كل المراحل»).

The details below that the owner did not name are the implementer's choices.

## Context
The desktop app (ADR 0020, 0021, 0022, 0025) links a computer to a hub on a server. The owner
would rather not keep growing it and closing its holes when a strong desktop harness already
exists. DeepSeek Harness is MIT-licensed, describes itself as "Everything is a Plugin", and ships
as Electron on macOS and Windows plus a web UI on any OS. It has Computer Use on macOS, which the
owner tried on 2026-11-22. Its own Computer Use only acts inside PTC mode.

What the harness offers a plugin. This comes from its documentation, read on 2026-11-22 (see
`docs/inspirations/README.md`); no code was copied.
- **What a plugin is:** a Cordis plugin in an npm package that registers through `ctx`.
- **What a plugin can add:**
  - tools
  - model adapters, and provider rows written through the bundle's config patch
  - slash commands
  - hooks around the agent and its tools
  - MCP servers
  - UI slots: settings pages, sidebar tabs and chat nodes
- **Where it runs:** in the host's Node process, with no sandbox. The desktop host keeps running while its window is hidden.
- **Its own model settings:** a "Custom model API" row takes a base URL, a key and a wire (OpenAI Chat Completions or Responses, Anthropic Messages). It fills its model list from `GET /models`.
- **Stability:** the harness is a developer preview. A release candidate comes out every one to five days, each with breaking-change guides. A plugin declares the harness versions it supports in `engines.dsh`, and the harness refuses one outside that range.

What the hub already had:
- **The pairing claim** (§15): it gives a client the person's app token and a device.
- **The device link** (ADR 0025): an outbound Socket.IO connection to `/rt/devices`. The hub asks it through device requests (§74) and it answers `files` and `apps`.
- **The conversations API:** used by every client.
- **The model gateway** (ADR 0029): on **loopback only**, for the agents the hub itself starts, with per-process session tokens.
- **Missing:** a way into the gateway from outside the hub, and anything that acts on a screen. ADR 0025 §11 left screen control out.

## Decision

### 1. One plugin package in this repository
`packages/dsh-plugin`:
- **Package:** a harness bundle (`package.json` with `dsh.bundle`), written in TypeScript and built to JavaScript.
- **Name:** taken from `PRODUCT` / `derived` where the code names the product.
- **Installing:** `dsh plugin --profile <profile> add <path|tarball|github:…>`.
- **Harness versions:** pinned in `engines.dsh` to the release candidates it was tested with. A newer harness is tried and the range widened by a change record, never by hope.
- **Contract:** it is a client of the contract like `packages/cli`. Its types are generated from `packages/contracts`, never hand-typed.

### 2. Linking: the pairing claim, nothing new
- **How the person links:**
  1. They create a pairing on the hub (the web's device-linking flow).
  2. They give the plugin the pairing (its JSON or link, or the hub address plus id and code) from the plugin's settings page or with `/corehub link`.
  3. The plugin claims it.
- **What the claim returns:** the person's app token and a device whose platform says it is the harness.
- **Where the plugin keeps them:** a file only the person can read (`0600`) in its own data folder under the harness profile. The token goes nowhere else: not to the page, not into the harness's config patch, and not into logs.
- **Token renewal and refusals:** the token is renewed the way the other apps renew theirs. A token the hub refuses stops the link until the person links again.

### 3. The hub's models, from outside the hub
The hub gets a second way into its gateway: a new **external entrance** on the hub's own API port, declared in the contract.
- **Who may use it:**
  - It is off until an admin switches it on.
  - Its bearer is the person's app token or personal token, never a session token of the loopback gateway.
- **What it serves:** the same wires the loopback gateway serves:
  - OpenAI Chat Completions and Responses, with `GET …/models`
  - Anthropic Messages
- **Models offered:** those the person may pick in the hub, by their hub ids. Profile-only providers are offered only to people who may enter that profile.
- **What stays the same:**
  - Keys never leave the hub.
  - Hermes-held subscriptions are still never lent (ADR 0029).
  - Gemini Desktop answers as it does for the hub's own agents.
- **Usage:** recorded in the usage ledger under the person, with the source `external`.
- **Limits and refusals:** a per-token rate limit applies. A refusal is an error in the caller's own wire.

The plugin writes one "Core Hub" provider row into the harness's profile config, with the entrance's address and a key the plugin holds. The harness's own "Fetch models" then lists the hub's models.

### 4. The computer, for the hub: the device link from the plugin
The plugin keeps the same outbound `/rt/devices` link the desktop app keeps (ADR 0025 decision 1). It answers:
- **`files`:**
  - The folders the person shares in the plugin's settings, read-only unless marked writable.
  - The same tools and limits as the helper (ADR 0022).
- **`apps`:**
  - The MCP servers configured in the harness profile, each off until the person picks the profiles it serves.
  - Calls go through the harness's own MCP manager.
  - Long calls answer `running` and `status`, as in ADR 0025.

Consent is asked on the computer, once per session per program, as ADR 0025 decision 8 says. It uses the harness's own approval prompt where the harness offers one to plugins, and a native dialog otherwise. Every call goes into the plugin's activity list.

### 5. Screen tasks: the agent asks in words, the computer does the work
- **A new device capability, `screen_task`:**
  - Added to the capability kinds. It is additive, and old devices never advertise it.
  - A hub tool for it: `devices.screen_task`.
  - It is a write, so it needs the "Your computers" group's "allow changes".
- **What the agent sends:** a task in words, plus optional limits (an app to stay in, a time budget).
- **What the plugin does:**
  1. It asks the person on the computer (Allow / Deny), every task.
  2. It starts a local harness session in PTC mode with Computer Use, on a hub model chosen by the hub's defaults or the request.
  3. It runs the task.
  4. It answers with a short outcome and one final screenshot. The hub turns the screenshot into an attachment of the conversation.
- **Long tasks** answer `running` with progress, and `devices.run_status` returns the end, as for programs.
- **The screen never streams to the hub, and the hub never sends clicks.**
- **Platforms:** macOS now, Windows when the harness supports it. Elsewhere the device does not advertise `screen_task`.

### 6. Talking to Hermes from inside the harness
- **The plugin adds:**
  - `/hermes <message>`, which sends the message to a hub conversation and shows the answer.
  - A tool, `corehub_ask_agent`, so the harness's own agent can hand a question to the hub's agent and read its answer.
- **The conversation:** both use the conversations API with the person's token, in the profile they picked. One hub conversation follows one harness session, so Hermes keeps the thread, its memory and its MCP.
- **Later, a sidebar tab:** lists the person's hub conversations and continues one in place.

### 7. The desktop app stays
Nothing in the desktop app is removed or changed by this ADR. Whether the plugin replaces it, for the owner or for everyone, is decided later, after the plugin and the harness have settled.

## Alternatives rejected
- **Opening the hub's MCP server (`hub-mcp`) to the outside:** it trusts loopback and per-run tokens (§79). Opening it would hand its tools to whoever holds a person's token, outside any conversation.
- **Streaming the screen to the hub and sending clicks from there:** this is the riskiest permission there is. It moves the screen off the computer and doubles the latency. The harness already runs Computer Use well on the computer itself.
- **Forking the harness, or shipping it inside the desktop app:** we would own a fast-moving preview's code. A plugin only owns its own.
- **Replacing the desktop app now:** it is in the stores and carries local mode and Ollama (ADR 0032). Pulling it would break people who run it (ADR 0027).

## Consequences
- **Breaking changes in the harness:** the harness breaks its plugin API every few releases, so the plugin is pinned and moved forward deliberately. A harness outside the range refuses to install the plugin rather than half-loading it.
- **The external gateway entrance:** it is a new surface on the hub's public port. It is off by default, bound to a person's token, rate-limited and recorded. An admin who never switches it on gets nothing new.
- **Device answers and screen tasks:** a device's answers keep the same limits whether the app or the plugin gives them. `screen_task` is the first capability that acts on the screen, and it asks every time.
- **Platforms:** on Linux the harness has no desktop build and no Computer Use. There the plugin offers models, Hermes and the device link, but not screen tasks.
