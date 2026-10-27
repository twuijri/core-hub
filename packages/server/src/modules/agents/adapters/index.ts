// The adapter set the hub ships with (ADR 0002). The rest of the server asks this
// registry for an adapter by kind and then sees only `AgentAdapter`.
import { createAcpAdapter, type AcpAdapterOptions } from './acp.js';
import { createDirectAdapter, type DirectAdapterOptions } from './direct.js';
import { createHermesAdapter, type HermesAdapterOptions } from './hermes.js';
import { HermesHelperSession, type HermesHelperOptions } from './hermes-helper.js';
import { createProcessAdapter } from './process.js';
import type { HostEnvironment } from './host.js';
import type { AdapterKind, AgentAdapter } from './types.js';

export * from './types.js';
export { createAcpAdapter, AcpSession, childProcessTransport } from './acp.js';
export { createHermesAdapter } from './hermes.js';
export { createProcessAdapter } from './process.js';
export {
  AttachmentRefused,
  DirectSession,
  DIRECT_ADAPTER_VERSION,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_TEXT_BYTES,
  MAX_TEXT_TOTAL_BYTES,
  buildPrompt,
  createDirectAdapter,
} from './direct.js';
export type { DirectAdapterOptions, DirectModelsPort } from './direct.js';
export { HermesHelperSession, redactSecrets, readChatStream } from './hermes-helper.js';
export type { HermesHelperHost, HermesHelperOptions, HelperUser } from './hermes-helper.js';

/** The catalog id of the Hermes helper, the second agent the `builtin` adapter runs (ADR 0031). */
export const HERMES_HELPER_SLUG = 'hermes-helper';

export interface AdapterSetOptions {
  /** Shared by every adapter: where to look for binaries, what a child inherits. */
  host: HostEnvironment;
  hermes?: Omit<HermesAdapterOptions, 'host'>;
  acp?: Omit<AcpAdapterOptions, 'host'>;
  /**
   * The hub's own agent (ADOPTION-BACKLOG §2.15). Without a `models` port there is
   * nothing for it to talk to, so the default returns `null` and every turn is refused
   * out loud — never sent somewhere invented.
   */
  direct?: Partial<DirectAdapterOptions>;
  /**
   * The Hermes helper (ADR 0031): what it may ask of the hub about Hermes. Without a host every
   * conversation with it is refused out loud.
   */
  hermesHelper?: Partial<HermesHelperOptions>;
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
    // `builtin` — the contract reserved the kind for "the hub's own lightweight agent"
    // from the start; this is it (ADOPTION-BACKLOG §2.15).
    builtin: withHermesHelper(
      createDirectAdapter({
        models: options.direct?.models ?? (() => null),
        ...(options.direct?.readFile ? { readFile: options.direct.readFile } : {}),
      }),
      {
        host: options.hermesHelper?.host ?? (() => null),
        models: options.hermesHelper?.models ?? options.direct?.models ?? (() => null),
        ...(options.hermesHelper?.fetch ? { fetch: options.hermesHelper.fetch } : {}),
        ...(options.hermesHelper?.run ? { run: options.hermesHelper.run } : {}),
        ...(options.hermesHelper?.questionWaitMs !== undefined
          ? { questionWaitMs: options.hermesHelper.questionWaitMs }
          : {}),
      },
    ),
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

/**
 * The `builtin` kind runs two agents of the hub's own: `direct`, and the Hermes helper, told
 * apart by the catalog id (ADR 0031). One adapter kind, so nothing in the contract or the
 * clients learns a new kind.
 */
function withHermesHelper(direct: AgentAdapter, helper: HermesHelperOptions): AgentAdapter {
  return {
    ...direct,
    probe(target) {
      if (target.slug !== HERMES_HELPER_SLUG) return direct.probe(target);
      return direct.probe(target).then((probe) => ({
        ...probe,
        capabilities: ['streaming', 'tools', 'approvals', 'resume'],
      }));
    },
    settings(target, stored) {
      return target.slug === HERMES_HELPER_SLUG ? [] : direct.settings(target, stored);
    },
    start(target) {
      if (target.slug !== HERMES_HELPER_SLUG) return direct.start(target);
      return Promise.resolve(new HermesHelperSession(target, helper));
    },
  };
}
