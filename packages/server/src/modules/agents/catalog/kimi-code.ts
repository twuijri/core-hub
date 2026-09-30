// Kimi Code CLI from Moonshot AI over ACP (`kimi acp`). It replaced the archived Python
// `kimi-cli` (read-only since 2026-09-22), so the catalog carries the npm one.
// Verified 2026-09-25: 2.1.1 answers ACP `initialize` with loadSession, resume, MCP over
// HTTP and SSE, and permission requests.
import type { CatalogEntry } from './types.js';

export const kimiCode: CatalogEntry = {
  id: 'kimi-code',
  name: 'Kimi Code',
  vendor: 'Moonshot AI',
  licence: 'MIT',
  adapter: 'acp',
  binary: 'kimi',
  protocolArgs: ['acp'],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: '@moonshot-ai/kimi-code', version: '2.1.1' },
  // Kimi Code reads no key from the environment (its `env-vars.md`: keys live in its own
  // `config.toml`, or come from `kimi login`), so handing it one would do nothing. It signs
  // in with its own Kimi account: `kimi login` is a device-code flow that prints its link and
  // code and needs no browser on the hub (checked on 2.1.1, 2026-09-26), so the hub starts it
  // (`signIn`). `--region global` is kimi.ai; the mainland-China kimi.com account is not
  // offered. The API-key route stays the Config files page: a provider block with its
  // `api_key` in `config.toml`.
  credentials: {},
  // Kimi Code's own settings and Moonshot's.
  hostEnv: ['KIMI_*', 'MOONSHOT_*'],
  // On the hub's model gateway (ADR 0029): Kimi Code's environment-only "temporary model" (its
  // env-vars page: `KIMI_MODEL_NAME` and `KIMI_MODEL_API_KEY` both required), OpenAI-compatible,
  // at the gateway. Nothing is written to its `config.toml`.
  gateway: {
    wire: 'openai-chat',
    minContext: 32_000,
    env: (gw) => ({
      KIMI_MODEL_NAME: gw.mainModel,
      KIMI_MODEL_API_KEY: gw.token,
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: gw.openaiBaseUrl,
      ...(gw.contextWindow ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(gw.contextWindow) } : {}),
    }),
    clears: [],
  },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume', 'config_files'],
  sections: ['mcp', 'settings'],
  // Not verified that its ACP stream marks a delegation, so none is claimed (§56): an
  // unmarked tool call stays the parent's (added when #114 and #140 were integrated).
  subagents: 'none',
  signIn: { args: ['login', '--region', 'global'] },
};
