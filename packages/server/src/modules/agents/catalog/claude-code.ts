// Claude Code over ACP. The ACP bridge is a separate package from the CLI itself; it is
// what speaks the protocol the hub drives (ADR 0002).
import type { CatalogEntry } from './types.js';

export const claudeCode: CatalogEntry = {
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'claude-code-acp',
  protocolArgs: [],
  versionArgs: ['--version'],
  install: { kind: 'npm', package: '@zed-industries/claude-code-acp', version: '0.16.2' },
  // Claude Code reads the Anthropic key from the standard variable.
  credentials: { anthropic: 'ANTHROPIC_API_KEY' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'skills', 'worktrees', 'resume'],
  sections: ['skills', 'mcp', 'settings'],
  // The bridge names a `Task` delegation and its end; the subagent's own tools arrive flat,
  // without a parent id, and it offers no stop or steer of one subagent (§56).
  subagents: 'observe',
};
