# ADR 0010 — One credential store; the hub propagates, the person does not

Status: accepted (2026-09-21)
Supersedes: ADR 0008 §4 ("Secrets stay on Hermes's side of the line")

## Context

The owner's words, 2026-09-21: he adds a provider — an API key — **once, in one
place**, and every agent can use it: Hermes, and every coding agent he installs
later. He explicitly does not want to configure a provider per agent.

ADR 0008 decided the opposite, for a good reason at the time: Hermes reads its
provider keys from its own home, so the hub could stay out of the credential
business entirely and let `hermes config set` own them. That reason does not
survive contact with the rest of the product:

- A coding agent installed from the catalog (ADR 0006) is a process the hub
  spawns. It reads `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY`, or …) from its
  environment. Nothing in Hermes's home reaches it. With ADR 0008 as written,
  installing Claude Code would be followed by "now paste your Anthropic key
  again, somewhere else" — which is the thing the owner said no to.
- `docs/domain/models.md` already specifies a `secret` table with AES-256-GCM,
  `key_id` rotation and `[stored]` masking, and `agents.agent_settings` already
  carries `secret_refs` pointing into it. The schema was always designed around
  a hub-side store; ADR 0008 §4 was the outlier.
- The Models screen in the contract (`tag: models`, 23 operations) has
  `api_key`, `testProvider`, `refreshProvider` and a defaults screen. A contract
  that asks for a key the hub refuses to hold cannot be implemented honestly.

Everything below about Hermes was read from its public MIT source and
documentation, never from the owner's Studio fork (ADR 0004). The URLs and the
exact identifiers are in `docs/inspirations/hermes-agent.md`
§"Provider keys and model selection".

## Decision

### 1. The hub owns one credential store

`packages/server/src/modules/models` owns providers, secrets, the model
catalogue, defaults and ensembles, exactly as `docs/domain/models.md` describes.
A key is sealed with AES-256-GCM under the server data key
(`${DATA_DIR}/keys/data.key`, mode 0600, a ring of versions keyed by `key_id`),
masked as the contract's literal `[stored]` on every read, never logged, never
returned, and never placed in an audit row.

### 2. One key, many provider rows: the credential family

The contract gives a provider one `kind` (`llm | stt | tts`), so OpenAI chat,
OpenAI dictation and OpenAI speech are three rows. They are **one key**. Every
catalogue entry carries a `family`, and all rows of a family point at the same
`secrets` row. Pasting the OpenAI key on the chat tab configures the dictation
tab. This is the mechanical form of "add it once".

### 3. Propagation is the hub's job, per agent kind

**Hermes.** Its own home is the configuration surface, and it uses two files for
two jobs:

| what | file | how the hub writes it |
|---|---|---|
| provider keys | `${HERMES_HOME}/.env` | a merge: only the variables the hub owns are replaced in place; every other line, comment included, is copied through. Quoting follows Hermes's own writer (quote only when the value contains whitespace, `#` or a quote). Written temp-file + atomic rename, mode 0600. |
| the chat model | `${HERMES_HOME}/config.yaml` | a YAML round-trip that sets `model.default` and `model.provider` one key at a time and clears `model.base_url` / `model.api_mode` when the provider changed — the same rule Hermes's own `persist_model_selection()` states, because a block rewrite destroys sibling keys. |

Then the hub recycles the gateway it supervises (ADR 0008 §2), because the
running process holds its environment from spawn time and the API server on
8642 exposes no reload and no configuration write surface at all.

`hermes config` and `hermes model` keep working; the hub never asks anyone to
run them, and never touches a key it does not own.

Two honesty rules apply here:

- Hermes's provider slugs are **not** ours. Its `openai` id is an alias of
  **OpenRouter**; direct OpenAI is `openai-api`; Google is `gemini`; and Groq
  and Mistral are speech keys in Hermes, not chat providers. Each catalogue
  entry declares `hermesProvider`, or `null`. On `null` the hub writes **no**
  model selection and logs which provider it could not express, rather than
  writing a slug that would silently bill the wrong account.
- Only a runtime this hub supervises has a home the hub may write into. An
  `external` gateway (ADR 0008's first mode) is somebody else's process with
  somebody else's files: the hub writes nothing and cannot restart it.

**ACP and process agents.** They are processes the hub starts, so their
environment is built at `start()` from the same providers. Each catalog entry in
`modules/agents/catalog/` declares one line — credential family → the variable
that agent reads:

```ts
credentials: { anthropic: 'ANTHROPIC_API_KEY' },          // claude-code
credentials: { google: 'GEMINI_API_KEY' },                // gemini-cli (Hermes prefers GOOGLE_API_KEY)
```

That line is ours to maintain, not the user's. Installing a coding agent is an
install and nothing else. An entry that declares nothing inherits nothing: a CLI
is not handed every key in the workspace because it happens to be installed.

### 4. Overrides stay possible; inheriting is the default

- `agent_settings.default_model_id` pins one agent to one model.
- `agent_settings.secret_refs` (env name → `secrets.id`) pins one agent to one
  credential, and wins over the shared store.
- Absent both, an agent inherits the workspace assignment for its kind:
  Hermes takes `chat`, every coding agent takes `coding` (falling back to `chat`
  when the owner set only one). The resolved value is visible on every agent in
  the contract's `Agent.default_model`, so a client can show what each agent
  inherited without a second request.

### 5. Direction of dependency

`models` depends on `agents` (it needs the Hermes runtime's home). `agents` does
**not** depend on `models`: it declares an `AgentModelsPort` that `models`
registers at boot, the same shape `auth.registerWorkspaceStatsProvider` uses.
Until it is registered, agents start with their own settings only — never with a
wrong key.

## Alternatives rejected

- **Keep ADR 0008 §4 (keys only in Hermes's home).** Reaches Hermes and nothing
  else; coding agents would need their own key entry, which is the requirement
  inverted.
- **Shell out to `hermes config set` for every key.** The supported path, and it
  buys the managed-scope and denylist guards for free — but it costs a Python
  process per key on every save, it needs the `hermes` binary present even when
  the runtime is `absent`, and its output is a human sentence rather than a
  result. We replicate its file semantics instead, and say so here so the next
  contributor knows which behaviour to keep matching.
- **Hermes's dashboard HTTP API (`PUT /api/env`, `POST /api/model/set`).** The
  cleanest surface, but it requires running `hermes dashboard` — a second server
  on 9119 that ADR 0008 §3 deliberately does not ship — and its session token
  rotates on every restart.
- **A key per agent, with a "copy from" button.** Still asks the owner to think
  about credentials once per agent. He said no.

## Consequences

- One screen, `models`, is where a key is ever typed. Every other screen that
  needs one reads it from here.
- The hub restarts Hermes when a provider changes. That is visible (the agent
  card goes `starting`), it is recorded as `agent.reconfigured` in the audit
  trail, and it is the price of a key change taking effect.
- A provider Hermes has no slug for (Groq, Mistral, a custom endpoint) can still
  be the workspace's chat default for everything else; Hermes keeps its own
  selection and the log says why.
- The data key is the one thing a backup must include. Losing
  `${DATA_DIR}/keys/data.key` loses every stored key — the rows stay, and read
  back as "there was a secret here", which is what `wiped_at` already means.
- `docs/domain/models.md` and `docs/domain/agents.md` are updated to match. ADR
  0008 is left exactly as written (`docs/adr/README.md`: an accepted ADR is
  never edited); only its §4 is superseded, and only by the header of this file.
  Every other paragraph of ADR 0008 — the run surface, the supervised child, the
  image, `agents.restart` — still stands and this decision depends on it.
