# agents

Owns: `agent_adapter`, `agent`, `agent_settings`. Schema:
`packages/server/src/modules/agents/schema.ts`.

`agent_adapters` and `agents` are global (an installed CLI is a host fact);
`agent_settings` is scoped (ADR 0005). Base columns omitted.

## agent_adapter (global)

One row per adapter implementation, seeded on boot from code so clients can
show what each connection kind supports (ADR 0002).

| column | type | meaning |
|---|---|---|
| kind | enum(acp, hermes, process), unique | |
| name | text(120) | "Agent Client Protocol", "Hermes gateway", "Process harness" |
| version | text(32) | adapter code version |
| capabilities | json<AgentCapabilities> | streaming, toolCalls, approvals, interrupt, resumeSession, reasoning, attachments, memory, skills, commandWhitelist |
| status | enum(available, unavailable) | e.g. hermes gateway unreachable |
| last_probe_at, last_error | | |

## agent (global)

A registry entry: something the hub can start or talk to.

| column | type | meaning |
|---|---|---|
| slug | text(64), unique | `claude-code`, `codex`, `hermes` |
| name, description, icon | | |
| adapter_id | ulid → agent_adapter (FK, restrict) | |
| adapter_kind | enum(acp, hermes, process) | denormalised for lists |
| source | enum(detected, manual, bundled) | auto-detected on the host, added by the user, or shipped in the image |
| command | json<string[]> | argv to start it; never a shell string |
| executable_path | text? | resolved binary |
| endpoint | text? | Hermes gateway URL |
| version | text(64)? | last probed version |
| install_state | enum(not_installed, installing, installed, updating, broken) | |
| install_job_id | ulid? → audit.job | the running install/update job |
| detected_at | ms? | |
| capabilities | json<AgentCapabilities> | probed; overrides the adapter's defaults |
| limited | bool | true for process-harness agents; UI marks them |
| last_error | text? | |
| archived_at | ms? | hidden from pickers; sessions keep working |

Install lifecycle: `not_installed → installing → installed | broken`;
`installed → updating → installed | broken`; `broken → installing` on retry.
`installed` and `not_installed` are the resting states; each move is a job.

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
- Discovered-but-declined binaries: detection writes a row only when the user
  accepts it, so the registry is never a surprise.
