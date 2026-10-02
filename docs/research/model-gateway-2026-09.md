# Research: a model gateway so every agent runs on any connected model

Status: research, 2026-09-29. No product code. The recommendation in §5 is **proposed — owner to confirm**.
Facts about third-party agents and providers were checked against current official docs or source on 2026-09-29. Each carries a link. Anything not verified says so.

## 0. The problem in one paragraph

The owner wants every coding agent the hub hosts to run on any model the person connected once in the hub. The agents are Claude Code, Codex CLI, Gemini CLI, Goose, OpenCode, Grok Build, Kimi Code, Pi, Qwen Code, the builtin Direct agent and Hermes. It should work without each agent needing its own vendor sign-in. Today it does not, for two reasons found in the code (§1). First, the hub only hands a vendor's key to that vendor's agent. Second, the model a person picks for an ACP agent is never applied at all. Most agents cannot talk to "any" provider even when told to, because each speaks one wire format (§2). Anthropic Messages, OpenAI Responses and Gemini `generateContent` are three different APIs. The fix is a translating gateway inside the hub (§6).

---

## 1. What the hub does today (code findings)

All paths are under `packages/server/src/modules/`.

1. **Keys only go to the matching vendor's agent.**
   - Each catalog entry (`agents/catalog/*.ts`) declares `credentials: { family → ENV_VAR }`. `models/propagation.ts` §`agentEnvironment()` copies only the declared families into the child's environment.
   - Examples: `claude-code` gets `anthropic → ANTHROPIC_API_KEY` only; `codex` gets `openai → OPENAI_API_KEY` only; `gemini-cli` gets `google → GEMINI_API_KEY`; `grok-build` gets `xai → XAI_API_KEY`. `kimi-code` gets nothing, because it reads no key from the environment. `goose`, `opencode` and `pi` get every standard variable the hub holds.
   - **No base URL is ever injected.** An OpenAI-compatible provider row (CLIProxyAPI, LiteLLM, Groq, LM Studio, a custom endpoint) therefore never reaches any ACP agent.
   - Claude Code with no Anthropic row starts with no credential and fails "Authentication required".
2. **The model picked for an ACP agent is never applied.**
   - `agents/service.ts` §`selectionFor()` resolves the composer's `"<provider>/<model>"` key per turn into `AgentTarget.model / modelProvider / modelProviderId`. Only the Hermes adapter and the builtin Direct adapter read them.
   - `agents/adapters/acp.ts` does not read them: no `session/set_model`, no env, no config.
   - So "a Gemini model chosen for Claude Code" cannot work today even in principle. The pick is silently ignored and the agent uses its own default.
3. **⚠ Security gap, worth fixing on its own, independent of the gateway: every ACP agent inherits the hub's whole process environment.**
   - `agents/adapters/acp.ts` §`agentEnvironment()` builds the child env as `{ ...host.inherited, ...target.env }`, and `app/config.ts` §`readHostEnv()` sets `inherited` to the entire `process.env`.
   - Whatever the hub process was started with therefore reaches every third-party CLI: database URL, relay settings, any secret an operator put in the container env.
   - The catalog's own rule ("an entry that declares nothing inherits nothing") is honoured for provider keys but not for the host environment.
   - Fix: an allow-list (`PATH`, `HOME`, `LANG`/`LC_*`, `TZ`, `TMPDIR`, proxy variables, `NODE_EXTRA_CA_CERTS`/`SSL_CERT_*`, plus what each catalog entry declares). This is small and independent. It should ship before the gateway, because the gateway's design relies on "the agent only sees a hub token".
4. **Reusable pieces already exist.**
   - `models/adapters/` has streaming chat for Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Google and Ollama, plus an SSE reader (`stream.ts`).
     - They carry text, images and reasoning only. **There are no tools**: `ChatEvent` has no tool-call event (ADOPTION-BACKLOG §2.16).
     - A gateway therefore needs a tool-aware internal format. The adapters can be extended, not reused as-is.
   - `models/signed-in-chat.ts` already *borrows* a Hermes-held sign-in for one turn, without storing it. It runs Hermes's resolver, which returns wire, base URL, headers and model:
     - `openai-codex` → the Codex backend's Responses API;
     - `xai-oauth` → xAI Responses;
     - `nous` → Chat Completions;
     - `minimax-oauth` → Anthropic Messages with Bearer.

     The gateway can use this so a ChatGPT/Codex subscription serves every agent while its token never leaves the hub.
   - Usage ledger: `audit/service.ts` §`recordUsage()` writes to `usage_records`.
     - The table has one row per (run, model label): input, output, cache-read, cache-write and reasoning tokens, and micro-USD cost.
     - Cost comes from `models/service.ts` §`costOf(pricing, event)`.
     - A gateway token bound to a run can accumulate into exactly this.
5. **Process fact.** The image already ships a standalone CPython 3.12 and a venv under `/opt/hermes` (`packages/server/Dockerfile`), so a Python sidecar would add only its wheels. The desktop app's local mode ships the hub as a small Node bundle (ADR 0021, about 28 MB), where a Python sidecar is not free.

Also relevant:
- Both ACP bridges the catalog pins are **deprecated and renamed** (checked with `npm view` on 2026-09-29):
  - `@zed-industries/claude-code-acp@0.16.2` → `@agentclientprotocol/claude-agent-acp` (0.84.0, Apache-2.0);
  - `@zed-industries/codex-acp@0.16.0` → `@agentclientprotocol/codex-acp` (2.0.0, Apache-2.0).
- The new versions have an ACP-native "gateway" auth method (§2.2). That is the cleanest way to wire them, and moving the pins is a prerequisite for phase 1.

---

## 2. Per agent: wire format and how to point it elsewhere

Legend for wire formats: **AM** = Anthropic Messages (`/v1/messages`), **OC** = OpenAI Chat Completions, **OR** = OpenAI Responses, **GG** = Google Gemini `generateContent`.

### 2.1 Summary table

| Agent (catalog id) | Speaks | Custom endpoint? | How to point it at the hub (verified names) |
|---|---|---|---|
| Claude Code (`claude-code`, via ACP bridge) | **AM only** (Bedrock/Vertex variants aside) | Yes, officially ("LLM gateway") | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (Bearer), `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`; or the bridge's ACP `gateway` auth method |
| Codex CLI (`codex`, via codex-acp) | **OR only** (chat removed Feb 2026) | Yes | `config.toml` `[model_providers.<id>]` `base_url`, `env_key`, `wire_api="responses"`; `model_provider`, `model`; via `-c` or codex-acp `CODEX_CONFIG`; or the ACP `gateway` auth method |
| Gemini CLI (`gemini-cli`) | **GG only** | Yes: dedicated "gateway" auth type | `GOOGLE_GEMINI_BASE_URL` (HTTPS unless localhost), `GEMINI_API_KEY` (sent as `x-goog-api-key`), `GEMINI_MODEL` |
| Goose (`goose`) | OC (auto-switch to OR for o*/gpt-5+), AM, Ollama; many native providers | Yes | `GOOSE_PROVIDER`, `GOOSE_MODEL`, `OPENAI_HOST` + `OPENAI_BASE_PATH` + `OPENAI_API_KEY`, or `ANTHROPIC_HOST` + `ANTHROPIC_API_KEY`; or `~/.config/goose/custom_providers/<name>.json` |
| OpenCode (`opencode`) | Any AI-SDK provider: OC (`@ai-sdk/openai-compatible`), OR (`@ai-sdk/openai`), AM, GG | Yes | `OPENCODE_CONFIG_CONTENT` (inline JSON) with `provider.<id>.npm/options.baseURL/options.apiKey/models`, `model`, `small_model` |
| Qwen Code (`qwen-code`) | OC (default), OR, AM, GG | Yes | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`; or `ANTHROPIC_BASE_URL`/`_API_KEY`/`_MODEL` |
| Grok Build (`grok-build`) | Selectable per model: OC, OR or AM (`api_backend`) | Yes | `~/.grok/config.toml` (`$GROK_HOME`) `[model.<id>] api_backend, base_url, model, env_key, context_window` + `[models] default`; env `GROK_MODELS_BASE_URL`, `GROK_DEFAULT_MODEL`, `XAI_API_KEY` |
| Kimi Code (`kimi-code`) | Selectable: `kimi`/`openai` (OC), `openai_responses`, `anthropic`, `google-genai`, `vertexai` | Yes | Env-only temporary model: `KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_PROVIDER_TYPE` (`kimi`/`anthropic`/`openai`), `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_MAX_CONTEXT_SIZE`, `KIMI_MODEL_CAPABILITIES`; or `~/.kimi-code/config.toml` (`KIMI_CODE_HOME`) |
| Pi (`pi`, via `pi-acp`) | Selectable per provider `api`: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, … | Yes | `~/.pi/agent/models.json` `providers.<id>.{baseUrl, api, apiKey ("$ENV" / literal / "!cmd"), models[]}` |
| Direct (`direct`) | The hub's own adapters (AM, OC, OR, Google, Ollama) | n/a: in-process | Nothing to wire; already reads the workspace's providers per turn |
| Hermes (`hermes`) | Its own provider layer (OC, OR, AM, native providers) | Yes | Already wired by `propagation.ts` (`.env` + `config.yaml` `providers:` blocks) |

Conclusion from the table:
- **Every agent except Direct and Hermes needs one of three inbound formats: AM, OR or OC.** Gemini CLI alone needs GG.
- Claude Code (AM) and Codex (OR) are *fixed*.
- Goose, OpenCode, Qwen Code, Grok Build, Kimi Code and Pi can each be pointed at an OC or AM endpoint.
- A hub gateway that serves **AM + OR + OC** inbound covers ten of the eleven agents. GG inbound is needed only for Gemini CLI.

### 2.2 Claude Code (through the ACP bridge)

Sources:
- [LLM gateway overview](https://code.claude.com/docs/en/llm-gateway)
- [Gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Connect to a gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- [env vars](https://code.claude.com/docs/en/env-vars)
- Bridge: [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) (npm `@agentclientprotocol/claude-agent-acp` 0.84.0, Apache-2.0)

**Wire format**
- AM only.
- Anthropic's own policy: it "doesn't support routing Claude Code to non-Claude models through any gateway". Non-Claude models behind a translating gateway work in practice, but Anthropic does not support them. The UI should say so.

**Endpoints a gateway must serve**
- `POST /v1/messages` (sent as `/v1/messages?beta=true`, so match on the path) is required.
- `POST /v1/messages/count_tokens` is optional. Without it, Claude Code falls back to a character estimate for `/context`.
- `HEAD /api/hello` is a warm-up probe that may be rejected.
- `GET /v1/models?limit=1000` is only called with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. It has a 3 s timeout, fails on any redirect, and keeps only ids containing "claude" or "anthropic". Discovery is useless for non-Claude models; the hub's own picker must drive the model.

**Credential**
- `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer` and wins without an interactive prompt.
- `ANTHROPIC_API_KEY` is sent as `x-api-key`, but needs a one-time approval in interactive mode.
- `apiKeyHelper` is a settings command with a 5-minute cache (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). It is the rotation hook if short-lived tokens are wanted.
- **Setting a credential variable replaces a person's claude.ai subscription login for those requests.** That matters for "no breaking changes" (§6.6).

**Models**
- `ANTHROPIC_MODEL` sets the main model. `--model` and `/model` override it.
- `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` set the aliases. `ANTHROPIC_SMALL_FAST_MODEL` is deprecated in favour of `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- With `ANTHROPIC_AUTH_TOKEN`, background tasks run on the **main** model unless `ANTHROPIC_DEFAULT_HAIKU_MODEL` is set.
- `CLAUDE_CODE_SUBAGENT_MODEL` is not on the current env-vars page (unverified).

**Unrecognised model ids (i.e. every non-Claude id)**
- Claude Code assumes a current Claude model: 200K context, and sends `thinking: {"type":"adaptive"}`, `output_config` (effort) and `context_management`.
- Client-side mitigations:
  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` strips pre-release betas and their fields.
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set the context size.
  - `modelOverrides` in settings maps capabilities.
- `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` has **no effect** behind `ANTHROPIC_BASE_URL`.
- A translating gateway must drop or translate these fields either way.

**Streaming and headers**
- Unbuffered SSE with the full event sequence through `message_delta` and `message_stop`, forwarding `ping`s. The stream aborts after 300 s of silence, so a translator must emit its own pings during long upstream thinking pauses.
- Return `content-type: text/event-stream`, an integer `retry-after`, and pass through `x-should-retry`.
- Forward error bodies unmodified. Claude Code's automatic recovery matches the upstream's wording, e.g. dropping `thinking` after a rejection.
- Forward `anthropic-version` / `anthropic-beta` verbatim to an Anthropic upstream, and forward `cache_control` wherever it appears. Do not flatten `system` to a string.
- Useful informational headers for accounting: `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`.
- `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` adds `x-claude-code-request-class` (`main`/`subagent`/`compaction`/`auxiliary`), which lets the gateway route auxiliary calls to a cheaper model.

**Attribution block**
- Claude Code prepends an attribution block as the first `system` entry. Only api.anthropic.com strips it, so any other upstream sees it.
- Since v2.1.181 it is stable per conversation (cache-safe). `CLAUDE_CODE_ATTRIBUTION_HEADER=0` omits it.

**Traffic outside the gateway**
- Fast-mode availability checks and the WebFetch domain safety check call `api.anthropic.com` directly. Remote Control is disabled with a custom base URL.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off updates, telemetry, error reporting and feature flags (any non-empty value counts, including `0`).

**The bridge passes the environment through**
- The current bridge builds Claude Code's environment as `{...process.env, ...options.env, ...providerEnv, …}` and uses `settingSources: ["user","project","local"]`. So `ANTHROPIC_*` set on the bridge process reaches Claude Code, and `~/.claude/settings.json` `env` also applies.
- Per-session overrides go in `_meta.claudeCode.options` (including `env` and `model`). The model can also be switched through ACP session config options (`query.setModel()`).
- **ACP-native gateway auth.**
  - If the client advertises `clientCapabilities.auth._meta.gateway: true`, the bridge offers auth methods `gateway` (Anthropic protocol) and `gateway-bedrock`.
  - `authenticate` then takes `_meta.gateway.baseUrl` + `headers`, and the bridge sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` and a placeholder `ANTHROPIC_AUTH_TOKEN`, clearing other credential routes.
  - I checked this in the 0.84.0 package's `dist/acp-agent.js`. The pinned 0.16.2 (`@zed-industries/claude-code-acp`, deprecated on npm) has neither the gateway method nor the `settingSources` behaviour.

### 2.3 Codex CLI (through codex-acp)

Sources:
- [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [openai/codex](https://github.com/openai/codex) (`codex-rs/model-provider-info/src/lib.rs`)
- [chat-completions deprecation discussion #7782](https://github.com/openai/codex/discussions/7782)
- Bridge: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp) (npm `@agentclientprotocol/codex-acp` 2.0.0, Apache-2.0; the pinned `@zed-industries/codex-acp` is deprecated and its repo archived)

**Wire format**
- **OR only.** `wire_api = "chat"` was deprecated on 2025-12-09 and is a hard config error since February 2026 ("support is fully removed").
- The `ollama-chat` provider is gone too.
- A Chat-Completions-only provider (Groq's stable API, Mistral, most OpenAI-compatible servers) therefore needs **R→C translation**.

**Configuration**
- In `$CODEX_HOME/config.toml`:
  - Top-level keys: `model`, `model_provider`, `model_context_window`, `model_reasoning_effort`, `model_supports_reasoning_summaries`.
  - `[model_providers.<id>]` keys: `name`, `base_url`, `env_key`, `wire_api="responses"`, `http_headers`, `env_http_headers`, `query_params`, `request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms`.
  - `auth = {command, args, refresh_interval_ms, …}` is a command-backed token, usable for rotation.
- Built-in provider ids cannot be overridden; add a new id.
- `-c key=value` overrides any key.
- Security-relevant: a project-local `.codex/config.toml` **cannot** set `model_provider`, `model_providers`, `openai_base_url` or `profiles`, so a repository cannot redirect the agent away from the hub.
- `OPENAI_BASE_URL` as an environment variable has no reader in current source (the catalog comment in `codex.ts` should not rely on it); `openai_base_url` in config is the documented path.

**Bridge**
- codex-acp spawns Codex with the full environment and reads `CODEX_API_KEY` (which wins over `OPENAI_API_KEY`), `CODEX_CONFIG` (JSON merged into the session config) and `MODEL_PROVIDER`.
- It also has an ACP `gateway` auth method with `_meta.gateway.protocol: "openai"`, `baseUrl`, `headers`, `providerName`.

**Needs from the gateway**
- `POST {base}/responses` with Responses SSE: output items, `function_call` items and their argument deltas, reasoning items and summaries, `encrypted_content`.
- The model catalogue comes from the Codex backend unless `base_url` or `model_catalog_url` is set.

### 2.4 Gemini CLI

Sources: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/reference/configuration.md` and `packages/core/src/core/contentGenerator.ts` (v0.61.0; the catalog pins 0.60.0).

**Wire format**
- GG only (`generateContent` / `streamGenerateContent`, also `countTokens` and `embedContent`), through `@google/genai`.

**Custom endpoint**
- Supported: setting `GOOGLE_GEMINI_BASE_URL` selects a dedicated `gateway` auth type. It must be HTTPS unless the host is localhost, 127.0.0.1 or [::1], which suits a loopback hub gateway.
- In gateway mode the key is sent as `x-goog-api-key`. `GEMINI_API_KEY_AUTH_MECHANISM=bearer` does not apply to the gateway type.
- `GEMINI_CLI_CUSTOM_HEADERS` adds headers.
- `GEMINI_MODEL` or `-m` sets the model, default `auto`. The router and utility tasks use flash-lite aliases, so a gateway must accept those ids or the model must be pinned. Which ids it calls in gateway mode is unverified.

**ACP**
- `--acp`. The catalog's `--experimental-acp` still works but is deprecated.
- In ACP, `GOOGLE_GEMINI_BASE_URL` or a client-supplied `authDetails.baseUrl` selects gateway auth.

### 2.5 Goose

Sources: [aaif-goose/goose](https://github.com/aaif-goose/goose) docs `getting-started/providers.md`, `guides/config-files.md` (v1.52.0, the pinned version).

**Selection**
- `GOOSE_PROVIDER` + `GOOSE_MODEL`; the environment overrides `config.yaml`.
- The OpenAI provider reads `OPENAI_HOST` (root only), `OPENAI_BASE_PATH` (default `v1/chat/completions`), `OPENAI_API_KEY` and `OPENAI_CUSTOM_HEADERS`. It auto-switches to `/v1/responses` for model names like `o*`/`gpt-5*` or a base path containing `responses`.
- The Anthropic provider reads `ANTHROPIC_HOST` and `ANTHROPIC_API_KEY`.

**Custom providers**
- `~/.config/goose/custom_providers/<name>.json` with keys `engine` (`openai`|`anthropic`|`ollama`), `base_url` (full path), `api_key_env` or `auth` (command), `models[{name, context_limit}]`, `headers`, `supports_streaming`.
- Keys are never read from `config.yaml`.
- `GOOSE_TOOLSHIM` exists for models without native tool calls.

**Env-only wiring for the hub**
- `GOOSE_PROVIDER=openai`, `OPENAI_HOST=<gateway>`, `OPENAI_BASE_PATH=gateway/openai/v1/chat/completions`, `OPENAI_API_KEY=<hub token>`, `GOOSE_MODEL=<id>`.
- Beware the model-name heuristic that flips to Responses. The explicit `chat/completions` path forces Chat.

### 2.6 OpenCode

Sources: [opencode.ai/docs/providers](https://opencode.ai/docs/providers/), [/docs/config](https://opencode.ai/docs/config/), [/docs/acp](https://opencode.ai/docs/acp/) (repo now `anomalyco/opencode`).

**Configuration**
- Any AI-SDK provider package, configured in JSON:
  `{"provider":{"corehub":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"…","apiKey":"{env:COREHUB_GATEWAY_TOKEN}"},"models":{"<id>":{"limit":{"context":…,"output":…}}}}},"model":"corehub/<id>","small_model":"corehub/<id>"}`
- `OPENCODE_CONFIG_CONTENT` (inline JSON) has the highest precedence except managed settings, so the hub can inject the whole block through the environment without touching files.
- `OPENCODE_DISABLE_MODELS_FETCH` stops the models.dev fetch (source flag).
- `limit` must be declared for models it does not know.
- Whether `@ai-sdk/anthropic` honours `baseURL` in OpenCode was inferred from the AI SDK, not re-checked on the docs page.

### 2.7 Qwen Code

Sources: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) `docs/users/configuration/auth.md`, `model-providers.md`.

**Environment**
- OpenAI-compatible: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
- Anthropic: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.
- Gemini: `GEMINI_API_KEY`, `GEMINI_MODEL`.

**Settings and precedence**
- `~/.qwen/settings.json` `modelProviders.*[]` entries carry `{id, envKey, baseUrl, wireApi, generationConfig}`.
- Precedence: `/auth` > selected modelProvider > CLI flags > env > settings. A person's own `modelProviders` selection would win over hub env, so the hub should not fight it.

**Thinking**
- `extra_body.enable_thinking` on Chat.
- `reasoning.effort` on Responses.

### 2.8 Grok Build

Sources: [docs.x.ai/build/settings](https://docs.x.ai/build/settings), [settings reference](https://docs.x.ai/build/settings/reference), [xai-org/grok-build](https://github.com/xai-org/grok-build) (Apache-2.0). The community `superagent-ai/grok-cli` is a different product and is not the one in the catalog.

**Configuration**
- `$GROK_HOME/config.toml` (default `~/.grok`), with `[model.<id>] api_backend = "chat_completions" | "responses" | "messages"`, `base_url`, `model`, `env_key` (or `api_key`), `context_window`, and `[models] default`.
- Environment variables: `XAI_API_KEY`, `GROK_MODELS_BASE_URL`, `GROK_MODELS_LIST_URL`, `GROK_DEFAULT_MODEL`.
- A gateway vendor (TrueFoundry) documents the same keys for pointing it at a gateway.
- How far env alone can define a non-xAI model (without a `[model.<id>]` block) is not verified. Plan on a hub-owned block in a hub-owned `GROK_HOME`, or a managed-marker merge like the Hermes `.env`.

### 2.9 Kimi Code

Sources: [config files](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html), [providers](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html), [env vars](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html).

- Kimi Code does **not** read provider keys from the shell environment, as the catalog already notes. It does, however, have an **env-only temporary model**: `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` (both required), `KIMI_MODEL_PROVIDER_TYPE` (`kimi`/`anthropic`/`openai`), `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_MAX_CONTEXT_SIZE` (default 262144), `KIMI_MODEL_CAPABILITIES`.
- That is exactly the hook the hub needs, with no file writes.

### 2.10 Pi

Sources:
- [models.md](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/models.md)
- [earendil-works/pi](https://github.com/earendil-works/pi) (MIT)
- ACP adapter [svkozak/pi-acp](https://github.com/svkozak/pi-acp) (MIT; spawns `pi --mode rpc`)

**Configuration**
- Custom providers live in `~/.pi/agent/models.json`: `{"providers":{"corehub":{"baseUrl":"…","api":"openai-completions"|"anthropic-messages"|…,"apiKey":"$COREHUB_GATEWAY_TOKEN","models":[{"id":"…","contextWindow":…}]}}}`.
- `apiKey` accepts `$ENV`, a literal, or `!command`.
- A variable to relocate the agent directory was not verified. Plan on writing a hub-owned provider entry into the hub-managed home the agent already runs in.

### 2.11 Direct and Hermes

- **Direct** is the hub's own process and already resolves providers per turn. It needs no gateway, but the gateway's router and translators should be the *same code* the Direct adapter uses once tools arrive there (§2.16 of the backlog).
- **Hermes** already routes to every provider type through `propagation.ts`, and to signed-in providers by its own auth. Routing Hermes through the gateway is **not** recommended: it would only add a hop. Hermes remains the reference implementation of "any model".


---

## 3. Per provider type: formats accepted natively

| Provider (hub catalogue slug) | OpenAI Chat (OC) | OpenAI Responses (OR) | Anthropic Messages (AM) | Gemini (GG) |
|---|---|---|---|---|
| OpenAI (`openai`) | yes | yes | no | no |
| Anthropic (`anthropic`) | "for testing, not production" compat layer; loses thinking, caching, PDFs ([docs](https://docs.anthropic.com/en/api/openai-sdk)) | no | **yes (native)** | no |
| Google Gemini (`google`) | yes, `/v1beta/openai/` ([docs](https://ai.google.dev/gemini-api/docs/openai)) | not documented | no | **yes (native)** |
| xAI (`xai`) | yes, labelled legacy ([docs](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)) | **yes (recommended)** | deprecated `/v1/messages` (unverified, secondary source) | no |
| DeepSeek (`deepseek`) | yes | not documented | **yes**, `https://api.deepseek.com/anthropic` ([docs](https://api-docs.deepseek.com/guides/anthropic_api/)); no `cache_control`, documents or `count_tokens` | no |
| Groq (`groq`) | yes | beta, stateless ([docs](https://console.groq.com/docs/responses-api)) | no | no |
| Mistral (`mistral`) | yes | no (not found) | no | no |
| OpenRouter (`openrouter`) | yes | yes, stateless, beta ([docs](https://openrouter.ai/docs/api_reference/responses/overview)) | **yes**, "Anthropic skin" at `https://openrouter.ai/api` ([docs](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)) | no |
| Ollama (`ollama`) | yes | yes ≥0.13.3, stateless ([docs](https://docs.ollama.com/api/openai-compatibility)) | yes ≥0.14.0 ([docs](https://docs.ollama.com/api/anthropic-compatibility)); no `count_tokens` ([hang report](https://github.com/ollama/ollama/issues/13949)), no `tool_choice`, no caching | no |
| LM Studio (`lmstudio`) | yes | yes ≥0.3.29 ([blog](https://lmstudio.ai/blog/lmstudio-v0.3.29)) | yes ≥0.4.1 ([docs](https://lmstudio.ai/docs/integrations/claude-code)) | no |
| LiteLLM proxy (`litellm`) | yes | yes (bridges to chat) ([docs](https://docs.litellm.ai/docs/response_api)) | yes ("unified" `/v1/messages`, + `count_tokens`) ([docs](https://docs.litellm.ai/docs/anthropic_unified)) | passthrough |
| CLIProxyAPI (owner's; a `openai-compatible` row) | yes | yes | yes, + `/v1/messages/count_tokens` ([routes](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/api/server_routes.go)) | yes |
| Moonshot / Kimi (custom row) | yes | yes | yes, `api.moonshot.ai/anthropic` ([docs](https://platform.kimi.ai/docs/api/overview)) | no |
| Z.ai / GLM (custom row) | yes (unverified) | not found | yes, `https://api.z.ai/api/anthropic` ([docs](https://docs.z.ai/scenario-example/develop-tools/claude)) | no |
| Signed in through Hermes: `openai-codex` | no | **Codex backend Responses** | no | no |
| Signed in: `xai-oauth` | — | **xAI Responses** | — | — |
| Signed in: `nous` | **yes** | — | only for `anthropic/*` when Hermes's `nous.anthropic_wire` is `native` | — |
| Signed in: `minimax-oauth` | — | — | **yes** (Bearer) | — |

The signed-in rows come from `models/signed-in-chat.ts`, which reads what Hermes's resolver returns.

What this means:
- **Passthrough without translation already covers a lot.**
  - Claude Code (AM) works with no translation on Anthropic, DeepSeek, OpenRouter, Ollama, LM Studio, LiteLLM, CLIProxyAPI, Moonshot, Z.ai and a MiniMax sign-in.
  - Codex (OR) works with no translation on OpenAI, xAI, OpenRouter, Ollama, LM Studio, LiteLLM, CLIProxyAPI and a ChatGPT/Codex or xAI sign-in. Groq's Responses support is beta.
- Translation is only *required* for:
  - AM-in → Google, Groq, Mistral, OpenAI, Nous;
  - OR-in → Google, Mistral, DeepSeek, Nous (Groq only while its Responses API is beta);
  - GG-in (Gemini CLI) → anything but Google.
- The owner's own **CLIProxyAPI already accepts AM, OR, OC and GG**. Pointing agents through the hub at it needs no translation in the hub at all.
- The provider catalogue therefore needs one new fact per provider type: **which inbound formats it accepts natively**, with the base path for each (e.g. DeepSeek's `/anthropic`, OpenRouter's `/api`).


---

## 4. Translation: what has to be converted, and the hard parts

### 4.1 Matrix (agent format → provider format)

`=` passthrough (same format; only auth, model name and headers are rewritten); `T` translation needed; `—` not needed in practice.

| Agent speaks ↓ / provider accepts → | AM | OR | OC | GG |
|---|---|---|---|---|
| **AM** (Claude Code; optionally Goose, Qwen, Grok, Kimi, Pi, OpenCode) | = | T (A→R) | **T (A→C)**: the main translator | T (A→G) |
| **OR** (Codex; optionally Grok, Kimi, Pi, OpenCode, Qwen) | T (R→A) | = | **T (R→C)**: the main translator | T (R→G) |
| **OC** (Goose, OpenCode, Qwen, Grok, Kimi, Pi) | T (C→A) | T (C→R) | = | T (C→G) |
| **GG** (Gemini CLI only) | T | T | T | = |

Build it as **hub-in → internal representation → provider-out**, not as N×N converters.

- **Inbound parsers:** AM, OR and OC request bodies → the internal representation; the internal event stream → AM, OR and OC SSE.
- **Outbound drivers:** the internal representation → AM, OR, OC and GG requests; provider SSE → internal events.

Four outbound drivers already exist in text-only form (`models/adapters/`). What is new is the inbound side, and tools and thinking in the internal representation.

Priority order:
1. A→C and R→C. They unlock Claude Code and Codex on every OpenAI-compatible provider, which is the owner's main ask.
2. →G. Google is reachable through its OC compat endpoint as a stopgap, at the cost of thinking fidelity.
3. G-in, only for Gemini CLI.

### 4.2 The hard parts

**Tool calling (both directions)**
- *Shapes.*
  - AM: `tool_use` content blocks `{id, name, input: object}`; results are `tool_result` blocks inside the next **user** message.
  - OC: `assistant.tool_calls[{id, function:{name, arguments: string}}]`; results are separate `role:"tool"` messages keyed by `tool_call_id`.
  - OR: `function_call` output items `{call_id, name, arguments}` and `function_call_output` input items.
  - GG: `functionCall {name, args}` / `functionResponse` parts. Ids are optional or recent, so the translator must synthesise stable ids and map them back.
- *Arguments.* OC and OR stream arguments as partial JSON strings. AM streams `input_json_delta` partial JSON. GG sends a whole object.
  - A→C out: the gateway must re-chunk the upstream's `tool_calls[i].function.arguments` deltas into `content_block_start(tool_use)` + `input_json_delta` + `content_block_stop`.
  - Index bookkeeping is needed for parallel calls. Claude Code **stops reading the stream** on an orphaned or duplicated block event (see its gateway guide).
- *Schemas.*
  - Tool JSON Schemas must be down-levelled for some upstreams. Gemini accepts an OpenAPI subset: strip `$schema`, `additionalProperties`, some `format`s and `oneOf` variants.
  - Strict-mode fields (`strict`, `defer_loading`) are AM/OR betas to drop elsewhere.
- *`tool_choice`.* `auto` / `any` / `tool` (AM) ↔ `auto` / `required` / `{type:function}` (OC/OR). Some providers ignore it (Ollama AM).
- *Server-side tools.* Claude's web search, computer use and code execution cannot be translated, only removed. Claude Code's `WebSearch` tool uses a server tool, so it will fail on non-Anthropic upstreams; the gateway should return a clean error.
- *Quality.* Many open models are poor at long tool loops with Claude Code's large tool set and 20K+ token system prompt. The hub should only list models flagged as tool-capable, and label others.

**Streaming event shapes**
- AM: `message_start` → (`content_block_start` → `content_block_delta` [`text_delta` | `input_json_delta` | `thinking_delta` | `signature_delta`] → `content_block_stop`)* → `message_delta` (stop_reason, usage) → `message_stop`, interleaved with `ping`.
- OC: `chat.completion.chunk`s with `choices[0].delta.{content, tool_calls[], reasoning_content?}` and `finish_reason`, a final usage chunk only if `stream_options.include_usage`, then `data: [DONE]`.
- OR: typed events `response.created`, `response.output_item.added/done`, `response.output_text.delta`, `response.function_call_arguments.delta/done`, `response.reasoning_summary_text.delta`, `response.completed` (with usage) or `response.failed`.
- GG: `streamGenerateContent?alt=sse` chunks of `candidates[0].content.parts` with `usageMetadata`.
- The translator is a small state machine per stream: open and close blocks, count indices, hold usage until the end.
- It must add keep-alive pings on silence for Claude Code (300 s abort) and Codex (`stream_idle_timeout_ms` 300000).

**Thinking / reasoning**
- AM `thinking` blocks carry a `signature` that must be sent back **unmodified** on the next turn. `redacted_thinking` exists too.
- OR reasoning items carry `encrypted_content` (with `include:["reasoning.encrypted_content"]`, `store:false`).
- OC has no standard: DeepSeek uses `reasoning_content`, OpenRouter `reasoning`, some servers `<think>` tags.
- GG 3.x returns `thoughtSignature`s that must be replayed with function calls.
- Across providers these are **not portable**. Rules:
  - (a) Surface upstream reasoning text as AM `thinking_delta` or OR `reasoning_summary_text` for display.
  - (b) Mint no fake signatures. Emit thinking with an empty or placeholder signature only if the agent tolerates it, otherwise present it as text or drop it.
  - (c) On the way back, strip thinking blocks and signatures the upstream did not produce.
- Claude Code already drops thinking after an upstream rejection, which is a safety net.
- Request-side mapping: map AM `thinking`/`output_config.effort` and OR `reasoning.effort` to the upstream's knob (`reasoning_effort`, Gemini `thinking_level`/`thinking_budget`, Qwen `enable_thinking`), and drop them otherwise.

**Images and attachments**
- AM `image` blocks (`source: base64 | url`), `document` blocks (PDF).
- OC `image_url` (data URI or URL).
- OR `input_image` / `input_file`.
- GG `inlineData` / `fileData`.
- Images map cleanly. PDFs do not map to OC for most providers: drop them with a text note, or reject with a clear error.
- Check the model's `vision` capability from the hub's model row before sending.

**Token counting**
- Claude Code's `count_tokens` is optional; it falls back to a character estimate.
- Options:
  - (a) Passthrough to AM upstreams that have it (Anthropic, CLIProxyAPI, LiteLLM, LM Studio).
  - (b) Otherwise return an estimate: chars/4, or a tokenizer if later worthwhile, flagged as estimated in logs.
  - (c) Or return 404 and let Claude Code estimate.
- (c) is phase-1 safe. **Do not proxy it to Ollama**, which is reported to hang.
- Gemini CLI's `countTokens` is similar.

**Prompt caching**
- `cache_control` markers and the `extended-cache-ttl` beta are AM-only. Forward them unchanged to AM upstreams; strip them for others.
- OpenAI, DeepSeek and Gemini cache implicitly by prefix; do not reorder or reshape `system`/`messages`.
- Accounting reads cache tokens from each format's usage fields: AM `cache_read_input_tokens`/`cache_creation_input_tokens`, OC/OR `prompt_tokens_details.cached_tokens`, GG `cachedContentTokenCount`.

**Stop reasons**

| AM | OC | OR | GG |
|---|---|---|---|
| `end_turn` | `stop` | `completed` | `STOP` |
| `tool_use` | `tool_calls` | `completed` with a function_call item | `STOP` with functionCall parts |
| `max_tokens` | `length` | `incomplete` / `max_output_tokens` | `MAX_TOKENS` |
| `stop_sequence` | `stop` | — | — |
| `refusal` | `content_filter` | — | `SAFETY` |

- Claude Code keeps the `stop_reason` from the first `message_delta` that carries it.

**Errors**
- Envelopes differ:
  - AM: `{type:"error", error:{type, message}}` with types `invalid_request_error`, `authentication_error`, `rate_limit_error`, `overloaded_error` (529), `api_error`.
  - OC/OR: `{error:{message, type, code}}`.
- Map status codes faithfully. Keep the upstream's **message text** (Claude Code's recovery matches on wording).
- Send `retry-after` in integer seconds; a value above 60 makes Claude Code stop retrying.
- Mid-stream failure: AM `event: error`; OR `response.failed`.
- Never include the upstream key or URL query in an error.

**Model names**
- Agents send whatever model id they were configured with.
- Recommended: agents are configured with **hub aliases**, and the gateway resolves the alias to the turn's chosen `provider/model` (§6.3).
- Claude Code needs `ANTHROPIC_DEFAULT_HAIKU_MODEL` pointed at an alias too, otherwise background calls hit an id the gateway does not know.
- Codex wants model metadata (`model_context_window`, `model_supports_reasoning_summaries`) for ids it does not know. Pass them with `-c` from the hub's model row.

**Request-field drift**
- Claude Code forwards open lists of betas and body fields; OpenAI adds Responses fields.
- For **passthrough**, forward unknown fields verbatim (Claude Code's guidance).
- For **translation**, use an explicit allow-list of what the internal representation understands, drop the rest, and log dropped field names. That turns silent breakage into a visible log line.


---

## 5. Candidate building blocks

Licences and activity come from the GitHub API and npm on 2026-09-29. Compressed image sizes come from registry manifests (amd64). Core Hub itself is Apache-2.0 (ADR 0018), so MIT and Apache-2.0 components are compatible; AGPL is not acceptable for a bundled component.

| Candidate | Licence | Language | Maturity | Footprint | Inbound formats | Translations | `count_tokens` | Fit for Core Hub |
|---|---|---|---|---|---|---|---|---|
| **CLIProxyAPI** ([router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)) | MIT | Go | ~53.5k★, v8.0.4 released today, very active | image ~77 MB; single static binary | OC, OR (HTTP + WS), AM, GG, Codex backend | Full matrix (`internal/translator/<target>/<source>`) incl. thinking/signature layer | yes | Best off-the-shelf translator. Sidecar only (Go); has a Go SDK. Owner already runs it. Its subscription-OAuth reuse may breach provider terms. The hub would use only its API-key/OpenAI-compatible upstreams. |
| **LiteLLM proxy** ([BerriAI/litellm](https://github.com/BerriAI/litellm)) | MIT (except `enterprise/`) | Python | ~59.9k★, v1.103.0 | image ~390 MB compressed; in our image it could reuse Hermes's CPython but pulls heavy deps | OC, OR, AM (`/v1/messages` unified), GG passthrough | A→anything, R→C (explicitly for Codex), C→anything | yes (accuracy for non-Anthropic unverified) | Broadest coverage, but heavy for the image budget and poor for the desktop app. Supply-chain incident: PyPI 1.82.7/1.82.8 were compromised on 2026-03-24 ([advisory](https://docs.litellm.ai/blog/security-update-march-2026)). Already usable today as a *provider* row. |
| **claude-code-router** ([musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)) | MIT | TS/Node | ~37.5k★, v3.1.1 (2026-09-16) | npm ~35 MB unpacked; now a desktop app + local gateway | OC, OR, AM, GG | yes (thinking and `count_tokens` undocumented) | ? | Product-shaped (its own control plane and profiles). Hard to embed as a library. Its old transformer lib [`@musistudio/llms`](https://github.com/musistudio/llms) has no LICENSE file and was last pushed 2026-01, so it is not reusable. |
| **Portkey gateway** ([Portkey-AI/gateway](https://github.com/Portkey-AI/gateway)) | MIT | TS (Hono) | ~13.1k★, last release 2026-01, last push 2026-05 | image ~62 MB | OC (core); AM `/v1/messages` exists in OSS but only for anthropic/bedrock upstreams per source | C→anything; A→C in OSS unverified; R→C unconfirmed | route exists | Embeddable TS, but the translation we need most (A→C, R→C) is not clearly in the OSS build. |
| **Vercel AI SDK** (`ai` 7.0.122, `@ai-sdk/*`) | Apache-2.0 | TS | very active | `ai` ~7.8 MB unpacked, providers 0.4–3.3 MB each | none: outbound client only | outbound normalisation across OC/OR/AM/GG with tools and reasoning parts | — | A good *outbound* half for our own translator. Inbound parsing and SSE re-encoding must be written by us. |
| new-api ([QuantumNous/new-api](https://github.com/QuantumNous/new-api)) | **AGPL-3.0** + attribution clause | Go | ~49k★, active | image ~78 MB, needs a DB | OC, OR, AM, GG | full matrix | ? | Licence rules it out for bundling. |
| one-api ([songquanpeng/one-api](https://github.com/songquanpeng/one-api)) | MIT | Go | last release Feb 2025 (stale) | ~26 MB | OC only | C→Claude only | no | No AM or OR inbound, so it doesn't solve the problem. |
| y-router ([luohy15/y-router](https://github.com/luohy15/y-router)) | MIT | TS (Worker) | archived | tiny | AM | A→C only | no | Archived. Useful only as reading material. |
| claude-code-proxy ([fuergaosi233](https://github.com/fuergaosi233/claude-code-proxy)) | MIT | Python | ~2.8k★, last push 2026-03 | small | AM | A→C | yes | A single-purpose reference. [1rgs/claude-code-proxy](https://github.com/1rgs/claude-code-proxy) has **no licence** and is not reusable. |
| Codex R→C shims ([MetaFARS/codex-relay](https://github.com/MetaFARS/codex-relay) MIT Rust; others unlicensed) | mixed | | small projects | | OR | R→C | — | Immature. The mature R→C bridges are LiteLLM, CLIProxyAPI and new-api. |

Takeaways:
- There is **no mature MIT/Apache Node library** that does AM-in and OR-in translation for embedding.
- The mature translators are Go (CLIProxyAPI) or Python (LiteLLM) servers.
- The in-hub parts (auth, per-agent tokens, routing to the hub's stored providers, Hermes sign-ins, the usage ledger, the per-agent catalogue) exist in no off-the-shelf product anyway. Whatever does the translation, the **front door must be ours**.

---

## 6. Recommendation for Core Hub (proposed — owner to confirm)

### 6.1 Shape: our own front door in Node; passthrough first; our own translator second

```
agent process ──(hub token, hub alias model)──▶ hub gateway (in the hub's Node process, loopback only)
                                                 ├─ auth: per-agent-session token → {workspace, agent, session, run}
                                                 ├─ resolve alias → turn's provider row + model id
                                                 ├─ same format as provider accepts?  → passthrough (rewrite auth/model/headers)
                                                 ├─ else → translate (inbound parser → IR → outbound driver)
                                                 ├─ signed-in provider? → borrow credential via signed-in-chat.ts
                                                 └─ meter usage from the response → audit.recordUsage()
                                               ──(real key, never leaves hub)──▶ provider
```

1. **In-process Node gateway, not a sidecar, as the default.**
   - The hub already holds the keys, the provider rows, the Hermes sign-in borrowing, the model rows (capabilities, context window, pricing) and the ledger. A sidecar would need all of that exported to it: keys on disk in its config, and a second copy of routing rules.
   - In-process adds **0 MB** to the image and works identically in the Electron desktop local mode (ADR 0021), where a Go or Python sidecar would add a per-platform binary.
2. **Phase 1 is passthrough-only.** No translation.
   - The provider catalogue gains one fact per type: which formats it accepts natively, and at which base path (§3).
   - Custom and OpenAI-compatible rows get a cheap **format probe**: an unauthenticated or empty-body `POST` to `/v1/messages` and `/v1/responses`, where 404 means "not served". Any other 4xx means "served", and the person can override the result.
   - That alone makes Claude Code and Codex run on the owner's CLIProxyAPI, LiteLLM, OpenRouter, DeepSeek, Ollama, LM Studio, Moonshot/Z.ai, and ChatGPT/xAI/MiniMax sign-ins.
   - The picker offers an agent only the models whose provider accepts its format.
3. **Phase 2 adds our own translator** with a tool-aware internal representation, starting with A→C and R→C.
   - Use the Vercel AI SDK (Apache-2.0) *or* our existing `models/adapters/` as the outbound half. Recommendation: extend our adapters, which already know the hub's provider quirks and have tests with an injected `fetch`. Either way we write the inbound parsers and SSE encoders.
   - CLIProxyAPI's MIT translators are the best reference to read. Describe in our own words; if any code is ported, record it in THIRD-PARTY-NOTICES.
   - **Fallback option if phase 2 slips:** ship CLIProxyAPI as an optional managed sidecar (+~40–77 MB, server image only) configured by the hub with API-key upstreams only. The front door stays ours either way, so this choice does not leak into the agents' wiring.
4. **Do not bundle LiteLLM** (size, Python deps, supply-chain history) or new-api (AGPL). Both remain usable as *provider rows* the person runs themselves.

### 6.2 Routes

Mounted on the hub's HTTP server but **accepted only from loopback** (or the container's own interface), and never through the public reverse proxy. Consider a separate loopback-only listener so a misconfigured Caddy route cannot expose it.

- `POST /gateway/anthropic/v1/messages`, `POST /gateway/anthropic/v1/messages/count_tokens` (phase 1: 404 or passthrough), `HEAD /gateway/anthropic/api/hello` → 200, `GET /gateway/anthropic/v1/models`
- `POST /gateway/openai/v1/responses`, `POST /gateway/openai/v1/chat/completions`, `GET /gateway/openai/v1/models`
- phase 3: `POST /gateway/google/v1beta/models/{model}:generateContent|:streamGenerateContent|:countTokens`

Contract-first applies: these are internal, agent-facing routes. They are not part of the public client API, but they should still be specified in `packages/contracts` (as an internal surface) with the same additive-only rule.

### 6.3 Model selection: aliases resolved per turn

- Agents are started with **fixed alias names**, e.g. `corehub-main` and `corehub-small`. `corehub-small` feeds Claude Code's `ANTHROPIC_DEFAULT_HAIKU_MODEL` and OpenCode's `small_model`.
- The gateway resolves an alias to **the model the current turn chose** (`selectionFor()` already computes it). The hub records "current selection" on the session's token before each `prompt`.
- This makes the model picker work **per turn for every ACP agent**, with no dependency on each agent's ACP model-switching support. That fixes finding 2 generically.
- A non-alias id that names a hub model key (`<provider-slug>/<model>`) is also accepted.
- `corehub-small` resolves to the profile's "small/fast" choice if one exists, else to the main model.

### 6.4 Tokens and security

- **Per agent session token.** Mint a random 256-bit token when the hub spawns an ACP process, bound to {workspace, agent id, session id}, held in memory only. It is revoked when the process exits, and has a hard TTL (e.g. 24 h) after which the session must be restarted or the token rotated.
  - Rotation: Claude Code `apiKeyHelper` and Codex `auth.command` can fetch a fresh token. Not needed in phase 1: the token is loopback-only and dies with the process.
- **No real key ever enters an agent's environment in gateway mode.** The agent sees only `…_BASE_URL=http://127.0.0.1:<port>/gateway/…` and the hub token in its key variable.
- **Fix finding 3 first:** replace the whole-`process.env` inheritance with an allow-list. Otherwise the "agents never see secrets" promise is false regardless of the gateway.
- **Rate limits per token:** concurrent streams (e.g. 4) and requests per minute. Optional per-profile spend caps later, using the ledger.
- **Audit:** log provider, model, token counts and status per request, never bodies or keys. Log names of dropped fields (translation) for drift detection.
- **Redirect safety:** the gateway follows no redirects from providers. It never returns upstream URLs or keys in errors (reuse the redaction in `signed-in-chat.ts`).
- **Repository-level override resistance:**
  - Codex ignores `model_providers` in project-local config (good).
  - Claude Code *does* read project `.claude/settings*.json` `env`, so a repository could set its own `ANTHROPIC_BASE_URL`. That is the person's own repository and today's behaviour too, so it is acceptable, but it is worth a line in the docs.
  - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` exists for exactly this embedding case and should be evaluated in phase 1.

### 6.5 Wiring per agent (env injection at spawn, plus one hub-owned config block where unavoidable)

| Agent | Phase | Wiring |
|---|---|---|
| Claude Code | 1 | Move the pin to `@agentclientprotocol/claude-agent-acp`. Env: `ANTHROPIC_BASE_URL=<gw>/gateway/anthropic`, `ANTHROPIC_AUTH_TOKEN=<token>`, **unset** `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL=corehub-main`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=corehub-small`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; for non-Anthropic upstreams also `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<model row context>`. Alternative: advertise `auth._meta.gateway` and call `authenticate(gateway, {baseUrl, headers})`, the bridge's first-class path. |
| Codex | 1 | Move the pin to `@agentclientprotocol/codex-acp`. `CODEX_CONFIG` (or `-c`): `model_provider="corehub"`, `model_providers.corehub={name="Core Hub", base_url="<gw>/gateway/openai/v1", env_key="COREHUB_GATEWAY_TOKEN", wire_api="responses"}`, `model="corehub-main"`, `model_context_window=<row>`; env `COREHUB_GATEWAY_TOKEN=<token>`. Alternative: the ACP `gateway` auth method with `protocol:"openai"`. |
| Qwen Code | 2 | `OPENAI_BASE_URL=<gw>/gateway/openai/v1`, `OPENAI_API_KEY=<token>`, `OPENAI_MODEL=corehub-main` |
| Kimi Code | 2 | `KIMI_MODEL_PROVIDER_TYPE=openai`, `KIMI_MODEL_BASE_URL=<gw>/gateway/openai/v1`, `KIMI_MODEL_API_KEY=<token>`, `KIMI_MODEL_NAME=corehub-main`, `KIMI_MODEL_MAX_CONTEXT_SIZE=<row>`, `KIMI_MODEL_CAPABILITIES=…` |
| Goose | 2 | `GOOSE_PROVIDER=openai`, `OPENAI_HOST=<gw origin>`, `OPENAI_BASE_PATH=gateway/openai/v1/chat/completions`, `OPENAI_API_KEY=<token>`, `GOOSE_MODEL=corehub-main` |
| OpenCode | 2 | `OPENCODE_CONFIG_CONTENT={"provider":{"corehub":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"<gw>/gateway/openai/v1","apiKey":"{env:COREHUB_GATEWAY_TOKEN}"},"models":{…from hub catalogue…}}},"model":"corehub/corehub-main","small_model":"corehub/corehub-small"}`, `OPENCODE_DISABLE_MODELS_FETCH=1` |
| Grok Build | 2 | Hub-owned `[model.corehub]` block (`api_backend="chat_completions"`, `base_url`, `env_key="COREHUB_GATEWAY_TOKEN"`, `context_window`) + `GROK_DEFAULT_MODEL=corehub`. Env-only is unverified. |
| Pi | 2 | Hub-owned `providers.corehub` in `models.json` (`api:"openai-completions"`, `apiKey:"$COREHUB_GATEWAY_TOKEN"`) |
| Gemini CLI | 3 | `GOOGLE_GEMINI_BASE_URL=<gw>/gateway/google`, `GEMINI_API_KEY=<token>`, `GEMINI_MODEL=corehub-main`; needs GG inbound. Update `--experimental-acp` → `--acp`. |
| Direct | 2 | No gateway. Share the phase-2 router/translator code when Direct gains tools. |
| Hermes | — | Unchanged (already any-model). |

Hub-owned config blocks follow the pattern `propagation.ts` already uses for Hermes: a marker, one owned key or block, every other line preserved.

### 6.6 Compatibility (no breaking changes, ADR 0027)

- **Gateway mode is chosen per agent and is additive.** New per-agent setting `model_source: "hub" | "agent"`, plus contract fields added, never renamed.
- **Default for existing installs:**
  - An agent that today has a matching vendor key keeps working, because the gateway passes through to the same provider with the same key.
  - An agent **signed in to its own vendor account** (Claude subscription via `claude login`, `codex login`, `grok login`, `kimi login`) must *not* be silently switched: injecting `ANTHROPIC_AUTH_TOKEN` replaces a Claude subscription login.
  - So the default is `agent` when the agent reports its own sign-in (claude-agent-acp exposes auth status), and `hub` otherwise.
  - The person can switch either way; vendor sign-ins stay fully supported.
- The ACP bridge renames (claude-code-acp → claude-agent-acp, codex-acp → agentclientprotocol/codex-acp) are catalog pin moves. Keep discovering the old binary names for installs that have them, and move the pin through the normal update path.
- Old env names keep working. Per-agent `secret_refs` and `env` overrides still win (ADR 0010 §Overrides), so a person who pinned a real key to one agent keeps that behaviour.

### 6.7 Catalogue per agent

- Each agent's picker lists only models that are *usable by that agent*. A model is usable when:
  - its provider accepts the agent's format natively, or (from phase 2) a translator exists for the pair; and
  - its model row has the `tools` capability (coding agents are useless without tool calls); and
  - its context window is ≥ a per-agent floor (e.g. 64K for Claude Code, whose system prompt plus tools is large; smaller floors for Pi and Goose).
- Models failing only the floor or tools checks are shown disabled with the reason, not hidden, so the person understands why.
- Claude Code with a non-Claude model shows a one-line "not supported by Anthropic" note.

### 6.8 Usage and cost

- The gateway sees every request's usage:
  - AM `message_start`/`message_delta.usage`;
  - OC final chunk (set `stream_options.include_usage` on outbound OC requests);
  - OR `response.completed.usage`;
  - GG `usageMetadata`.
- It adds these per {run, model} and writes through `audit.recordUsage()` with `costOf()` from the model row's pricing. This gives ACP agents cost figures they have never had.
- The run id comes from the session token's current-run pointer, which the hub sets on `prompt`.
- The ledger's unique (run, model label) means the write is an **upsert-add**, not an insert. That needs a small audit-service change.
- Claude Code's `x-claude-code-agent-id` lets the ledger attribute subagent calls later.

### 6.9 Phased plan and effort (one experienced engineer; rough)

| Phase | Scope | Effort |
|---|---|---|
| 0 | Env allow-list for spawned agents (finding 3). Move the two ACP bridge pins. | 2–3 days |
| 1 | Gateway front door (loopback listener, tokens, alias resolution per turn, passthrough for AM/OR/OC, `/models`, pings, error passthrough); provider "accepted formats" + probe; Claude Code + Codex wiring; per-agent `model_source`; ledger upsert; picker filtering; contract additions; tests (§6.11) | 2–3 weeks |
| 2 | Tool-aware internal representation; A→C and R→C translators (+ C passthrough); signed-in providers through `signed-in-chat.ts`; wire Qwen, Kimi, Goose, OpenCode, Grok, Pi | 3–4 weeks |
| 3 | GG inbound for Gemini CLI; →G outbound with thought signatures; `count_tokens` estimates; optional CLIProxyAPI sidecar if translation quality lags | 2 weeks |

### 6.10 Risks

- **Model quality with tools.** Claude Code and Codex prompts are tuned for their vendors' models. Open or small models often loop, mis-format tool arguments or ignore permissions. The picker's tools and context floors help; the UI must still set expectations.
- **Format drift.** Claude Code adds betas and body fields every release; OpenAI evolves Responses; Codex dropped Chat with about two months' notice. Mitigations:
  - pinned agent versions (already policy);
  - forward unknown fields in passthrough;
  - log dropped fields in translation;
  - a real-agent test per pin bump (§6.11).
- **Anthropic's support policy.** Non-Claude models under Claude Code are explicitly unsupported by Anthropic. Features can break, e.g. WebSearch (a server tool), fast mode, and Remote Control.
- **Thinking fidelity** across providers is lossy by nature (signatures). Expect occasional first-turn retries, which Claude Code handles by dropping thinking.
- **Responses statefulness.** `previous_response_id` cannot be honoured by Chat upstreams. Phase 1 only passes through to stateful upstreams; the translator must be stateless or reject that field clearly.
- **Loopback exposure.** In Docker the gateway must not be reachable from other containers on the network unless intended. Bind to 127.0.0.1 inside the hub container; ACP agents run in the same container.
- **Subscription terms.** Routing a ChatGPT/Codex subscription to *other* agents via Hermes's sign-in may conflict with provider terms. The owner should decide whether signed-in providers are offered to non-vendor agents.

### 6.11 Test strategy

1. **Fake provider (unit and integration).** A scripted in-process HTTP server speaking AM, OR, OC and GG. It covers:
   - text streams, parallel tool calls with chunked arguments, thinking with signatures, and usage chunks;
   - mid-stream errors, 429 with `retry-after`, and silence (to test pings).
   Adapters and the gateway already take an injected `fetch`, the existing pattern.
2. **Golden translation fixtures.** Recorded request and response pairs per direction (A→C, R→C, …), asserting exact SSE output. This includes the orphan and duplicate block rules Claude Code enforces.
3. **Real agents against the fake provider.** Extend the existing `*.real.test.ts` pattern: start the **pinned** Claude Code (via the bridge) and Codex (via codex-acp) with gateway env, point the gateway at the fake provider, and script a conversation:
   - The fake provider asks for a tool call (write a file); the agent executes it.
   - The next request must carry the tool result. The fake provider ends the turn.
   - Assert the file exists, the ACP stream shows the tool call, and the ledger row has the scripted token counts.
   This runs in CI with no network and no keys, and catches format drift on every pin bump.
4. **Security tests.**
   - A spawned agent's env contains no provider key and no non-allow-listed host variable.
   - An expired, revoked or foreign token gets 401.
   - Non-loopback requests are refused.
   - Errors never contain keys.
5. **Opt-in live smoke** (not CI). Owner-run, against real CLIProxyAPI, OpenRouter, DeepSeek and Groq keys, one scripted tool task per agent/provider pair, results recorded in the change record.

### 6.12 What the owner is asked to decide

1. In-process Node gateway (recommended), versus bundling CLIProxyAPI as a sidecar from the start.
2. Default `model_source` for agents signed in to their own vendor account (recommended: keep `agent`).
3. Whether Hermes-held subscription sign-ins (ChatGPT/Codex, xAI, MiniMax) may serve other vendors' agents.
4. Ship phase 0 (env allow-list) now as its own PR. Recommended regardless of the gateway decision.

