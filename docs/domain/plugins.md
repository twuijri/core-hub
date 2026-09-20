# plugins

Owns: `plugin`, `plugin_binding`, `plugin_tool`. Schema:
`packages/server/src/modules/plugins/schema.ts`. `plugins` and
`plugin_tools` are global (installed on the host, declared by the
manifest); `plugin_bindings` is scoped. Base columns omitted.

A plugin is an MCP server, a Docker service that speaks MCP, or a skill
pack. Installing it is a job; enabling it in a workspace is a binding with
config and secrets; the tools it exposes are rows the agent picker and the
skills screen list.

## plugin (global)

| column | type | meaning |
|---|---|---|
| slug | text(64), unique | |
| name, description, icon | | |
| kind | enum(mcp_server, docker, skill_pack) | |
| source | enum(registry, manual, git) | |
| source_ref | text? | registry name, git URL or image reference |
| version | text(64)? | |
| install_state | enum(not_installed, installing, installed, updating, broken, removed) | |
| install_job_id | ulid? → audit.job | |
| manifest | json<PluginManifest> | name, version, start (argv or image+ports), config keys with `secret`/`required`, declared tools |
| last_error | text? | |
| archived_at | ms? | |

Install lifecycle: `not_installed → installing → installed | broken`;
`installed → updating → installed | broken`; `installed | broken → removed`
(terminal; files gone, row kept for bindings to show "removed").

## plugin_binding (scoped)

| column | type | meaning |
|---|---|---|
| plugin_id | ulid → plugin (FK, cascade) | |
| enabled | bool | |
| config | json | non-secret values for the manifest's config keys |
| secret_refs | json<Record<string,string>> | config key → models.secret id |
| exposed_to | json<string[]> | agents.agent ids or `["*"]` |
| status | enum(stopped, starting, running, error) | for mcp_server/docker: the process/container state for this workspace |
| last_started_at, last_error | | |

Lifecycle: `stopped → starting → running → stopped`; `starting | running →
error → starting` (retry). `stopped` is the resting state; disabling stops.

Unique (workspace, plugin_id).

## plugin_tool (global)

| column | type | meaning |
|---|---|---|
| plugin_id | ulid → plugin (FK, cascade) | |
| key | text(120) | unique per plugin |
| name, description | | |
| kind | enum(tool, skill, prompt, resource) | MCP tool / skill file / prompt template / resource |
| input_schema | json? | JSON Schema as declared |

Rows are refreshed from the manifest at install and from the running server
when it lists its tools.

## Queries the clients need

- Plugins screen: plugins with install state and, for the workspace, the
  binding (enabled, status) — a left join by `plugin_id`.
- Enable: upsert binding, validate `config` against the manifest, start (job
  or direct), emit status.
- Tools/skills exposure for an agent run: enabled bindings in the workspace
  whose `exposed_to` includes the agent → their `plugin_tools`; the adapter
  passes them to the agent.
- Skills screen: `plugin_tools where kind = 'skill'` joined to enabled
  bindings.

## Not stored

- Plugin code, images, MCP server processes and their stdio; only
  references and states.
- Tool call results (they are `tool_calls` in sessions).
- Secrets in `config` (the manifest marks which keys are secret; those go to
  `secret_refs`, and a config write with a secret key in clear is rejected).
