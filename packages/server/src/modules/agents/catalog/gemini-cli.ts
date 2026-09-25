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
  install: { kind: 'npm', package: '@google/gemini-cli', version: '0.60.0' },
  // The Gemini CLI wants `GEMINI_API_KEY`; Hermes prefers `GOOGLE_API_KEY` for the same
  // account, which is exactly the rename this one line exists for.
  credentials: { google: 'GEMINI_API_KEY' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume'],
  sections: ['mcp', 'settings'],
  // A Gemini subagent arrives as an ordinary tool call of kind `think`, with nothing that
  // tells it from any other (§49).
  subagents: 'none',
};
