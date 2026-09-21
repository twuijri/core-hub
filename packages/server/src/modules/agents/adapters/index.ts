// The adapter set the hub ships with (ADR 0002). The rest of the server asks this
// registry for an adapter by kind and then sees only `AgentAdapter`.
import { createAcpAdapter, type AcpAdapterOptions } from './acp.js';
import { createHermesAdapter, type HermesAdapterOptions } from './hermes.js';
import { createProcessAdapter } from './process.js';
import type { HostEnvironment } from './host.js';
import type { AdapterKind, AgentAdapter } from './types.js';

export * from './types.js';
export { createAcpAdapter, AcpSession, childProcessTransport } from './acp.js';
export { createHermesAdapter } from './hermes.js';
export { createProcessAdapter } from './process.js';

export interface AdapterSetOptions {
  /** Shared by every adapter: where to look for binaries, what a child inherits. */
  host: HostEnvironment;
  hermes?: Omit<HermesAdapterOptions, 'host'>;
  acp?: Omit<AcpAdapterOptions, 'host'>;
}

export type AdapterSet = Readonly<Record<AdapterKind, AgentAdapter | undefined>> & {
  byKind(kind: AdapterKind): AgentAdapter;
  all(): AgentAdapter[];
};

export function createAdapterSet(options: AdapterSetOptions): AdapterSet {
  const adapters: Partial<Record<AdapterKind, AgentAdapter>> = {
    hermes: createHermesAdapter({ host: options.host, ...options.hermes }),
    acp: createAcpAdapter({ host: options.host, ...options.acp }),
    harness: createProcessAdapter(),
    // `builtin` is reserved in the contract for the hub's own lightweight agent; no such
    // agent exists yet, so no adapter claims the kind.
  };
  return {
    ...adapters,
    byKind(kind) {
      const adapter = adapters[kind];
      if (!adapter) throw new Error(`no adapter registered for kind "${kind}"`);
      return adapter;
    },
    all() {
      return Object.values(adapters).filter((adapter): adapter is AgentAdapter => !!adapter);
    },
  } as AdapterSet;
}
