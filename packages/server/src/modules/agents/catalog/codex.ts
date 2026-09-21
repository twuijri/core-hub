// OpenAI Codex CLI over ACP (`codex acp`).
import type { CatalogEntry } from './types.js';

export const codex: CatalogEntry = {
  id: 'codex',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'codex',
  protocolArgs: ['acp'],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: '@openai/codex', version: '0.56.0' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp'],
  sections: ['mcp', 'settings'],
};
