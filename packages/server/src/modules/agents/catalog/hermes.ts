// Hermes Agent — the base runtime (ADR 0006). It ships inside the image, so the hub never
// installs or removes it; the entry exists so the registry, the adapters and the clients
// all read Hermes from the same place as every other agent.
import type { CatalogEntry } from './types.js';

export const hermes: CatalogEntry = {
  id: 'hermes',
  name: 'Hermes',
  vendor: 'Nous Research',
  licence: 'MIT',
  adapter: 'hermes',
  binary: 'hermes',
  protocolArgs: ['acp'],
  versionArgs: ['--version'],
  install: { kind: 'bundled' },
  // Hermes's API server documents `GET /health` (docs/inspirations/hermes-agent.md §1).
  // Hermes does not take its keys from the process environment the hub spawns it with:
  // it reads its own `${HERMES_HOME}/.env`, which the hub writes (ADR 0010
  // §Propagation, `modules/models/propagation.ts`). Declaring none here keeps the two
  // paths from disagreeing.
  credentials: {},
  health: { kind: 'http', path: '/health' },
  defaultEndpoint: 'http://127.0.0.1:8642',
  capabilities: [
    'streaming',
    'tools',
    'approvals',
    'mcp',
    'skills',
    'memory',
    'channels',
    'resume',
    'jobs',
    'tasks',
  ],
  sections: [
    'jobs',
    'tasks',
    'channels',
    'skills',
    'plugins',
    'mcp',
    'memory',
    'journey',
    'settings',
  ],
};
