/**
 * Installing a catalog agent on the hub host.
 *
 * ADR 0006: **the image ships the hub and the Hermes runtime only.** Every other agent is
 * installed on demand into the data volume, one directory per agent —
 * `<DATA_DIR>/agents/<id>` — so:
 *
 * - the image stays small and the person decides what lives on their box;
 * - an install survives a container restart, `docker pull` and an image rebuild, because
 *   the data directory is the volume they keep;
 * - removing an agent is removing its directory: no shared `node_modules` to untangle and
 *   no way for two agents to fight over a transitive dependency;
 * - the hub can reconcile the table against the volume on start, because the volume is
 *   the truth about what is actually installed (`reconcile()` in `service.ts`).
 *
 * The version comes from the catalog entry's pin, never from `latest`: what gets installed
 * is what the owner reviewed. Every command is an argv array (AGENTS.md hard rules), and a
 * failure is thrown carrying npm's own message so the job ends `job.failed` — never a
 * success with an empty result.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runCommand, whichSync, type HostEnvironment } from './adapters/host.js';
import { isManaged, pinnedPackages, pinnedVersion, type CatalogEntry } from './catalog/index.js';
import { agentUnavailable, HubError } from '../../lib/errors.js';
import { isStableVersion } from './update-policy.js';

export interface InstallOutcome {
  version: string | null;
  executablePath: string | null;
}

export interface InstallProgress {
  (percent: number | null, message: string): Promise<void>;
}

export interface HealthResult {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface AgentInstaller {
  /** `<DATA_DIR>/agents`, the parent of every installed agent. */
  readonly root: string;
  /** Where one agent's binaries land. */
  binDirFor(id: string): string;
  /** True when `<DATA_DIR>/agents/<id>` holds the entry's binary. */
  isPresent(entry: CatalogEntry): boolean;
  /**
   * Installs the entry's packages at their catalog pins, or at the exact versions
   * `versions` names per package (an update past the tested pin, `update-policy.ts`).
   */
  install(
    entry: CatalogEntry,
    report: InstallProgress,
    versions?: Readonly<Record<string, string>>,
  ): Promise<InstallOutcome>;
  uninstall(entry: CatalogEntry, report: InstallProgress): Promise<void>;
  /** Runs the entry's health check against what is on disk. */
  health(entry: CatalogEntry): Promise<HealthResult>;
}

export interface NpmInstallerOptions {
  dataDir: string;
  host: HostEnvironment;
  /** Milliseconds; an npm install of a large CLI is slow on a small box. */
  timeoutMs?: number;
}

/** `<DATA_DIR>/agents` — the parent of every installed agent (ADR 0006). */
export function agentsRoot(dataDir: string): string {
  return path.join(dataDir, 'agents');
}

/** `<DATA_DIR>/agents/<id>` — one agent's own prefix. */
export function agentPrefix(dataDir: string, id: string): string {
  return path.join(agentsRoot(dataDir), id);
}

export function agentBinDir(dataDir: string, id: string): string {
  return path.join(agentPrefix(dataDir, id), 'bin');
}

/**
 * Every `bin` directory under `<DATA_DIR>/agents`, for the PATH the adapters search. Read
 * from disk rather than from the catalog so a directory left behind by an entry the
 * catalog no longer carries still resolves, and so reconciliation sees reality.
 */
export function managedBinDirs(dataDir: string): string[] {
  const root = agentsRoot(dataDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'bin'))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

export function createNpmInstaller(options: NpmInstallerOptions): AgentInstaller {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  const npm = (): string => {
    const found = whichSync('npm', options.host);
    if (!found) {
      throw new HubError('service_unavailable', {
        message: 'npm is not on this host, so the hub cannot install an agent',
        details: { tool: 'npm' },
      });
    }
    return found;
  };

  const requireManaged = (entry: CatalogEntry): { package: string; version: string } => {
    if (entry.install.kind !== 'npm') {
      throw agentUnavailable({
        agent: entry.id,
        reason: 'this agent ships inside the image; the hub does not install or remove it',
      });
    }
    return { package: entry.install.package, version: entry.install.version };
  };

  const binaryIn = (entry: CatalogEntry, binary: string = entry.binary): string | null =>
    whichSync(binary, {
      pathValue: agentBinDir(options.dataDir, entry.id),
      ...(options.host.pathExt !== undefined ? { pathExt: options.host.pathExt } : {}),
    });

  return {
    root: agentsRoot(options.dataDir),

    binDirFor(id) {
      return agentBinDir(options.dataDir, id);
    },

    isPresent(entry) {
      return isManaged(entry) && binaryIn(entry) !== null;
    },

    async install(entry, report, versions) {
      const recipe = requireManaged(entry);
      // Always an exact version per package — the pin, or the exact one an update names.
      // Anything else (a tag, a range, a path) is refused before npm is even looked for.
      for (const [name, version] of Object.entries(versions ?? {})) {
        if (!isStableVersion(version)) {
          throw new HubError('internal', {
            message: `refusing to install ${name}@${version}: not an exact released version`,
          });
        }
      }
      const npmPath = npm();
      const prefix = agentPrefix(options.dataDir, entry.id);
      const specs = pinnedPackages(entry).map(
        (pin) => `${pin.package}@${versions?.[pin.package] ?? pin.version}`,
      );
      await report(10, `installing ${specs.join(' ')} into ${prefix}`);
      const result = await runCommand(
        [npmPath, 'install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', ...specs],
        { timeoutMs },
      );
      if (!result.ok) {
        throw new HubError('internal', {
          message: (result.stderr || result.error || 'npm install failed').trim().slice(0, 600),
        });
      }
      await report(80, 'running the health check');
      const health = await this.health(entry);
      if (!health.ok) {
        throw new HubError('internal', {
          message: health.error ?? `${entry.name} was installed but its health check failed`,
        });
      }
      return {
        version: health.version ?? versions?.[recipe.package] ?? recipe.version,
        executablePath: binaryIn(entry),
      };
    },

    async uninstall(entry, report) {
      requireManaged(entry);
      const prefix = agentPrefix(options.dataDir, entry.id);
      await report(20, `removing ${prefix}`);
      // One agent, one directory: removing it is the whole uninstall, and it cannot take
      // another agent's files with it.
      try {
        rmSync(prefix, { recursive: true, force: true });
      } catch (error) {
        throw new HubError('internal', {
          message: error instanceof Error ? error.message : 'could not remove the agent directory',
        });
      }
    },

    async health(entry) {
      if (entry.health.kind !== 'command') {
        // An `http` check belongs to the adapter that owns the endpoint (Hermes).
        return { ok: false, version: null, error: 'this entry is checked by its adapter' };
      }
      // The protocol binary must be there to be driven at all; the check itself may ask
      // the CLI it drives (`HealthCheck.binary`).
      if (!binaryIn(entry)) {
        return { ok: false, version: null, error: `${entry.binary} is not in the agent directory` };
      }
      const checked = entry.health.binary ?? entry.binary;
      const executablePath = binaryIn(entry, checked);
      if (!executablePath) {
        return { ok: false, version: null, error: `${checked} is not in the agent directory` };
      }
      const result = await runCommand([executablePath, ...entry.health.args], {
        timeoutMs: 30_000,
      });
      return {
        ok: result.ok,
        version: versionFrom(`${result.stdout}${result.stderr}`),
        error: result.ok ? null : (result.stderr || result.error || 'health check failed').trim(),
      };
    },
  };
}

/** Kept local so the installer does not depend on the adapters' parsing helper. */
function versionFrom(output: string): string | null {
  const match = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1] ?? null;
}

export { pinnedVersion };
