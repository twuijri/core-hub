# models

Owns: `secret`, `provider`, `model`, `model_default`, `ensemble`,
`speech_settings`. Schema: `packages/server/src/modules/models/schema.ts`. Base
columns omitted.

**Two provider scopes, per-profile choices** (contract decision §37, owner 2026-09-24). A
`provider` row is **shared** (`shared = true`: every profile's; stored, with its models and
its key `shared-provider:<family>`, under the default profile — which always exists and can
be neither renamed nor archived) or a profile's **own** (`shared = false`: that profile's
alone, its key `provider:<family>` in that profile). A profile sees both; where both have a
slug, its own is the one it uses. A new profile has every shared provider at once; a copy of
a profile gets its source's own providers with their keys. `model_default`, `ensemble` and
`speech_settings` stay per profile: they are choices, and a profile that made none uses the
default profile's (mapped onto the provider of the same slug it uses). Migration `0012`
(`provider_scope`) added the column: every row older than it is its profile's own.

This module is **the hub's one credential store** (ADR 0010): a person adds a
provider key once, here, and the hub propagates it to Hermes and to every
coding agent. Nothing else in the product asks for a key.

`secrets` is the only table other modules store ciphertext references into
(`agents.agent_settings.secret_refs`, `notify.webhooks.signing_secret_id`,
`plugins.plugin_bindings.secret_refs`). Every ENCRYPTED column: AES-256-GCM
under the server data key (`<data>/keys/data.key`), rotated by `key_id`, masked
as `[stored]` on read, never logged, never returned.

The vocabulary is the contract's: `providers.kind`, `providers.api_mode`,
`providers.visibility_mode`, `models.kind` and `models.capabilities` hold
exactly the values of `ProviderKind`, `Provider.api_mode`, `Visibility.mode`,
`ModelKind` and `ModelCapability` in `packages/contracts/openapi.yaml`.

## secret (scoped)

| column | type | meaning |
|---|---|---|
| name | text(120) | unique per workspace; a provider key is `provider:<family>` |
| kind | enum(api_key, token, password, generic) | |
| ciphertext | text? | **ENCRYPTED**. Base64 GCM ciphertext ‖ tag; null once wiped |
| nonce | text(32)? | **ENCRYPTED (metadata)**. Base64 GCM nonce |
| key_id | text(32) | data-key version that encrypted the row |
| hint | text(4)? | last 4 chars for "sk-…ab12" |
| rotated_at | ms? | |
| wiped_at | ms? | ciphertext and nonce nulled; row kept (README §Archive rule 3) |
| archived_at | ms? | |

Indexes: unique (workspace, name).

**The key ring.** `${DATA_DIR}/keys/data.key` (mode 0600) holds every data-key
version: `{ "active": "k1", "keys": { "k1": "<base64 32 bytes>" } }`. Rotation
is additive — mint a version, make it active, re-seal the rows that are not on
it yet, then drop the old version. A row sealed under a version the ring no
longer holds is *reported*, never silently skipped: that is data loss.

## provider (scoped; `shared` rows are every profile's)

| column | type | meaning |
|---|---|---|
| slug | text(64) | stable id inside the workspace: `anthropic`, `openai-tts`, `custom-ollama` |
| label | text(80) | display |
| kind | enum(llm, stt, tts) | the contract's `ProviderKind` |
| builtin | bool | came from a catalogue preset (vs. somebody's own endpoint); removable either way |
| enabled | bool | |
| base_url | text? | |
| api_mode | enum(native, chat_completions, responses) | |
| auth_kind | enum(api_key, oauth, none) | |
| api_key_secret_id | ulid? → secret (FK, set null) | |
| family | text(64) | **credential family**: rows that share it share the key |
| headers | json<Record<string,string>> | non-secret extra headers |
| capabilities | json<ProviderCapabilities> | chat, stt, tts, embeddings, listModels, listVoices |
| settings | json<SpeechProviderSettings> | STT/TTS: model, language, voice |
| visibility_mode | enum(all, include) | |
| visible_models | json<string[]> | the models shown when `include` |
| catalogue_status | enum(ready, loading, error, unsupported) | last refresh |
| catalogue_refreshed_at, catalogue_error | | |
| status | enum(unconfigured, ok, error) | last connectivity check |
| last_checked_at, last_error | | |
| archived_at | ms? | |

Indexes: unique (workspace, slug); (workspace, kind); (workspace, family).

**Credential family.** The contract gives a provider one `kind`, so OpenAI
chat, OpenAI dictation and OpenAI speech are three rows — and one key. All rows
of a family point at the same `secrets` row, so pasting the key on one tab
configures the others (ADR 0010 §2). The bundled catalogue
(`modules/models/catalogue.ts`) is where a family, its environment-variable
name, and Hermes's own slug for it are declared.

**No seeding: a row exists because somebody added it.** A fresh workspace has
no providers, and `models.listProviders` answers `{ items: [] }`. What the hub
*can* talk to is the preset list (`models.listProviderPresets`), which is where
"visible and unconfigured, never hidden" now lives (ADR 0006's rule; contract
decision §26). Adding a preset creates the whole credential family in one call,
so adding OpenAI on the chat tab puts its dictation and speech rows on theirs.
Migration `0002_unseeded_providers.sql` removed the untouched rows the old
lazy seeding had created — built-in, no key, no model — and left every row that
had either.

**`auth_kind` is a requirement, not a state.** `none` means *no key is
required*; it never means a key is refused, and storing one does not change it.
Every provider accepts a key — a local proxy behind a master key is ordinary —
and the only thing allowed to report a key as missing is the endpoint's own
answer. A preset declares `keyRequirement: required | optional`, and that is the
only vocabulary there is (contract decision §26; the defect of 2026-09-22).

## model (scoped, with its provider)

| column | type | meaning |
|---|---|---|
| provider_id | ulid → provider (FK, cascade) | |
| model_key | text(200) | the provider's id ("claude-sonnet-4-5"); unique per provider |
| label | text(200) | display, as the provider named it |
| alias | text(200)? | a name the person gave it |
| kind | enum(chat, embedding, stt, tts) | |
| context_window, max_output_tokens | int? | |
| pricing | json<ModelPricing> | micro-USD per million: input, output, cacheRead, cacheWrite |
| capabilities | json<ModelCapability[]> | vision, tools, reasoning, audio, streaming |
| enabled | bool | the contract's `Model.disabled` is `!enabled` |
| visible | bool | hidden from pickers without being disabled |
| preview | bool | |
| source | enum(catalogue, discovered, manual) | `manual` is the contract's `custom` |
| archived_at | ms? | |

Indexes: unique (provider_id, model_key); (workspace, kind, enabled).

**No model ids ship with the hub.** A row exists because a provider answered
`models.refreshProvider` with it, or because a person typed it
(`source: manual`). A refresh archives what the provider no longer lists and
never touches a manual row, an alias or a visibility choice.

## model_default (scoped)

| column | type | meaning |
|---|---|---|
| role | enum(chat, coding, title, summary, embedding) | unique per workspace |
| model_id | ulid → model (FK, cascade) | |
| fallback_model_ids | json<string[]> | ordered chain tried when the primary fails |

`chat` is the contract's `ModelDefaults.default`; the rest are its
`auxiliary.assignments` keys, declared with Arabic and English labels in
`modules/models/defaults.ts`. `coding` is an auxiliary role on purpose: the
owner picks one chat model and one coding model, and every coding agent
inherits the coding one without anybody opening that agent's settings
(ADR 0010 §4).

## ensemble (scoped)

| column | type | meaning |
|---|---|---|
| name | text(80) | unique per workspace |
| enabled, active | bool | at most one active per workspace |
| members | json<EnsembleMember[]> | provider_id + model + reasoning_effort |
| aggregator | json<EnsembleMember> | **required**: the contract's field is not nullable |
| max_tokens | int? | |
| archived_at | ms? | |

## speech_settings (scoped)

One row per workspace: `stt_provider_id`, `tts_provider_id` (both → provider,
set null). The contract's `SpeechSide.ready` is "an active provider, enabled,
with a key"; `reason` is an i18n key, never a sentence in one language.

## Queries the clients need

- Model picker: enabled, visible chat models of enabled providers in the
  workspace, grouped by provider.
- Providers screen: the providers the workspace added, each with `status`, its
  address, its model count and whether a key is stored; plus the preset list
  behind "Add provider", and `host.containerized` so a loopback address can be
  called out before it fails.
- Defaults screen: the chat default with its fallbacks, plus one row per
  auxiliary task.
- Resolve for a run: session.model → agent_settings.default_model_id →
  model_default(role for the agent's kind) → its fallbacks; each step checks
  `enabled` and `archived_at`.
- Usage roll-up by provider: audit `usage_records` grouped by `provider_id`.

## Propagation (ADR 0010)

- **Every profile** (decision §37): Hermes's root home is its `default` profile: the keys and
  endpoints the default profile uses (its own over the shared ones) and its chat model,
  whichever profile saved; the gateway's process environment gets the same keys. A named
  profile gets the endpoints **it** uses in its own `config.yaml`, and in its own `.env` every
  hub-owned variable whose value differs from the root's: its own key (Hermes reads a
  profile's `.env` before the environment, so it wins), the shared key where the default
  profile has its own instead, or an empty value where the root has a key that profile must
  not use (Hermes loads the root `.env` into its environment at start). A variable whose value
  is the root's is left out. This is done on every save, right after the hub makes a profile
  (and after a copy or an import took its providers), and before each turn in a named profile
  (`ModelsService.prepareProfile`).
- **Export and import** (decision §37): an export "with providers" adds
  `<profile>/majlis-providers.json` — the providers the profile uses, keys in the clear; an
  import reads it before Hermes sees the archive and makes each one the imported profile's own.
- **Hermes**: the hub writes the provider keys into `${HERMES_HOME}/.env` (a
  merge that touches only the variables it owns), **puts the same variables into
  the gateway's own process environment at spawn** (the file is what `hermes
  model` and a shell in the container read; the environment is what the running
  process cannot start without), and writes `${HERMES_HOME}/config.yaml` in one
  YAML round-trip: a `providers:` block per OpenAI-compatible endpoint, plus
  `model.default` + `model.provider`. Then it recycles the gateway it supervises
  — once per save, and never while a turn is in flight.
- **Which providers reach it.** A provider Hermes ships itself is named by its
  own slug (`hermesProvider`). Every other chat provider — LM Studio, LiteLLM,
  Groq, Mistral, Ollama, somebody's own endpoint — is written as a block under
  `providers:` keyed `majlis-<slug>`, carrying `base_url`, `api_mode` and
  `key_env`. The prefix is load-bearing: Hermes ignores a `providers:` entry
  named after one of its own canonical providers, and `lmstudio` is one.
  `hermesKeyEnvOf` mints `MAJLIS_PROVIDER_<SLUG>_API_KEY` for a provider with no
  world-wide variable name. A provider that still cannot be expressed cannot be
  the chat default: `models.setDefaults` refuses it by name.
- **Model ids are opaque.** Whatever the provider answered is what is stored and
  what is written — `openrouter/free`, `z-ai/glm-5.2:free`, suffixes and all.
  The catalogue's `Model.key` (`<provider slug>/<id>`) is a client-side handle,
  split back on the **first** slash and only when the left side is a provider
  this workspace has.
- **The first default.** A workspace with providers but no chat default is given
  one — the first model of the provider just configured, once. A provider added
  later never steals it, and the owner's own choice is never overwritten.
- **A key is checked before it is stored.** The provider is asked once on save;
  an outright refusal (401/403) blocks the save and carries the provider's own
  words. Anything else — unreachable, slow, 5xx — stores the key and reports
  what happened, because it says nothing about the key.
- **Nothing is silent.** `models.getRuntime` answers, from the files and the
  process as they are now: runtime writable, provider keys present, providers
  verified, model selected, gateway reloaded. A run that fails for want of a
  credential carries `provider_not_configured`; one the provider refused carries
  `provider_unauthorized`.
- **ACP / harness agents**: the environment is built at process start from the
  same providers, under the variable names each agent's catalog entry declares.
- **Overrides**: `agent_settings.default_model_id` and
  `agent_settings.secret_refs` win over the shared store; absent both, the
  agent inherits.

## الاتصال المباشر — streaming a turn from the hub (ADOPTION-BACKLOG §2.15)

The `direct` agent (`docs/domain/agents.md` §The direct agent) has no runtime of its
own, so this module streams its turns. `ProviderAdapter` gained a fifth verb beside
`test`, `listModels`, `listVoices` and `synthesize`:

    adapter.chat(ctx, request) -> AsyncIterable<ChatEvent>

- **Which protocols answer.** `openai` (and therefore every OpenAI-compatible
  endpoint — OpenRouter, Groq, Mistral, DeepSeek, xAI, LM Studio, LiteLLM,
  cli-proxy-api, a typed-in URL), `anthropic`, `google`, and `ollama` through its own
  `/v1` surface (ADR 0012's reasoning, applied to us). `elevenlabs` refuses: a speech
  provider has no chat surface, and saying so is better than posting to one.
- **Nothing throws.** Every refusal is a final `failed` event carrying the provider's
  own sentence and one of the contract's error codes: `provider_not_configured` (no key
  stored for a provider that requires one, or no model chosen), `provider_unauthorized`
  (401/403), `rate_limited` (429), `not_found` (a model the provider does not know —
  its 404, or its 400 saying so), `agent_unavailable` (nothing listening),
  `agent_error` (anything else). The text is never rewritten; the code is a label over
  it.
- **Cancel.** The caller's `AbortSignal` closes the socket mid-stream and the turn ends
  as `cancelled`, which the run state machine reports as an interrupted run, not a
  failure.
- **Cost.** `costMicroUsd` is the provider's own token counts against the model row's
  published prices, reported as `cost_source: estimated`. A model row with no prices
  reports no number rather than zero.

### Attachment limits on the direct path

There is no file tool on this path, so a file either goes into the request or the turn
is refused **by name**. Nothing is silently dropped and nothing is silently truncated.

| what | behaviour | limit |
|---|---|---|
| text-like (`text/*`, `application/json`, `*+json`, `*+xml`, `*+yaml`, or a known code/text extension) | inlined into the prompt inside a fence naming the file | 64 KB per file, 256 KB per turn |
| image (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) | sent inline, base64, to a model whose row declares `vision` | 5 MB per image, 20 MB per turn |
| image, but the chosen model has no `vision` | run fails `unsupported_media_type`, naming the file and the model | — |
| anything else (PDF, audio, binary) | run fails `unsupported_media_type`, naming the file and its type | — |
| over a limit | run fails `payload_too_large`, naming the size and the limit | — |

## Not stored

- Plain API keys; the data key itself (a file under the data directory, never
  a row).
- The direct agent's conversation: it lives in the server process for the life of the
  session's adapter object (`docs/domain/agents.md` §The direct agent).
- Provider responses, rate-limit state (in memory).
- The full public catalogue: only rows the workspace discovered or typed.
