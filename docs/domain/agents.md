# agents

Owns: `agent_adapter`, `agent`, `agent_settings`. Schema:
`packages/server/src/modules/agents/schema.ts`.

`agent_adapters` and `agents` are global (an installed CLI is a host fact);
`agent_settings` is scoped (ADR 0005). Base columns omitted.

The vocabulary is the contract's: `adapter_kind`, `capabilities`, `sections` and
`source` hold exactly the values of `AgentKind`, `AgentCapability`, `AgentSection` and
`AgentInstall.source` in `packages/contracts/openapi.yaml`, so no translation table sits
between the database and the API.

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
| latest_version | text(64)? | the catalog's pinned version — what "up to date" means |
| auto_update | bool | only for agents the hub installs |
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

Indexes: unique (workspace, agent_id).

## Queries the clients need

- Agent picker: `agents where archived_at is null and install_state = 'installed'`
  left-joined with `agent_settings` for this workspace, `enabled != false`.
- Agents screen: every agent with adapter kind, version, install state, the
  live job (audit) and the per-workspace settings.
- Install / update: create a job, set `install_state`, stream `job.progress`.
- Settings form: the adapter's declared settings schema (from code) + the
  `agent_settings` row; secrets shown as `[stored]`.

## Not stored

- The agent's own configuration files, memory, skills sources, plugin caches.
- Process handles, PTYs, ACP connections (in memory, per server process).
- Binaries on the host that are not catalog entries: `agents.discover` reports them
  under `result.ignored` and stores nothing, so the registry is never a surprise and
  never contains software nobody approved.
