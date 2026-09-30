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
      /**
       * The package this agent was installed from before, when its vendor renamed it (the ACP
       * bridges, DECISIONS §139), with the program it put in `bin`. An install of it keeps
       * working and reports its own version, so its card offers the update; taking the update
       * installs `package` in a fresh folder and swaps the folders only once the new one works —
       * a failed update leaves the old install as it was.
       */
      legacy?: readonly { package: string; binary: string }[];
    }
  | {
      /**
       * A release the vendor publishes as a file rather than an npm package (a Rust or Go
       * binary): one download per platform, each pinned by its SHA-256. The hub downloads the
       * file for the platform it runs on, refuses it unless the hash matches, unpacks the one
       * executable and puts it in `${DATA_DIR}/agents/<id>/bin`. There is no registry to ask for
       * a newer version: moving the pin is a pull request that changes the version and every
       * hash together, checked against the vendor's release page.
       */
      kind: 'download';
      /** **Pinned.** The release the hashes belong to; every asset URL names it. */
      version: string;
      /** At least one platform; a platform with no asset cannot install the agent. */
      assets: Partial<Record<DownloadPlatform, DownloadAsset>>;
    }
  | {
      /** Shipped inside the image (Hermes). The hub never installs or removes it. */
      kind: 'bundled';
    };

/** `process.platform`-`process.arch`, for the platforms a release is published for. */
export type DownloadPlatform =
  'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64';

export const DOWNLOAD_PLATFORMS: readonly DownloadPlatform[] = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
];

/** One platform's release file. */
export interface DownloadAsset {
  /** `https://` only; the vendor's own release URL, naming the pinned version. */
  url: string;
  /** Lower-case hex SHA-256 of the file at `url`, exactly as downloaded. */
  sha256: string;
  /**
   * How the executable is packed: `raw` is the executable itself, `gz` the executable
   * gzipped, `tar.gz` a gzipped tarball holding it at `extract`.
   */
  format: 'raw' | 'gz' | 'tar.gz';
  /** `tar.gz` only: the executable's path inside the archive (relative, no `..`). */
  extract?: string;
}

/**
 * Signing an installed agent in to its own vendor account by device code, headless: the hub
 * runs `binary ...args`, shows the link and code the CLI prints, and waits for it to exit.
 * The CLI keeps the credential in its own folder under the hub user's home; no token passes
 * through the hub.
 */
export interface AgentSignInRecipe {
  args: string[];
}

/**
 * How the hub decides whether an installed agent actually works, and reads its version.
 *
 * An npm install's version is always its package's `package.json` (what npm installed), never
 * only what a program prints. Many ACP bridges have no `--version` at all: `codex-acp` exits 2
 * ("unexpected argument '--version'"), `claude-code-acp` ignores it and serves ACP on stdin. So
 * a `command` check that runs and says no — any exit code, a deadline — does not make an
 * installed agent an error; only a program that cannot start (missing, not executable, exit
 * 126/127: its interpreter is gone) does.
 */
export type HealthCheck =
  | {
      /**
       * Nothing is run: the protocol binary is in the agent's own `bin` directory and
       * executable, and the version is its npm package's. For a bridge with no version flag.
       */
      kind: 'installed';
    }
  | {
      /** Run the binary with these arguments; a version it prints is read, if any. */
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
  /**
   * The host's variables this agent documents and reads besides its keys — its folders
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), its own settings (`GOOSE_*`) — exact names or a prefix
   * ending in `*`. A spawned agent gets only these, its `credentials` names and a small base
   * (`adapters/child-env.ts`, DECISIONS §139); the hub's own variables never, whatever is named.
   */
  hostEnv?: readonly string[];
  /**
   * How the hub points this agent at its model gateway (ADR 0029), so it runs on any model the
   * hub's providers serve. Absent: the agent is not wired yet and keeps its own account.
   */
  gateway?: GatewayWiring;
  /** Hermes only: the gateway the adapter talks to. */
  defaultEndpoint?: string;
  capabilities: AgentCapability[];
  sections: AgentSection[];
  /**
   * What the agent lets a person do with the subagents it delegates to (contract decision
   * §56), as its protocol actually carries it — checked against the pinned version.
   */
  subagents: 'full' | 'observe' | 'none';
  /** Present when the agent can be signed in to its vendor account from the hub. */
  signIn?: AgentSignInRecipe;
  /**
   * For an agent the hub does not install (Hermes): the oldest version it is known to work
   * with. An older one still runs; the card says so (`AgentInstall.below_minimum`).
   */
  minimumVersion?: string;
  /**
   * For an agent the hub does not install (Hermes): the release the hub is tested with — the one
   * the image carries (`hermes-versions.ts` §HERMES_TESTED). A person's own newer one is said on
   * its card (`AgentInstall.tested_version`, `newer_than_tested`).
   */
  testedVersion?: string;
  /**
   * For an agent the person installed with the vendor's own installer (Hermes): where its
   * releases are listed, so the hub can say a newer one exists (`latest_version`) — its own
   * updater takes it (`AgentInstall.self_update`). A GitHub `owner/repo`.
   */
  releases?: { github: string };
}

/** The pinned version an entry should be at, or null when the hub does not install it. */
export function pinnedVersion(entry: CatalogEntry): string | null {
  return entry.install.kind === 'bundled' ? null : entry.install.version;
}

/** Every package an entry installs, the agent's own first, each at its pin. */
export function pinnedPackages(entry: CatalogEntry): { package: string; version: string }[] {
  if (entry.install.kind !== 'npm') return [];
  return [
    { package: entry.install.package, version: entry.install.version },
    ...(entry.install.companions ?? []).map((companion) => ({ ...companion })),
  ];
}

/** The packages this entry was installed from before a rename; none for most. */
export function legacyPackages(
  entry: CatalogEntry,
): readonly { package: string; binary: string }[] {
  return entry.install.kind === 'npm' ? (entry.install.legacy ?? []) : [];
}

/**
 * Every program name the entry's protocol binary has had: its own first, then the ones a
 * renamed package put in `bin` — so an install from before the rename is still found and run.
 */
export function binaryNames(entry: CatalogEntry): string[] {
  const names = [entry.binary];
  for (const legacy of legacyPackages(entry)) {
    if (!names.includes(legacy.binary)) names.push(legacy.binary);
  }
  return names;
}

/** True when the hub is allowed to install and remove this entry. */
export function isManaged(entry: CatalogEntry): boolean {
  return entry.install.kind === 'npm' || entry.install.kind === 'download';
}

/** The platform key this host's release is published under, or null for any other. */
export function downloadPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): DownloadPlatform | null {
  const key = `${platform}-${arch}`;
  return (DOWNLOAD_PLATFORMS as readonly string[]).includes(key) ? (key as DownloadPlatform) : null;
}

/** What the hub knows when it starts an agent on its model gateway (ADR 0029). */
export interface GatewayContext {
  /** Anthropic Messages (`http://127.0.0.1:<port>/gateway/anthropic`). */
  anthropicBaseUrl: string;
  /** OpenAI Responses and Chat Completions (`…/gateway/openai/v1`). */
  openaiBaseUrl: string;
  /** The Gemini API root (`…/gateway/google`; the client adds `/v1beta/models/…`). */
  googleBaseUrl: string;
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The session token, in place of any key. */
  token: string;
  /** The model the agent names for its main work; the gateway resolves it to the turn's choice. */
  mainModel: string;
  /** The model it names for its small background calls (titles, summaries). */
  smallModel: string;
  /** The chosen model's context window, when the hub knows it. */
  contextWindow: number | null;
}

/**
 * The piece of an agent's own configuration the gateway needs and no variable can say
 * (`gateway-config.ts`, DECISIONS §141): Gemini CLI's settings when it is signed in another way (a
 * home of the hub's own), Grok Build's `[model.corehub-gateway]` table, Pi's `corehub-gateway` provider.
 */
export type GatewayConfigKind = 'gemini-settings' | 'grok-model' | 'pi-models';

export interface GatewayWiring {
  /** The wire the agent speaks to the gateway. */
  wire: 'anthropic' | 'openai-responses' | 'openai-chat' | 'google';
  /** What the agent is started with: the gateway's address, the token, the model alias. */
  env(context: GatewayContext): Record<string, string>;
  /**
   * Variables taken out of the agent's environment on the gateway — another credential route
   * that would win over the token, or point it elsewhere — whoever set them (the host, the
   * agent's own settings, a key the hub would otherwise hand it).
   */
  clears: readonly string[];
  /** A block of its own configuration the hub writes and keeps (`gateway-config.ts`). */
  config?: GatewayConfigKind;
  /**
   * The oldest version the wiring works with; an older one (found on the computer, or not updated)
   * keeps its own account. Absent: any.
   */
  minVersion?: string;
}
