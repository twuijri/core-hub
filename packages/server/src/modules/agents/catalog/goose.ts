// Goose, the open-source agent from Block (now under the Agentic AI Foundation,
// github.com/aaif-goose/goose), over ACP (`goose acp`).
//
// Goose ships as a Rust binary, not an npm package, so it is installed by a pinned download:
// the release's own `.tar.gz` for each platform, refused unless its SHA-256 matches. The
// hashes are the ones GitHub publishes for the v1.52.0 assets, and each was checked against
// a fresh download on 2026-09-26. Windows is published only as a `.zip` and is not offered.
//
// Verified 2026-09-26: 1.52.0 answers ACP `initialize` with loadSession, images, MCP over
// HTTP and session list/close. A session starts only once `GOOSE_PROVIDER` and `GOOSE_MODEL`
// are set — in its `config.yaml`, which the agent's Config files page edits
// (`../config-files.ts`) — and it reads the provider's key from the standard variable.
import type { CatalogEntry } from './types.js';

const release = 'https://github.com/aaif-goose/goose/releases/download/v1.52.0';

export const goose: CatalogEntry = {
  id: 'goose',
  name: 'Goose',
  vendor: 'Block',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'goose',
  protocolArgs: ['acp'],
  versionArgs: ['--version'],
  install: {
    kind: 'download',
    version: '1.52.0',
    assets: {
      'linux-x64': {
        url: `${release}/goose-x86_64-unknown-linux-gnu.tar.gz`,
        sha256: '4aee1f770b405c44194c0e9407df1fb06bda4c50eee935f0d8fd10731821cc5e',
        format: 'tar.gz',
        extract: 'goose',
      },
      'linux-arm64': {
        url: `${release}/goose-aarch64-unknown-linux-gnu.tar.gz`,
        sha256: 'ae602c4f6e9a785bf087da52c89908d4dc6aa605dcc17bf83293873f626d9c85',
        format: 'tar.gz',
        extract: 'goose',
      },
      'darwin-x64': {
        url: `${release}/goose-x86_64-apple-darwin.tar.gz`,
        sha256: '9fb8f60f36b2b2545f5e163a68c54b83c62e5c8baae4914d7aea377623a44cf9',
        format: 'tar.gz',
        extract: 'goose',
      },
      'darwin-arm64': {
        url: `${release}/goose-aarch64-apple-darwin.tar.gz`,
        sha256: '7674b0124aab685c71f8782fb7e65bac100c736ce3de0c9d3bf46ba07910e412',
        format: 'tar.gz',
        extract: 'goose',
      },
    },
  },
  // Goose reads each provider's key from its standard variable once `GOOSE_PROVIDER` names
  // that provider (every name below is in the 1.52.0 binary).
  credentials: {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    google: 'GOOGLE_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    xai: 'XAI_API_KEY',
  },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume', 'config_files'],
  sections: ['mcp', 'settings'],
  // Not verified that its ACP stream marks a delegation, so none is claimed (§56).
  subagents: 'none',
};
