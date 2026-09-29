# Coding-agent features the hub could manage (research, 2026-09-29)

**Status: research only. Do not build yet.** This note lists what each ACP agent in the catalog can be
configured with beyond the two things the hub already edits: the fixed instructions and settings files
(`config-files.ts`), and user-scope MCP for Claude Code, Gemini CLI and Qwen Code (`coding-agent-mcp.ts`).
Every build item needs an owner decision and a change record first.

**Method.** I read the catalog pins in `packages/server/src/modules/agents/catalog/*.ts`, then each vendor's
official docs. Where I could, I also read the vendor's source **at the pinned tag** through `gh api`:
gemini-cli `v0.60.0`, qwen-code `v0.24.5`, goose `v1.52.0`, kimi-code `@2.1.1`, pi `v0.87.1`, codex-acp
`v0.16.0`, which builds on codex `rust-v0.137.0`. For Claude Code I read the installed
`@zed-industries/claude-code-acp@0.16.2`, which bundles Agent SDK 0.2.44 = Claude Code 2.1.44. Grok Build
has no tags, so its docs were read at `main`, not at the pinned 1.0.41. Docs sites describe the newest
release, which can be newer than our pins; any gap is called out below. I did not open agent-studio,
Hermes Studio or Ekko Studio code (clean-room rule).

**Scope reminder.** Each agent reads these files from the hub user's home (`HOME=/data/home` in the image).
That makes every item below **global to all hub profiles**. Each agent does have its own variable for moving
its home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`, `KIMI_CODE_HOME`,
`PI_CODING_AGENT_DIR`, `GROK_HOME`), so per-profile homes are possible later. That would be a separate
decision.

Legend. **ACP?** says whether the feature takes effect when the hub runs the agent through its pinned bridge
or ACP mode: yes, no, likely (the loading code path is shared but I did not test it end to end), or
unverified. **Safe?** says whether the hub could manage it the way the Skills and Config-files pages manage
theirs: plain files, a fixed path list, a backup before each write, admin only. **Effort:** S means adding
entries to an existing fixed list, M means a new page that reuses an existing editor, L means a new structured
editor or installer.

## Main table

| Agent | Feature | Where it lives (user; project) | Format | ACP? | Safe? | Effort |
|---|---|---|---|---|---|---|
| Claude Code | Skills | `~/.claude/skills/<n>/SKILL.md`; `.claude/skills/` | SKILL.md folder | yes: bridge sets `settingSources:["user","project","local"]`, skills load by default | yes, plain folders like the Hermes Skills page | M |
| Claude Code | Slash commands | `~/.claude/commands/*.md`; `.claude/commands/` | MD + frontmatter (docs call skills the successor) | yes: bridge sends the SDK's `supportedCommands()` as ACP `available_commands_update` | yes, plain files | M |
| Claude Code | Subagents | `~/.claude/agents/*.md`; `.claude/agents/` | MD + YAML frontmatter | yes: `"user"` source loads user agents | yes, plain files | M |
| Claude Code | Hooks | `hooks` key in `~/.claude/settings.json` | JSON | yes: filesystem hooks load via `settingSources` | partly: already editable raw on Config files; hooks run shell commands as the hub user, so admin only with a warning | S (warning) / L (structured) |
| Claude Code | Rules | `~/.claude/rules/*.md` (optional `paths:` globs) | MD | yes: `"user"` loads user rules (the rules loader is in bundled 2.1.44) | yes, plain files | S–M |
| Claude Code | Output styles | `~/.claude/output-styles/*.md` + `outputStyle` in settings | MD + frontmatter | unverified: the bridge forces the `claude_code` preset system prompt | partly: files are plain, the effect over ACP is unknown | M |
| Claude Code | Plugins / marketplaces | `~/.claude/plugins/` (`installed_plugins.json`, `known_marketplaces.json`, `marketplaces/`) + `enabledPlugins` in settings | Claude-written state + git clones | unverified (the `/plugin` UI is interactive) | no: rewritten state files and network installs; at most toggle `enabledPlugins` | L |
| Claude Code | Permissions | `permissions.allow/ask/deny` in `~/.claude/settings.json` | JSON | yes (user settings) | yes, but it is already reachable through Config files; a structured editor is optional | S–M |
| Codex CLI | Skills | `~/.agents/skills/` (new) and `~/.codex/skills/` (deprecated, still read); `.agents/skills/` | SKILL.md folder; `[[skills.config]] enabled=false` in config.toml | likely: codex-core 0.137 injects skills itself (the loader reads both roots); no ACP slash entry | yes: write `~/.agents/skills`, which other agents share | M |
| Codex CLI | Custom prompts | `~/.codex/prompts/*.md` | MD | no: codex-acp 0.16 advertises only built-ins (`review`, `review-branch`, `review-commit`, `init`, `compact`, `logout`); prompts are also deprecated | no, not worth building | — |
| Codex CLI | Subagents (custom agents) | `~/.codex/agents/*.toml`; `.codex/agents/` | TOML (`name`, `description`, `developer_instructions`) | unverified at 0.137; the hub does not report Codex delegations (§56) | yes, plain files | M |
| Codex CLI | Hooks | `~/.codex/hooks.json` or inline `[hooks]` in config.toml; `.codex/` | JSON/TOML | unverified: current docs make non-managed hooks wait for a trust review (`/hooks`), and ACP has no such UI | partly: code execution plus trust gating | L |
| Codex CLI | Notify | `notify = [...]` in config.toml | TOML | likely (core) | yes, already raw-editable | — |
| Codex CLI | Plugins | `~/.codex/plugins/cache/...`; `[plugins."n@mkt"] enabled`; `~/.agents/plugins/marketplace.json` | Codex-written cache + TOML | unverified | no (installer state) | L |
| Codex CLI | Permissions | `approval_policy`, `sandbox_mode`, `[permissions.*]` in config.toml | TOML | codex-acp maps modes to ACP; the file's defaults apply | yes, already raw-editable | — |
| Gemini CLI | Custom commands | `~/.gemini/commands/**/*.toml`; `.gemini/commands/` | TOML (`prompt`, `description`) | no: the ACP `CommandHandler` registers only `memory`, `extensions`, `init`, `restore`, `about`, `help` | yes as files, but no effect over ACP | — |
| Gemini CLI | Skills | `~/.gemini/skills/` or `~/.agents/skills/`; `.gemini/skills/`, `.agents/skills/` | SKILL.md folder | likely: the ACP session calls the CLI's `loadCliConfig` | yes, plain folders | M |
| Gemini CLI | Subagents | `~/.gemini/agents/*.md`; `.gemini/agents/` | MD + YAML frontmatter; `experimental.enableAgents` | likely (same config path) | yes, plain files | M |
| Gemini CLI | Hooks | `hooks` in `~/.gemini/settings.json` | JSON | likely; project hooks are fingerprinted and need trust | partly: code execution; already raw-editable | S (warning) |
| Gemini CLI | Extensions | `~/.gemini/extensions/<n>/gemini-extension.json` (bundles MCP, commands, skills, agents, hooks, context) | JSON + folders; installed by `gemini extensions install` | likely: extensions load and `/extensions` is an ACP command | no: installer-owned, network, restart | L |
| Qwen Code | Skills | `~/.qwen/skills/`; `.qwen/skills/` | SKILL.md folder; `skills.enabled/disabled/defaultDisabled` in settings | yes: ACP lists skills as commands and has `qwen/skills/install` and `qwen/skills/delete` extension methods | yes, plain folders (or through Qwen's own ACP methods) | M |
| Qwen Code | Custom commands | `~/.qwen/commands/**/*.md`; `.qwen/commands/` | MD + frontmatter | yes: `buildAvailableCommandsSnapshot` sends slash commands over ACP | yes, plain files | M |
| Qwen Code | Subagents | `~/.qwen/agents/`; `.qwen/agents/` | MD + frontmatter | likely | yes, plain files | M |
| Qwen Code | Hooks | `hooks` + `disableAllHooks` in `~/.qwen/settings.json` | JSON | yes: the ACP agent has hook listing and redaction code; project hooks load only in a trusted folder | partly: code execution; already raw-editable | S (warning) |
| Qwen Code | Rules / output styles | `~/.qwen/rules/*.md`, `~/.qwen/output-styles/*.md` | MD | unverified over ACP | yes, plain files | S–M |
| Qwen Code | Extensions | `~/.qwen/extensions/<n>/qwen-extension.json` (also installs Gemini and Claude plugins) | JSON + folders | unverified | no (installer) | L |
| Goose | Global hints | `~/.config/goose/.goosehints` and `~/.config/goose/AGENTS.md` (default `CONTEXT_FILE_NAMES`) | text/MD | likely: hints load at session start through the Developer extension | yes: **add to Config files** (the hub lists only `config.yaml` for Goose today) | S |
| Goose | Skills | `~/.agents/skills/` (legacy `.goose/skills/`); `.agents/skills/` | SKILL.md folder | yes: the ACP slash-command list includes `Skill` entries | yes, shared `~/.agents/skills` | M |
| Goose | Recipes + slash commands | `~/.config/goose/recipes/*.yaml` (+ `GOOSE_RECIPE_PATH`); `slash_commands:` in config.yaml | YAML | yes: the ACP slash-command list includes `Recipe` entries | yes, plain YAML files | M |
| Goose | Tool permissions | `~/.config/goose/permission.yaml`; `GOOSE_MODE` in config.yaml | YAML (written by `goose configure`) | likely | partly: goose rewrites it | M |
| Goose | Secrets | `~/.config/goose/secrets.yaml` (file-based secret storage) | YAML, plain-text keys | n/a | **no**: never expose it | — |
| OpenCode | Config + rules | `~/.config/opencode/opencode.json(c)`; `~/.config/opencode/AGENTS.md` (falls back to `~/.claude/CLAUDE.md`) | JSON(C) / MD | yes: the ACP docs list "Project-specific rules from AGENTS.md" and the permissions system | yes: **add both to Config files** (they were previously left out as unverified) | S |
| OpenCode | Custom commands | `~/.config/opencode/commands/*.md`; `.opencode/commands/` | MD + frontmatter, or the `command` key | yes: the ACP docs list "Custom tools and slash commands" | yes, plain files | M |
| OpenCode | Agents | `~/.config/opencode/agents/*.md`; `.opencode/agents/` | MD + frontmatter (`mode`, `permission`) | yes: the ACP docs list the "Agents and permissions system" | yes, plain files | M |
| OpenCode | Skills | `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` | SKILL.md folder | unverified (the ACP docs do not mention skills) | yes, shared folders | M |
| OpenCode | Plugins | `~/.config/opencode/plugins/*.{js,ts}`; the `plugin` array (npm) | JS/TS modules (event hooks) | unverified | no: arbitrary code | L |
| Kimi Code | Skills | `~/.kimi-code/skills/`, `~/.agents/skills/`; `.kimi-code/skills/` | SKILL.md folder | likely: ACP streams `available_commands_update` | yes, plain folders | M |
| Kimi Code | Custom agents | `~/.kimi-code/agents/`, `~/.agents/agents/`; `.kimi-code/agents/` | MD + frontmatter | likely | yes, plain files | M |
| Kimi Code | SYSTEM.md | `~/.kimi-code/SYSTEM.md` (replaces the main prompt) | MD | yes: "takes effect in every launch mode" | yes: add to Config files, with a warning | S |
| Kimi Code | Hooks | `[[hooks]]` in `~/.kimi-code/config.toml` (4 fields) | TOML | likely | partly: code execution; already raw-editable | S (warning) |
| Kimi Code | Plugins | `$KIMI_CODE_HOME/plugins/managed/<id>/` | installer copies | unverified | no (installer) | L |
| Pi | Skills | `~/.pi/agent/skills/`, `~/.agents/skills/`; `.pi/skills/` | SKILL.md folder (`/skill:name`) | yes: pi-acp README says "Skills are loaded by pi directly" | yes, plain folders | M |
| Pi | Prompt templates | `~/.pi/agent/prompts/*.md`; `.pi/prompts/` | MD + frontmatter | yes: pi-acp "Loads file-based slash commands" | yes, plain files | M |
| Pi | SYSTEM / APPEND_SYSTEM | `~/.pi/agent/SYSTEM.md`, `APPEND_SYSTEM.md` | MD | likely (pi loads them itself) | yes: add to Config files | S |
| Pi | Extensions / packages | `~/.pi/agent/extensions/*.ts`; packages declared in settings.json | TS modules / npm / git | likely | no: arbitrary code | L |
| Grok Build | Instructions / rules | `~/.grok/rules/*.md` (no home AGENTS.md listed); project `AGENTS.md` | MD | unverified at 1.0.41 | yes: add to Config files | S |
| Grok Build | Config | `~/.grok/config.toml` (MCP, `[skills]`, `[compat.*]`, `[permission]`) | TOML | yes (docs describe `grok agent stdio`) | yes: **add to Config files** | S |
| Grok Build | Skills / commands | `~/.grok/skills/`, `~/.grok/commands/*.md`, `.agents/skills/` at each tier, **plus `~/.claude/skills/` by default** | SKILL.md / MD | unverified at 1.0.41 | yes, plain files | M |
| Grok Build | Hooks | `~/.grok/hooks/*.json`, `[hooks]` in config.toml; also scans Claude/Cursor hooks by default | JSON/TOML | unverified | partly: code execution | L |
| Grok Build | Subagents / personas | `~/.grok/agents/*.md`, `~/.grok/personas/*.toml` | MD / TOML | unverified | yes, plain files | M |
| Grok Build | Plugins | marketplaces via `grok plugin ...`; hooks and MCP stay off until trusted | installer state | unverified | no | L |

**Cross-agent coupling (surface this in the UI).** Grok Build reads `~/.claude/skills`, `~/.claude/rules`,
`~/.claude.json` MCP servers and Claude hooks by default (the `[compat.claude]` cells default to on). OpenCode
reads `~/.claude/CLAUDE.md` and `~/.claude/skills`. `~/.agents/skills` is read by Codex, Gemini, Goose, Kimi,
OpenCode, Pi and Grok. So one edit on the Claude pages can change what Grok and OpenCode see.

## MCP config per agent (for extending the MCP page)

| Agent | File (user scope) | Key | Format | Per-server enable flag? |
|---|---|---|---|---|
| Claude Code | `~/.claude.json` (already handled) | `mcpServers` | JSON (Claude also writes this file) | no user-scope flag; the hub stashes disabled entries |
| Gemini CLI | `~/.gemini/settings.json` (already handled) | `mcpServers` | JSON | no field; `mcp.excluded` / `mcp.allowed` lists; `gemini mcp disable` writes `~/.gemini/mcp-server-enablement.json` (unverified at 0.60) |
| Qwen Code | `~/.qwen/settings.json` (already handled) | `mcpServers` | JSON | no field (`enabled` there is OAuth's); `mcp.excluded` / `mcp.allowed` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.<id>]` (`command`, `args`, `env`, `url`, `required`, …) | TOML | **yes**: `enabled = false`. codex-acp 0.16 keeps config servers and adds the client's (`codex_agent.rs` `build_session_config`) |
| Goose | `~/.config/goose/config.yaml` | `extensions.<name>` (`type: stdio` + `cmd`/`args`/`envs`/`env_keys`, or `streamable_http` + `uri`/`headers`) | YAML (goose rewrites it) | **yes**: `enabled: true/false`. SSE is not supported |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `mcp.<name>` (`type: local` + `command[]`/`environment`, or `remote` + `url`/`headers`/`oauth`) | JSON(C) | **yes**: `enabled` |
| Kimi Code | `~/.kimi-code/mcp.json` (not config.toml) | `mcpServers` (`command`/`args`/`env`, or `url`/`headers`/`bearerTokenEnvVar`; `transport:"sse"`) | JSON | **yes**: `enabled: false`; also `enabledTools` / `disabledTools` |
| Grok Build | `~/.grok/config.toml` | `[mcp_servers.<name>]` | TOML | **yes**: `enabled`, plus a `disabled_mcp_servers` list. Also imports `~/.claude.json` servers by default |
| Pi | none at the pinned 0.87.1. **v0.99.0 (released 2026-09-29)** adds `~/.pi/agent/mcp.json` | `mcpServers` | JSON | yes (`enabled: false`) in 0.99. pi-acp 0.0.34 does **not** forward client MCP servers to pi |

## Recommendations (top 5, in order)

1. **One "Skills" page for coding agents, reusing the Hermes Skills editor.** Target `~/.agents/skills`
   (read by 7 of the 9 agents), plus `~/.claude/skills` and `~/.qwen/skills`, which neither Claude nor Qwen
   reads from `~/.agents`. These are plain SKILL.md folders following the same agentskills.io format Hermes
   uses, so the existing guards (fixed roots, no traversal, backups) carry over. It gives the most value for
   the effort. Label it clearly as shared by every profile and every agent that reads the folder. (M)
2. **Extend the MCP page to Codex, OpenCode, Kimi and Grok.** Their files and formats are verified above,
   and all four have a real per-server `enabled` flag, so toggling needs no stash. Codex and Grok use TOML,
   which needs a comment-preserving TOML writer. Hold Goose until its YAML is handled without losing goose's
   own rewrites. Hold Pi until the pin moves to ≥0.99 and pi-acp forwards MCP. (M each; TOML writer once)
3. **Close the gaps in the Config files list (cheap).** Add Goose `~/.config/goose/.goosehints` and
   `AGENTS.md`, OpenCode `opencode.json(c)` and `AGENTS.md`, Grok `config.toml` (plus the `~/.grok/rules/`
   folder if a folder editor exists), Kimi `SYSTEM.md` and Pi `SYSTEM.md` / `APPEND_SYSTEM.md`. The existing
   fixed-list, revision and backup design already fits. (S)
4. **Custom commands / prompt templates page, only for agents whose ACP mode exposes them.** That is Claude
   `~/.claude/commands`, Qwen `~/.qwen/commands`, OpenCode `commands/`, Pi `prompts/`, and Goose recipes
   with `slash_commands`. Leave out Gemini TOML commands and Codex prompts: the pinned ACP paths ignore
   them. (M)
5. **Subagent definitions page (Claude, Gemini, Qwen, OpenCode, Kimi; Codex TOML later).** These are plain
   Markdown-with-frontmatter files and match the hub's delegation reporting. Keep hooks, plugins and
   extensions **out of scope** for now: they run arbitrary code as the hub user, several need interactive
   trust, and their state files are installer-owned. At most, add a warning banner on the Config-files editor
   when a settings file contains `hooks`. (M)

Side findings to raise separately. `@zed-industries/claude-code-acp` has been renamed to
`@agentclientprotocol/claude-agent-acp`, and the pinned 0.16.2 bundles Claude Code 2.1.44, so newer features
(for example `workflows/`) will not work until the pin moves. `zed-industries/codex-acp` was archived on
2026-07-22 and moved to `agentclientprotocol/codex-acp`. Pi v0.99.0 shipped native MCP on 2026-09-29.

## Sources (all checked 2026-09-29)

- Claude Code settings: https://code.claude.com/docs/en/settings
- Claude `.claude` directory map: https://code.claude.com/docs/en/claude-directory
- Agent SDK, settingSources and loaded features: https://code.claude.com/docs/en/agent-sdk/claude-code-features
- Claude plugins manifest and layout: https://code.claude.com/docs/en/plugins-reference
- Claude output styles: https://code.claude.com/docs/en/output-styles
- Bridge source (local install): `~/.cache/corehub-agent/acp/inst/node_modules/@zed-industries/claude-code-acp/dist/acp-agent.js` (`settingSources`, `getAvailableSlashCommands`); SDK `package.json` `claudeCodeVersion: 2.1.44`
- Bridge repo, now renamed: https://github.com/zed-industries/claude-code-acp → agentclientprotocol/claude-agent-acp
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex skills: https://learn.chatgpt.com/docs/build-skills
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Codex subagents: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Codex custom prompts deprecation: https://developers.openai.com/codex/custom-prompts (seen via search result)
- Codex plugin cache path (secondary source, unverified in official docs): https://codex.danielvaughan.com/2026/06/04/codex-cli-plugin-management-terminal-commands-marketplace-json-output-v0137/
- codex-acp v0.16.0 source: https://github.com/zed-industries/codex-acp/tree/v0.16.0 (`src/thread.rs` `builtin_commands`, `src/codex_agent.rs`, `Cargo.toml` pin `rust-v0.137.0`)
- Codex 0.137 skill roots: https://github.com/openai/codex/blob/rust-v0.137.0/codex-rs/core-skills/src/loader.rs
- Gemini custom commands: https://geminicli.com/docs/cli/custom-commands/
- Gemini skills: https://geminicli.com/docs/cli/skills/ and https://github.com/google-gemini/gemini-cli/blob/v0.60.0/docs/cli/skills.md
- Gemini hooks: https://geminicli.com/docs/hooks/
- Gemini subagents: https://geminicli.com/docs/core/subagents/
- Gemini MCP: https://geminicli.com/docs/tools/mcp-server/
- Gemini extensions: https://geminicli.com/docs/extensions/reference/
- Gemini ACP source: https://github.com/google-gemini/gemini-cli/tree/v0.60.0/packages/cli/src/acp (`acpCommandHandler.ts`, `acpSessionManager.ts`)
- Qwen settings: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/
- Qwen docs at the pin: https://github.com/QwenLM/qwen-code/tree/v0.24.5/docs/users/features (`skills.md`, `sub-agents.md`, `hooks.md`, `commands.md`, `rules.md`, `output-styles.md`, `mcp.md`), `docs/users/extension/introduction.md`
- Qwen ACP source: https://github.com/QwenLM/qwen-code/tree/v0.24.5/packages/cli/src/acp-integration (`acpAgent.ts`, `session/Session.ts`)
- Goose docs at the pin: https://github.com/aaif-goose/goose/tree/v1.52.0/documentation/docs/guides (`config-files.md`, `context-engineering/using-goosehints.md`, `using-skills.md`, `slash-commands.md`, `recipes/storing-recipes.md`, `managing-tools/tool-permissions.md`)
- Goose ACP source: https://github.com/aaif-goose/goose/tree/v1.52.0/crates/goose/src/acp (`server/slash_commands.rs`, `response_builder.rs`)
- OpenCode docs: https://opencode.ai/docs/config/, https://opencode.ai/docs/mcp-servers/, https://opencode.ai/docs/acp/, https://opencode.ai/docs/rules/, https://opencode.ai/docs/skills/, https://opencode.ai/docs/plugins/, https://opencode.ai/docs/commands/, https://opencode.ai/docs/agents/
- Kimi Code config files: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html
- Kimi docs at the pin: https://github.com/MoonshotAI/kimi-code/tree/%40moonshot-ai/kimi-code%402.1.1/docs/en (`configuration/data-locations.md`, `customization/{agents,hooks,mcp,plugins,skills}.md`, `reference/kimi-acp.md`)
- Pi docs at the pin: https://github.com/earendil-works/pi/tree/v0.87.1/packages/coding-agent/docs (`configuration.md`, `skills.md`, `prompt-templates.md`, `extensions.md`, `packages.md`)
- Pi v0.99.0 release notes and MCP doc: https://github.com/earendil-works/pi/releases/tag/v0.99.0, https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/mcp.md
- pi-acp README (features and limitations): https://github.com/svkozak/pi-acp
- Grok Build user guide (at `main`, not the pinned 1.0.41): https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-pager/docs/user-guide (`05-configuration.md`, `07-mcp-servers.md`, `08-skills.md`, `09-plugins.md`, `10-hooks.md`, `12-project-rules.md`, `16-subagents.md`)
