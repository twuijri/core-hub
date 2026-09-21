# models

Owns: `secret`, `provider`, `model`, `model_default`, `ensemble`,
`speech_settings`. Schema: `packages/server/src/modules/models/schema.ts`. All
scoped (ADR 0005: each workspace has its own models). Base columns omitted.

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

## provider (scoped)

| column | type | meaning |
|---|---|---|
| slug | text(64) | stable id inside the workspace: `anthropic`, `openai-tts`, `custom-ollama` |
| label | text(80) | display |
| kind | enum(llm, stt, tts) | the contract's `ProviderKind` |
| builtin | bool | seeded from the bundled catalogue; can be disabled, never deleted |
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

**Seeding.** A workspace's provider rows are created lazily from the bundled
catalogue on its first request, disabled ones included: a provider the hub
supports is visible and unconfigured, never hidden (ADR 0006's rule for agents,
applied to providers).

## model (scoped)

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
- Providers screen: providers with `configured = a key is stored for the
  family`, `status`, model count.
- Defaults screen: the chat default with its fallbacks, plus one row per
  auxiliary task.
- Resolve for a run: session.model → agent_settings.default_model_id →
  model_default(role for the agent's kind) → its fallbacks; each step checks
  `enabled` and `archived_at`.
- Usage roll-up by provider: audit `usage_records` grouped by `provider_id`.

## Propagation (ADR 0010)

- **Hermes**: the hub writes the provider keys into `${HERMES_HOME}/.env` (a
  merge that touches only the variables it owns) and the chat default into
  `${HERMES_HOME}/config.yaml` as `model.default` + `model.provider` (a YAML
  round-trip, one key at a time), then recycles the gateway it supervises. A
  provider Hermes has no slug for leaves its selection untouched.
- **ACP / harness agents**: the environment is built at process start from the
  same providers, under the variable names each agent's catalog entry declares.
- **Overrides**: `agent_settings.default_model_id` and
  `agent_settings.secret_refs` win over the shared store; absent both, the
  agent inherits.

## Not stored

- Plain API keys; the data key itself (a file under the data directory, never
  a row).
- Provider responses, rate-limit state (in memory).
- The full public catalogue: only rows the workspace discovered or typed.
