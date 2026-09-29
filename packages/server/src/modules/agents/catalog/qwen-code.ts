// Qwen Code over ACP (`qwen --acp`). Verified 2026-09-25: 0.24.5 answers ACP `initialize`
// with loadSession, MCP over HTTP and SSE, and an OpenAI-key auth method.
import type { CatalogEntry } from './types.js';

export const qwenCode: CatalogEntry = {
  id: 'qwen-code',
  name: 'Qwen Code',
  vendor: 'Qwen',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'qwen',
  protocolArgs: ['--acp'],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: '@qwen-code/qwen-code', version: '0.24.5' },
  // Qwen Code's own auth table: `OPENAI_API_KEY` selects its OpenAI-compatible mode on its
  // own; the Anthropic and Gemini keys are read when its settings choose those protocols.
  credentials: {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
  },
  // Qwen Code's own settings and the providers it speaks to.
  hostEnv: ['QWEN_*', 'OPENAI_*', 'ANTHROPIC_*', 'GEMINI_*', 'GOOGLE_*', 'DASHSCOPE_*'],
  // On the hub's model gateway (ADR 0029): its OpenAI-compatible mode, which `OPENAI_API_KEY`
  // selects on its own (its auth table), at the gateway's Chat Completions address. A person's
  // own `modelProviders` selection in `~/.qwen/settings.json` still wins, as Qwen Code orders it.
  gateway: {
    wire: 'openai-chat',
    env: (gw) => ({
      OPENAI_BASE_URL: gw.openaiBaseUrl,
      OPENAI_API_KEY: gw.token,
      OPENAI_MODEL: gw.mainModel,
    }),
    clears: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GEMINI_API_KEY', 'DASHSCOPE_API_KEY'],
  },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume', 'config_files'],
  sections: ['mcp', 'settings'],
  // Not verified that its ACP stream marks a delegation, so none is claimed (§56): an
  // unmarked tool call stays the parent's (added when #114 and #140 were integrated).
  subagents: 'none',
};
