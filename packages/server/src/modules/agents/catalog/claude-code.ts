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
