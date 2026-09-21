// Gemini CLI over ACP (`--experimental-acp`).
import type { CatalogEntry } from './types.js';

export const geminiCli: CatalogEntry = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  vendor: 'Google',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'gemini',
  protocolArgs: ['--experimental-acp'],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: '@google/gemini-cli', version: '0.14.0' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume'],
  sections: ['mcp', 'settings'],
};
