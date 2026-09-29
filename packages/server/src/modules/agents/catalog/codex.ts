// OpenAI Codex over ACP, through the `codex-acp` adapter (the Codex CLI itself does not expose
// an ACP transport; the adapter wraps it and speaks ACP on stdio).
import type { CatalogEntry } from './types.js';

export const codex: CatalogEntry = {
  id: 'codex',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  licence: 'Apache-2.0',
  adapter: 'acp',
  // The same program name before and after the adapter moved to the ACP organisation.
  binary: 'codex-acp',
  protocolArgs: [],
  versionArgs: ['--version'],
  install: {
    kind: 'npm',
    package: '@agentclientprotocol/codex-acp',
    // Checked on 2026-09-30: `initialize` and `session/new` from the hub, and a turn against a
    // local OpenAI Responses endpoint named in `CODEX_CONFIG` (the key reached it). It installs
    // `@openai/codex` beside it. An install of the deprecated `@zed-industries/codex-acp` keeps
    // running until the person takes the update (DECISIONS §139).
    version: '2.0.0',
    legacy: [{ package: '@zed-industries/codex-acp', binary: 'codex-acp' }],
  },
  // Codex talks to OpenAI directly; its base URL is `config.toml`'s, the person's business.
  credentials: { openai: 'OPENAI_API_KEY' },
  // What codex-acp and Codex read from the environment (`dist/index.js` at 2.0.0, Codex's docs):
  // its home and config, the key it prefers, and the adapter's own switches.
  hostEnv: [
    'OPENAI_*',
    'CODEX_*',
    'AZURE_OPENAI_*',
    'MODEL_PROVIDER',
    'DEFAULT_AUTH_REQUEST',
    'INITIAL_AGENT_MODE',
    'DISABLE_MCP_CONFIG_FILTERING',
    'APP_SERVER_LOGS',
    'RUST_LOG',
    'NO_BROWSER',
  ],
  // The hub asks npm's package for the version (#226), so nothing is run at boot.
  health: { kind: 'installed' },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'config_files'],
  sections: ['mcp', 'settings'],
  // codex-acp 0.16 sent no report of Codex's `spawn_agent` delegations (§56); 2.0 is not yet
  // checked for them, so the hub still offers nothing for one.
  subagents: 'none',
};
