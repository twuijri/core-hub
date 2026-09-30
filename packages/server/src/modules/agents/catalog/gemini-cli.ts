// Gemini CLI over ACP (`--experimental-acp`). The pinned 0.60.0 calls it deprecated in favour of
// `--acp` but still takes it, and so does 0.62; a Gemini CLI the hub found on the computer may be
// older than `--acp`, so the flag every version knows stays until a pin drops it (DECISIONS §141).
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
  // Gemini CLI's own settings and Google's (key, project, Vertex, a gateway's base URL).
  hostEnv: ['GEMINI_*', 'GOOGLE_*', 'NO_BROWSER'],
  // On the hub's model gateway (ADR 0029, DECISIONS §141): Gemini CLI speaks the Gemini API only,
  // and `GOOGLE_GEMINI_BASE_URL` selects its `gateway` sign-in type (0.60.0: https unless the
  // host is loopback; the key goes as `x-goog-api-key`). Its model is the alias; the gateway
  // answers every id it asks for (its router and utility calls name flash-lite models) with the
  // turn's model. A Google or Vertex sign-in in the person's settings would win over the
  // variable; then it runs in a home of the hub's own whose settings say `gateway`
  // (`gateway-config.ts`).
  gateway: {
    wire: 'google',
    minContext: 64_000,
    env: (gw) => ({
      GOOGLE_GEMINI_BASE_URL: gw.googleBaseUrl,
      GEMINI_API_KEY: gw.token,
      GEMINI_MODEL: gw.mainModel,
    }),
    // Other ways in that would win over the gateway, or move it: Vertex, a Google sign-in by
    // variable, a Cloud Shell or compute credential, another API version, a bearer key.
    clears: [
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_GCA',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_VERTEX_BASE_URL',
      'GOOGLE_GENAI_API_VERSION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT_ID',
      'GOOGLE_CLOUD_LOCATION',
      'GEMINI_API_KEY_AUTH_MECHANISM',
      'GEMINI_CLI_USE_COMPUTE_ADC',
      'CLOUD_SHELL',
    ],
    config: 'gemini-settings',
    // The `gateway` sign-in type is recent; an older Gemini CLI found on the computer keeps its
    // own account.
    minVersion: '0.60.0',
  },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp', 'resume', 'config_files'],
  sections: ['mcp', 'settings'],
  // A Gemini subagent arrives as an ordinary tool call of kind `think`, with nothing that
  // tells it from any other (§56).
  subagents: 'none',
};
