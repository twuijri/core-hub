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
  install: { kind: 'npm', package: 'opencode-ai', version: '0.15.9' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp'],
  sections: ['mcp', 'settings'],
};
