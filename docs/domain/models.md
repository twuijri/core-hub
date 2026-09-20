# models

Owns: `provider`, `model`, `model_default`, `secret`. Schema:
`packages/server/src/modules/models/schema.ts`. All scoped (ADR 0005: each
workspace has its own models). Base columns omitted.

`secrets` is the only table other modules store ciphertext references into
(`agents.agent_settings.secret_refs`, `notify.webhooks.signing_secret_id`,
`plugins.plugin_bindings.secret_refs`). Every ENCRYPTED column: AES-256-GCM
under the server data key (`<data>/keys/`), rotated by `key_id`, masked as
`[stored]` on read, never logged, never returned.

## secret (scoped)

| column | type | meaning |
|---|---|---|
| name | text(120) | unique per workspace ("OpenAI key") |
| kind | enum(api_key, token, password, generic) | |
| ciphertext | text? | **ENCRYPTED**. Base64 GCM ciphertext; null once wiped |
| nonce | text(32)? | **ENCRYPTED (metadata)**. Base64 GCM nonce |
| key_id | text(32) | data-key version that encrypted the row |
| hint | text(4)? | last 4 chars for "sk-…ab12" |
| rotated_at | ms? | |
| wiped_at | ms? | ciphertext and nonce nulled; row kept (README §Archive rule 3) |
| archived_at | ms? | |

Indexes: unique (workspace, name).

## provider (scoped)

| column | type | meaning |
|---|---|---|
| kind | enum(anthropic, openai, openrouter, google, mistral, groq, ollama, openai_compatible, custom) | drives the adapter and the catalogue |
| name | text(120) | unique per workspace |
| base_url | text? | |
| api_key_secret_id | ulid? → secret (FK, set null) | |
| headers | json<Record<string,string>> | non-secret extra headers |
| capabilities | json<ProviderCapabilities> | chat, stt, tts, embeddings, images, listModels |
| enabled | bool | |
| status | enum(unconfigured, ok, error) | last connectivity check |
| last_checked_at, last_error | | |
| archived_at | ms? | |

Indexes: unique (workspace, name); (workspace, kind).

## model (scoped)

| column | type | meaning |
|---|---|---|
| provider_id | ulid → provider (FK, cascade) | |
| model_key | text(200) | the provider's id ("claude-sonnet-4-5"); unique per provider |
| label | text(200) | display |
| kind | enum(chat, stt, tts, embedding, image) | |
| context_window, max_output_tokens | int? | |
| pricing | json<ModelPricing> | micro-USD per million: input, output, cacheRead, cacheWrite — used when the provider does not report cost |
| capabilities | json<ModelCapabilities> | tools, vision, reasoning, json |
| enabled | bool | |
| source | enum(catalogue, discovered, manual) | seeded from the bundled catalogue, listed by the provider, or typed by the user |
| archived_at | ms? | |

Indexes: unique (provider_id, model_key); (workspace, kind, enabled).

## model_default (scoped)

| column | type | meaning |
|---|---|---|
| role | enum(chat, coding, titles, summaries, stt, tts, embedding) | unique per workspace |
| model_id | ulid → model (FK, cascade) | |
| fallback_model_ids | json<string[]> | ordered chain tried when the primary fails |

## Queries the clients need

- Model picker: enabled chat models of enabled providers in the workspace,
  grouped by provider (the phone client's `ModelOption(id, provider)`).
- Providers screen: providers with `configured = api_key_secret_id is not
  null`, `status`, model count.
- Defaults screen: one row per role with its fallbacks.
- Resolve for a run: session.model_id → agent_settings.default_model_id →
  model_default(role) → its fallbacks; each step checks `enabled` and
  `archived_at`.
- Usage roll-up by provider: audit `usage_records` grouped by `provider_id`.

## Not stored

- Plain API keys; the data key itself (file under the data directory, never
  a row).
- Provider responses, rate-limit state (in memory).
- The full public catalogue: only rows the workspace enabled or discovered;
  the catalogue file ships with the server.
