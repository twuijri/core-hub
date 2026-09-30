// Claude Code over ACP. The ACP bridge is a separate package from the CLI itself; it is
// what speaks the protocol the hub drives (ADR 0002).
import type { CatalogEntry } from './types.js';

export const claudeCode: CatalogEntry = {
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  licence: 'Apache-2.0',
  adapter: 'acp',
  // The bridge's program since it moved to the ACP organisation (0.17+); an install of the
  // deprecated `@zed-industries/claude-code-acp` has `claude-code-acp` and keeps running it
  // until the person takes the update (DECISIONS §139).
  binary: 'claude-agent-acp',
  protocolArgs: [],
  versionArgs: ['--version'],
  install: {
    kind: 'npm',
    package: '@agentclientprotocol/claude-agent-acp',
    // Checked on 2026-09-30: `initialize` and `session/new` from the hub, and a turn against a
    // local Anthropic-compatible endpoint named by `ANTHROPIC_BASE_URL` (the key reached it).
    version: '0.84.0',
    legacy: [{ package: '@zed-industries/claude-code-acp', binary: 'claude-code-acp' }],
  },
  // Claude Code reads the Anthropic key from the standard variable.
  credentials: { anthropic: 'ANTHROPIC_API_KEY' },
  // What the bridge and Claude Code read from the environment (their docs and `dist/` at 0.84.0):
  // the Anthropic route and its alternatives (Bedrock, Vertex), Claude Code's own settings, and
  // whether it may open a browser.
  hostEnv: [
    'ANTHROPIC_*',
    'CLAUDE_*',
    'AWS_*',
    'CLOUD_ML_REGION',
    'VERTEX_REGION_*',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'DISABLE_*',
    'MAX_THINKING_TOKENS',
    'MAX_MCP_OUTPUT_TOKENS',
    'MCP_TIMEOUT',
    'MCP_TOOL_TIMEOUT',
    'BASH_DEFAULT_TIMEOUT_MS',
    'BASH_MAX_TIMEOUT_MS',
    'BASH_MAX_OUTPUT_LENGTH',
    'USE_BUILTIN_RIPGREP',
    'NO_BROWSER',
    'SSH_CLIENT',
    'SSH_CONNECTION',
    'SSH_TTY',
  ],
  // On the hub's model gateway (ADR 0029): Claude Code's own "LLM gateway" route. The token goes
  // as `Authorization: Bearer` (`ANTHROPIC_AUTH_TOKEN`, no interactive approval), every model
  // name it may ask for is one of the hub's aliases, and the betas and fields a non-Claude model
  // does not know are left out. It replaces a claude.ai sign-in for these calls, which is why a
  // signed-in Claude Code on a person's computer stays on its own account unless switched.
  gateway: {
    wire: 'anthropic',
    minContext: 64_000,
    env: (gw) => ({
      ANTHROPIC_BASE_URL: gw.anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: gw.token,
      ANTHROPIC_MODEL: gw.mainModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: gw.mainModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: gw.mainModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: gw.smallModel,
      CLAUDE_CODE_SUBAGENT_MODEL: gw.mainModel,
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(gw.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(gw.contextWindow) } : {}),
    }),
    clears: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ],
  },
  // The hub asks npm's package for the version (#226), so nothing is run at boot.
  health: { kind: 'installed' },
  capabilities: [
    'streaming',
    'tools',
    'approvals',
    'mcp',
    'skills',
    'worktrees',
    'resume',
    'config_files',
  ],
  sections: ['skills', 'mcp', 'settings'],
  // The bridge names a `Task` delegation and its end; the subagent's own tools arrive flat,
  // without a parent id, and it offers no stop or steer of one subagent (§56).
  subagents: 'observe',
};
