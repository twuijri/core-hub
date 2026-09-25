// Pi, the minimal coding agent from Earendil (https://pi.dev), over ACP.
//
// Pi does not speak ACP itself: `pi-acp` (MIT, listed in the ACP registry) is the adapter
// that does, and it drives the `pi` CLI it finds on PATH. Both are pinned and installed
// into the one agent directory, and the ACP adapter puts that directory first on the
// child's PATH, so the adapter always drives the Pi installed beside it — never another.
// `pi-acp --version` prints nothing, so the health check asks `pi` instead.
//
// Verified 2026-09-25: `pi-acp` 0.0.34 answers ACP `initialize` (loadSession, images,
// session list); it does not wire MCP servers through to Pi, so the entry claims no `mcp`.
import type { CatalogEntry } from './types.js';

export const pi: CatalogEntry = {
  id: 'pi',
  name: 'Pi',
  vendor: 'Earendil',
  licence: 'MIT',
  adapter: 'acp',
  binary: 'pi-acp',
  protocolArgs: [],
  versionArgs: ['--version'],
  install: {
    kind: 'npm',
    package: '@earendil-works/pi-coding-agent',
    version: '0.87.1',
    companions: [{ package: 'pi-acp', version: '0.0.34' }],
  },
  // Pi reads each provider's key from its standard variable (its `docs/providers.md`).
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
  health: { kind: 'command', args: ['--version'], binary: 'pi' },
  // Pi runs its tools without asking (its design), so no `approvals`.
  capabilities: ['streaming', 'tools', 'resume'],
  sections: ['settings'],
};
