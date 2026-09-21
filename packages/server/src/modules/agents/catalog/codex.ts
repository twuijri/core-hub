// OpenAI Codex over ACP, through Zed's `codex-acp` adapter (the Codex CLI itself
// does not expose an ACP transport; the adapter wraps it and speaks ACP on stdio).
import type { CatalogEntry } from './types.js';

export const codex: CatalogEntry = {
  id: 'codex',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'codex-acp',
  protocolArgs: [],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: '@zed-industries/codex-acp', version: '0.16.0' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp'],
  sections: ['mcp', 'settings'],
};
