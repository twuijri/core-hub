// OpenCode over ACP (`opencode acp`).
import type { CatalogEntry } from './types.js';

export const opencode: CatalogEntry = {
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'SST',
  licence: 'MIT',
  adapter: 'acp',
  binary: 'opencode',
  protocolArgs: ['acp'],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: 'opencode-ai', version: '1.18.31' },
  // OpenCode routes through whichever provider it is configured for, so it is given
  // every key the hub holds a standard variable name for.
  credentials: {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    xai: 'XAI_API_KEY',
  },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp'],
  sections: ['mcp', 'settings'],
};
