// The Hermes helper — a small agent of the hub's own that looks into Hermes when it is in
// trouble and, when the person allows it, fixes it (owner's decision of 2026-10-28, ADR 0031).
//
// Like `direct` it is the hub's own code: `bundled`, no binary, no process, nothing added to
// the image. It runs on the hub's models through the model gateway (ADR 0029, OpenAI Chat
// Completions with tools), never through Hermes — the agent it diagnoses may be the one that
// is down. A hub whose gateway is not available still answers, without tools, from a snapshot
// of Hermes the hub takes itself (`adapters/hermes-helper.ts`).
import type { CatalogEntry } from './types.js';

export const hermesHelper: CatalogEntry = {
  id: 'hermes-helper',
  name: 'Hermes helper',
  nameAr: 'مساعد Hermes',
  vendor: null,
  licence: 'LicenseRef-CoreHub',
  adapter: 'builtin',
  binary: '',
  protocolArgs: [],
  versionArgs: [],
  install: { kind: 'bundled' },
  health: { kind: 'command', args: [] },
  credentials: {},
  gateway: {
    wire: 'openai-chat',
    // Its tools and instructions are a few thousand tokens; a log read adds more.
    minContext: 16_000,
    env: (gw) => ({
      COREHUB_GATEWAY_URL: gw.openaiBaseUrl,
      COREHUB_GATEWAY_TOKEN: gw.token,
      COREHUB_GATEWAY_MODEL: gw.mainModel,
    }),
    clears: [],
  },
  // Its own tools, each change behind an approval (ADR 0031 §3). No MCP, no skills.
  capabilities: ['streaming', 'tools', 'approvals', 'resume'],
  sections: [],
  subagents: 'none',
};
