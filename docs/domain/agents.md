# agents

Owns: `agent_adapter`, `agent`, `agent_settings`. Schema:
`packages/server/src/modules/agents/schema.ts`.

`agent_adapters` and `agents` are global (an installed CLI is a host fact);
`agent_settings` is scoped (ADR 0005). Base columns omitted.

The vocabulary is the contract's: `adapter_kind`, `capabilities`, `sections` and
`source` hold exactly the values of `AgentKind`, `AgentCapability`, `AgentSection` and
`AgentInstall.source` in `packages/contracts/openapi.yaml`, so no translation table sits
between the database and the API.

A fresh install shows **two** agents, not one (ADOPTION-BACKLOG §2.15, owner's decision
of 2026-09-22): Hermes, and `direct` — the hub talking to the model provider with no
runtime in between. See §The direct agent below.

Which agents exist is not open: the hub ships a **curated catalog**
(`packages/server/src/modules/agents/catalog/`, one reviewed file per agent with an id, an
install recipe, a pinned version, a health check and a licence). The registry is seeded
from it on boot and a person can install or remove a catalog entry and nothing else
(ADR 0006). Installs land in `${DATA_DIR}/agents/<id>` — the data volume, never the image
— and every boot reconciles the table against that directory, so an install survives a
restart and an image rebuild.

## agent_adapter (global)

One row per adapter implementation, seeded on boot from code so clients can
show what each connection kind supports (ADR 0002).

| column | type | meaning |
|---|---|---|
| kind | enum(hermes, acp, harness, builtin), unique | |
| name | text(120) | "Agent Client Protocol", "Hermes gateway", "Process harness" |
| version | text(32) | adapter code version |
| capabilities | json<AgentCapability[]> | the contract's `AgentCapability` values |
| status | enum(available, unavailable) | e.g. hermes gateway unreachable |
| last_probe_at, last_error | | |

## agent (global)

A registry entry: something the hub can start or talk to.

| column | type | meaning |
|---|---|---|
| slug | text(64), unique | the catalog entry's id: `hermes`, `claude-code`, `codex` |
| licence | text(64)? | SPDX id of the agent's own licence, copied from the catalog |
| name, description, icon | | |
| adapter_id | ulid → agent_adapter (FK, restrict) | |
| adapter_kind | enum(hermes, acp, harness, builtin) | denormalised for lists |
| source | enum(managed, user_cli, builtin, none) | installed by the hub, the person's own CLI, shipped in the image, or absent |
| command | json<string[]> | argv to start it; never a shell string |
| executable_path | text? | resolved binary |
| package_name | text(200)? | npm package the hub installs (from the catalog recipe) |
| latest_version | text(64)? | the newest stable version known: the registry's answer to the last check, never older than the catalog's pin (the tested baseline) |
| auto_update | bool | only for agents the hub installs; off by default; taken only while idle (§Updates) |
| checked_at | ms? | last version check |
| endpoint | text? | Hermes gateway URL |
| version | text(64)? | last probed version |
| install_state | enum(not_installed, installing, installed, updating, failed) | ADR 0006 |
| install_job_id | ulid? → audit.job | the running install/update job |
| detected_at | ms? | |
| capabilities | json<AgentCapability[]> | from the catalog entry |
| sections | json<AgentSection[]> | the rows a client draws under the agent's card |
| limited | bool | true for process-harness agents; UI marks them |
| selectable | bool | false while an adapter is declared but must not be chosen (ADR 0002) |
| last_error | text? | |
| archived_at | ms? | hidden from pickers; sessions keep working |

Install lifecycle: `not_installed → installing → installed | failed`;
`installed → updating → installed | failed`; `failed → installing` on retry.
`installed` and `not_installed` are the resting states; each move is a job. On boot the
hub reconciles: a row left `installing` by a killed container becomes `failed`, a row that
claims `installed` without a directory becomes `not_installed`.

Indexes: `slug` unique; `adapter_id`.

The agent's picture is not a column: an uploaded PNG or JPEG is the file
`<DATA_DIR>/avatars/agents/<id>` (`avatars.ts`, contract decision §76); its type is read from
its first bytes. No file, and the client draws the agent from its slug.

## agent_settings (scoped)

Created lazily with defaults the first time a workspace uses an agent.

| column | type | meaning |
|---|---|---|
| agent_id | ulid → agent (FK, cascade) | |
| enabled | bool | hidden from this workspace's pickers when false |
| default_model_id | ulid? → models.model | overrides the workspace `model_default(role=chat|coding)` |
| approval_mode | enum(ask, auto_safe, auto_all) | ask for every tool, auto-approve reads only, or everything |
| max_turns | int? | |
| working_dir | text? | default directory for new sessions |
| settings | json<AgentSettingsBody> | adapter-declared keys, validated by the adapter's `settings()` |
| env | json<Record<string,string>> | non-secret environment |
| secret_refs | json<Record<string,string>> | env name → models.secret id, resolved at process start |

**Credentials are not entered here** (ADR 0010). An agent's process environment
is built at start from the workspace's shared providers, under the variable
names its catalog entry declares (`catalog/<id>.ts` §`credentials`, one line per
agent: `{ anthropic: 'ANTHROPIC_API_KEY' }`). `env` and `secret_refs` are the
*override*: they are layered on top and win. An entry that declares nothing
inherits nothing. Likewise `default_model_id` overrides the workspace's
assignment for the agent's kind — Hermes takes `chat`, coding agents take
`coding` — and the resolved value is what `Agent.default_model` reports.

Indexes: unique (workspace, agent_id).

## Queries the clients need

- Agent picker: `agents where archived_at is null and install_state = 'installed'`
  left-joined with `agent_settings` for this workspace, `enabled != false`.
- Agents screen: every agent with adapter kind, version, install state, the
  live job (audit) and the per-workspace settings.
- Install / update: create a job, set `install_state`, stream `job.progress`.

## Updates (proposed 2026-09-25 — owner to confirm; DECISIONS, `update-policy.ts`)

- The catalog's pin is the **tested baseline**: a fresh install takes exactly it, and the
  contract exposes it as `install.pinned_version`.
- Every six hours (and on `check-update`) the hub asks the registry — npm's `latest`
  dist-tag, or PyPI's JSON — for the newest **stable** version of each agent it installed,
  without installing anything, and records it as `latest_version`. An unreachable registry
  fails `check-update` and is logged by the periodic check; it never reads as "up to date".
- An update installs that **exact** version (`package@x.y.z`), never the moving `latest`
  tag; a companion package (Pi's `pi-acp`) moves to its own newest release with it. A
  version past the pin is `newer_than_tested`, and clients say «أحدث من النسخة المختبرة».
- `auto_update` (per agent, off by default) takes an available update only while no run of
  the agent is in flight; a busy agent is tried again ten minutes later. While any update
  runs (`install_state = updating`), a turn asked for waits for it (at most 15 minutes)
  instead of starting on a CLI being replaced; afterwards the agent's open sessions are
  closed so the next turn starts the new CLI and resumes by its stored ref.
- Settings form: the adapter's declared settings schema (from code) + the
  `agent_settings` row; secrets shown as `[stored]`.

## The direct agent (ADOPTION-BACKLOG §2.15)

`direct` is a catalog entry like any other — slug `direct`, name "Direct" / «مباشر»,
adapter kind `builtin`, `source: builtin`, `install_state: installed` from the first
boot. It is the hub itself, so:

- **It is never installed or removed.** `install`/`update`/`uninstall` answer
  `422 agent_unavailable`, the same guard that protects the bundled Hermes runtime.
- **It declares no `credentials`** and starts no process. Where a coding agent inherits
  the workspace's keys as environment variables, this one resolves the workspace's
  provider *per turn* through the same `models` port (ADR 0010) and never sees a key:
  `AgentModelsPort.directChat(workspace, { provider_id, model, messages })` hands back
  events, not rows.
- **The model decides the provider.** The session's model, or the workspace's `chat`
  default, resolves to a `providers` row; that row's protocol picks which `models`
  adapter streams the turn. The person configures nothing new for this agent.
- **Capabilities are `streaming`, `vision`, `resume` — and nothing else.** No `tools`,
  no `approvals`, no `mcp`, no `skills`: skills and MCP over the direct path are backlog
  §2.16 and are not half-built here. Whether an *image* may be sent is the chosen model
  row's own `vision` capability, checked per turn.
- **Attachments** are read off disk and put in the request, because there is no file
  tool to point at a path with. The limits and the refusals are in
  `docs/domain/models.md` §الاتصال المباشر.
- **Errors are the contract's codes with the provider's own sentence**: the adapter made
  the request itself, so it reports the code rather than leaving the runner to read one
  out of the wording (`agents/runner.ts` §`failureCode`, which is still how the gateway
  adapters work).
- **Usage and cost are written like any other run's.** The provider's token counts,
  multiplied by the model row's published prices, land in the audit ledger as
  `cost_source: estimated`. A model row with no prices reports no number, never zero.

**Not stored: the conversation.** A live `AgentSession` holds the turns in the server
process, exactly as a Hermes gateway holds its own and an ACP child holds its own. A
restart therefore starts a fresh context — the transcript in `sessions` is intact, but
the model has not read it. Closing that is a transcript port from `sessions` to the
runner, which is a change to `sessions/ports.ts` and its own task.

## The Hermes runtime (ADR 0008, ADR 0010)

The hub supervises `hermes gateway run` as a child process when the image (or the host)
has the `hermes` executable and no gateway already answers on the endpoint; its home is
`${DATA_DIR}/hermes`, its API server key `${DATA_DIR}/keys/hermes-api.secret`. The
runtime state (`starting`, `running`, `error`, `stopped`) is process memory reported on
the `hermes` row; `agents.restart` recycles the child and is `409 state_invalid` when the
gateway is external or absent.

Hermes takes its provider keys from that home, not from the environment the hub spawns it
with, so the `models` module writes `${HERMES_HOME}/.env` and `${HERMES_HOME}/config.yaml`
and then recycles the same child (ADR 0010 §3). That is why the `hermes` catalog entry
declares no `credentials`: two paths to one setting would eventually disagree.

## The hub's own tools (contract decision §67)

`hub_tool_settings` (scoped, one row per workspace): `enabled`, `groups` (per group
`{enabled, allowWrites}`; a missing group reads, never writes) and `key_hash` — the SHA-256 of
the key written into the profile's Hermes `.env` as `COREHUB_MCP_TOKEN` (`null` while off; the
key itself is never stored). `hub_tool_calls` (scoped): the newest 200 calls per workspace —
`tool`, `ok`, `error_code`, the `user_id` / `session_id` / `run_id` acted for.

Not stored: the **run leases** and **run tokens** (`hub-tools/leases.ts`,
`auth/run-tokens.ts`) live in memory for the life of a run, because nothing may act in the
name of a run that no longer exists — a restart ends both.

A **channel lease** (contract decision §79) is the same thing for a turn of Hermes's messaging
gateway: opened by the hub's hook (`hooks/corehub/` in the profile's Hermes home) when the turn
starts, for the person who linked the sender (`auth`'s `channel_identities`) or for nobody with
the reason, and closed when it ends (fifteen quiet minutes at most). Also memory only. A call's
`X-Corehub-Origin` (`hub` or `gateway`, from the `COREHUB_MCP_ORIGIN` the hub sets in each Hermes
process) says which kind of lease it may belong to.

## A coding agent's config files (contract decision §78)

Not stored in the database: the files are the agent's own, in the home of the user the hub runs
as (`config-files.ts` lists each agent's two), one set for every profile. The hub keeps only the
previous version of each write under `<DATA_DIR>/backups/agent-config/<agent>/<key>/` (the newest
ten) and an `agent_config_file.written` audit event.

## Not stored

- The agent's own configuration files, memory, skills sources, plugin caches.
- Process handles, PTYs, ACP connections (in memory, per server process).
- Binaries on the host that are not catalog entries: `agents.discover` reports them
  under `result.ignored` and stores nothing, so the registry is never a surprise and
  never contains software nobody approved.
