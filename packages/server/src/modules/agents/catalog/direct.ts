// The direct agent — the hub talking to the model provider with nothing in between
// (ADOPTION-BACKLOG §2.15, owner's decision of 2026-09-22).
//
// It is `bundled` for the same reason Hermes is: it ships as part of the hub, so there
// is nothing to install and nothing to remove, and `lifecycleJob` refuses both. Unlike
// Hermes it is not even a binary — the "runtime" is the hub's own process — which is why
// `binary` and `protocolArgs` are empty and the adapter is `builtin`.
//
// ADR 0006 says Hermes is the base and other agents are installed on demand. This entry
// does not weaken that: it adds no second runtime, ships no second process, and adds
// nothing to the image. It is the hub answering for itself.
import type { CatalogEntry } from './types.js';

export const direct: CatalogEntry = {
  id: 'direct',
  name: 'Direct',
  nameAr: 'مباشر',
  // Not a third party: this is the hub's own code, under the repository's own terms
  // (`LICENSE` — proprietary until the owner chooses one). `LicenseRef-CoreHub` is the
  // SPDX way of saying "a licence that is not on the SPDX list", which is the honest
  // answer while that decision is open.
  vendor: null,
  licence: 'LicenseRef-CoreHub',
  adapter: 'builtin',
  binary: '',
  protocolArgs: [],
  versionArgs: [],
  install: { kind: 'bundled' },
  // Nothing to health-check over HTTP or on a command line; `probe()` answers from the
  // adapter itself, which is the only thing that could be broken here.
  health: { kind: 'command', args: [] },
  // No environment variable: this agent never starts a process, so there is nothing to
  // put a key into. It reads the workspace's providers through the `models` port at the
  // moment of each turn (ADR 0010).
  credentials: {},
  // No `tools`, no `approvals`, no `mcp`, no `skills`: skills and MCP over the direct
  // path are backlog §2.16 and belong to a later branch. `vision` is the floor — whether
  // a given model accepts an image is that model row's own capability, checked per turn.
  capabilities: ['streaming', 'vision', 'resume'],
  sections: ['settings'],
  // The hub's own agent does not delegate.
  subagents: 'none',
};
