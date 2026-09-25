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
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume'],
  sections: ['mcp', 'settings'],
};
