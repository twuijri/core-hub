// OpenCode over ACP (`opencode acp`).
import { PROVIDER_HOST_ENV } from './provider-env.js';
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
  install: { kind: 'npm', package: 'opencode-ai', version: '1.18.31' },
  // OpenCode routes through whichever provider it is configured for, so it is given
  // every key the hub holds a standard variable name for.
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
  // OpenCode's own settings and every provider it can use.
  hostEnv: ['OPENCODE_*', ...PROVIDER_HOST_ENV],
  // On the hub's model gateway (ADR 0029): a provider of the hub's own in `OPENCODE_CONFIG_CONTENT`
  // (inline JSON, above every file but managed settings), OpenAI-compatible, keyed by the session
  // token, and models.dev left unasked. Its `opencode.json` is left alone.
  gateway: {
    wire: 'openai-chat',
    minContext: 32_000,
    env: (gw) => {
      const limit = { context: gw.contextWindow ?? 128_000, output: 32_000 };
      return {
        COREHUB_GATEWAY_TOKEN: gw.token,
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            corehub: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Core Hub',
              options: { baseURL: gw.openaiBaseUrl, apiKey: '{env:COREHUB_GATEWAY_TOKEN}' },
              models: {
                [gw.mainModel]: { name: 'Core Hub', tool_call: true, limit },
                [gw.smallModel]: { name: 'Core Hub (small)', tool_call: true, limit },
              },
            },
          },
          model: `corehub/${gw.mainModel}`,
          small_model: `corehub/${gw.smallModel}`,
        }),
      };
    },
    clears: [],
  },
  health: { kind: 'command', args: ['--version'] },
  capabilities: ['streaming', 'tools', 'approvals', 'mcp'],
  sections: ['mcp', 'settings'],
  // `opencode acp` sends its `task` tool (with `subagent_type`) and its end; the subagent
  // works in a session of its own that the stream does not relay (§56).
  subagents: 'observe',
};
