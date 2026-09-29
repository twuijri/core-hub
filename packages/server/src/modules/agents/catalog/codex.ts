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
  // On the hub's model gateway (ADR 0029): a model provider of the hub's own, speaking Responses,
  // whose key is the session token (`env_key`), passed to the session as `CODEX_CONFIG` — a
  // repository's `.codex/config.toml` cannot move `model_provider`. When Codex has no sign-in,
  // codex-acp's own `gateway` sign-in method is used with the same address and token: it only
  // changes the running session, never Codex's `auth.json` (the `api-key` method would write the
  // token there, over a person's ChatGPT sign-in).
  gateway: {
    wire: 'openai-responses',
    env: (gw) => ({
      COREHUB_GATEWAY_TOKEN: gw.token,
      CODEX_CONFIG: JSON.stringify({
        model_provider: 'corehub',
        model: gw.mainModel,
        model_providers: {
          corehub: {
            name: 'Core Hub',
            base_url: gw.openaiBaseUrl,
            env_key: 'COREHUB_GATEWAY_TOKEN',
            wire_api: 'responses',
          },
        },
        ...(gw.contextWindow ? { model_context_window: gw.contextWindow } : {}),
      }),
      DEFAULT_AUTH_REQUEST: JSON.stringify({
        methodId: 'gateway',
        _meta: {
          gateway: {
            baseUrl: gw.openaiBaseUrl,
            headers: { Authorization: `Bearer ${gw.token}` },
            providerName: 'Core Hub',
          },
        },
      }),
    }),
    clears: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'MODEL_PROVIDER'],
  },
  // The hub asks npm's package for the version (#226), so nothing is run at boot.
  health: { kind: 'installed' },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'config_files'],
  sections: ['mcp', 'settings'],
  // codex-acp 0.16 sent no report of Codex's `spawn_agent` delegations (§56); 2.0 is not yet
  // checked for them, so the hub still offers nothing for one.
  subagents: 'none',
};
