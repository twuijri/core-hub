/**
 * The shape of one curated catalog entry (ADR 0006).
 *
 * A person can install or remove **catalog entries only** — never an arbitrary agent, and
 * never an agent named by URL. Approving an agent is a pull request against this
 * directory, reviewed by the owner, which is what makes "the hub installs software on
 * your box" a decision someone took rather than a text field.
 *
 * Each entry therefore carries everything the hub needs to do that safely:
 * an id, how to install it, exactly which version, how to tell whether the result works,
 * and under which licence it ships.
 */
import type { AgentCapability, AgentSection } from '../schema.js';

/** How the hub obtains the agent. */
export type InstallRecipe =
  | {
      kind: 'npm';
      /** npm package name; installed into `${DATA_DIR}/agents/<id>` with `--prefix`. */
      package: string;
      /** **Pinned.** The hub installs this exact version, never `latest`. */
      version: string;
    }
  | {
      /** Shipped inside the image (Hermes). The hub never installs or removes it. */
      kind: 'bundled';
    };

/** How the hub decides whether an installed agent actually works. */
export type HealthCheck =
  | {
      /** Run the binary with these arguments and expect exit 0. */
      kind: 'command';
      args: string[];
    }
  | {
      /** GET this path on the agent's endpoint and expect a 2xx. */
      kind: 'http';
      path: string;
    };

export interface CatalogEntry {
  /** Stable identifier; also the agent's `slug` in the contract and its directory name. */
  id: string;
  name: string;
  vendor: string | null;
  /** SPDX identifier of the agent's own licence, recorded when the owner approved it. */
  licence: string;
  /** Which adapter drives it (ADR 0002). */
  adapter: 'hermes' | 'acp' | 'harness';
  /** Executable to look for, inside the agent's own `bin` directory or on PATH. */
  binary: string;
  /** Arguments that make the CLI speak its protocol on stdio. */
  protocolArgs: string[];
  /** Arguments that print a version. */
  versionArgs: string[];
  install: InstallRecipe;
  health: HealthCheck;
  /** Hermes only: the gateway the adapter talks to. */
  defaultEndpoint?: string;
  capabilities: AgentCapability[];
  sections: AgentSection[];
}

/** The pinned version an entry should be at, or null when the hub does not install it. */
export function pinnedVersion(entry: CatalogEntry): string | null {
  return entry.install.kind === 'npm' ? entry.install.version : null;
}

/** True when the hub is allowed to install and remove this entry. */
export function isManaged(entry: CatalogEntry): boolean {
  return entry.install.kind === 'npm';
}
