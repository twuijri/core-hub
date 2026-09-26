// Grok Build, xAI's coding agent (`grok`, source at github.com/xai-org/grok-build, Apache-2.0),
// over ACP (`grok agent stdio`).
//
// xAI publishes the binary on its own download host (`https://x.ai/cli/`, the one its
// install script uses), not on GitHub releases, and publishes no checksum file. The hashes
// below are of the pinned 1.0.41 files downloaded on 2026-09-26, each cross-checked against
// the MD5 the storage behind that host reports for the same object. The gzipped variant is
// used (the script's own fallback when `zstd` is missing): a third of the size. Windows is
// published only as a bare `.exe` and is not offered.
//
// Verified 2026-09-26: `grok agent --no-leader stdio` answers ACP `initialize` with
// loadSession, MCP over HTTP and SSE, and session list/resume/close. It reads `XAI_API_KEY`;
// without one it runs on the xAI account `grok login --device-auth` signs in to (a SuperGrok
// or X Premium+ subscription), which the hub can start (`signIn`).
import type { CatalogEntry } from './types.js';

const host = 'https://x.ai/cli';

export const grokBuild: CatalogEntry = {
  id: 'grok-build',
  name: 'Grok Build',
  vendor: 'xAI',
  licence: 'Apache-2.0',
  adapter: 'acp',
  binary: 'grok',
  // `--no-leader`: one process per conversation, never a shared background leader that
  // would outlive the session the hub started.
  protocolArgs: ['agent', '--no-leader', 'stdio'],
  versionArgs: ['--version'],
  install: {
    kind: 'download',
    version: '1.0.41',
    assets: {
      'linux-x64': {
        url: `${host}/grok-1.0.41-linux-x86_64.gz`,
        sha256: '994114d7a4bf7a6cf459975d4e92f0c449ae6ccfaf2a35a69203db08f00bcd02',
        format: 'gz',
      },
      'linux-arm64': {
        url: `${host}/grok-1.0.41-linux-aarch64.gz`,
        sha256: 'ddbcd9679841b62e9285bb9c57c76570cc7f9ccbbc2b5070f3d5bd5cad2d5c63',
        format: 'gz',
      },
      'darwin-x64': {
        url: `${host}/grok-1.0.41-macos-x86_64.gz`,
        sha256: '00cbf7af8f4df204668177a8149f4d222024ab98895220972009d55e417139ff',
        format: 'gz',
      },
      'darwin-arm64': {
        url: `${host}/grok-1.0.41-macos-aarch64.gz`,
        sha256: 'd6c9b5d1dfe3be5b01758b24e11acad377ee22aa7426ad5eb65332cf3a363447',
        format: 'gz',
      },
    },
  },
  credentials: { xai: 'XAI_API_KEY' },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume'],
  sections: ['mcp', 'settings'],
  // Not verified that its ACP stream marks a delegation, so none is claimed (§56).
  subagents: 'none',
  signIn: { args: ['login', '--device-auth'] },
};
