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
      /**
       * **Pinned.** The version the owner tested: a fresh install takes exactly this, never
       * `latest`. An update may later take a newer exact version the registry names
       * (`update-policy.ts`), and the pin stays the tested baseline the UI compares against.
       */
      version: string;
      /**
       * Other packages installed into the same prefix, each pinned the same way — for an
       * agent whose ACP side is a separate adapter that drives the CLI (Pi: `pi-acp` drives
       * `pi`). They share the agent's directory, so removing the agent removes them too.
       */
      companions?: readonly { package: string; version: string }[];
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
      /**
       * Another executable in the agent's own `bin` directory to run instead of `binary` —
       * for an entry whose protocol binary prints no version (Pi's `pi-acp` adapter), so
       * the check asks the CLI it drives.
       */
      binary?: string;
    }
  | {
      /** GET this path on the agent's endpoint and expect a 2xx. */
      kind: 'http';
      path: string;
    };

export interface CatalogEntry {
  /** Stable identifier; also the agent's `slug` in the contract and its directory name. */
  id: string;
  /** English display name; also the name stored on a fresh registry row. */
  name: string;
  /**
   * Arabic display name, for an entry whose name is a word rather than a brand.
   *
   * "Hermes" and "Codex" are names and stay as they are in both languages; "Direct" is
   * an ordinary adjective and an Arabic reader should read «مباشر». Absent means the
   * name is the same in both, which is true of every third-party agent here.
   */
  nameAr?: string;
  vendor: string | null;
  /** SPDX identifier of the agent's own licence, recorded when the owner approved it. */
  licence: string;
  /**
   * Which adapter drives it (ADR 0002). `builtin` is the hub itself: no process, no
   * gateway, no binary — the entry exists so the hub's own agent is listed, installed
   * and chosen through exactly the same registry as every other one.
   */
  adapter: 'hermes' | 'acp' | 'harness' | 'builtin';
  /** Executable to look for, inside the agent's own `bin` directory or on PATH. Empty for `builtin`. */
  binary: string;
  /** Arguments that make the CLI speak its protocol on stdio. Empty for `builtin`. */
  protocolArgs: string[];
  /** Arguments that print a version. */
  versionArgs: string[];
  install: InstallRecipe;
  health: HealthCheck;
  /**
   * Credential family (`models` module's `CredentialFamily`) -> the environment variable
   * **this** agent reads that key from.
   *
   * This is the whole of the per-agent credential work, and we do it, once, here — the
   * owner adds a provider key in the Models screen and never opens an agent's settings
   * for it (ADR 0010). An entry that declares nothing inherits nothing: a CLI is not
   * handed every key in the workspace because it happens to be installed.
   */
  credentials: Record<string, string>;
  /** Hermes only: the gateway the adapter talks to. */
  defaultEndpoint?: string;
  capabilities: AgentCapability[];
  sections: AgentSection[];
}

/** The pinned version an entry should be at, or null when the hub does not install it. */
export function pinnedVersion(entry: CatalogEntry): string | null {
  return entry.install.kind === 'npm' ? entry.install.version : null;
}

/** Every package an entry installs, the agent's own first, each at its pin. */
export function pinnedPackages(entry: CatalogEntry): { package: string; version: string }[] {
  if (entry.install.kind !== 'npm') return [];
  return [
    { package: entry.install.package, version: entry.install.version },
    ...(entry.install.companions ?? []).map((companion) => ({ ...companion })),
  ];
}

/** True when the hub is allowed to install and remove this entry. */
export function isManaged(entry: CatalogEntry): boolean {
  return entry.install.kind === 'npm';
}
