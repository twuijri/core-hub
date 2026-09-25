/**
 * How the hub keeps installed catalog agents current (proposed — owner to confirm; see
 * `docs/contracts/DECISIONS.md` and ADR 0006).
 *
 * - **The pin is the tested baseline.** A fresh install takes exactly the catalog's pin.
 *   The registry is only *asked*: every six hours (and on `check-update`) the hub reads the
 *   newest stable version of each installed agent's package — `npm`'s `latest` dist-tag or
 *   PyPI's JSON — without installing anything, and records it as `latest_version`.
 * - **An update is an exact version.** Taking an update installs the version the registry
 *   named, as `package@x.y.z`, never the moving `latest` tag. The UI marks a version past
 *   the pin «أحدث من النسخة المختبرة» / "newer than the tested version".
 * - **Auto-update is off by default** and per agent (`auto_update`). When it is on, an
 *   update is taken only while the agent is idle — no run in flight — and a run asked for
 *   while the update runs waits for it (`AgentRunner.start`) instead of starting on a CLI
 *   that is being replaced. A busy agent is tried again a little later.
 *
 * Everything here is written against ports, so the tests drive it with a fake registry,
 * a fake clock and a fake runner.
 */
import type { FastifyBaseLogger } from 'fastify';

/** A released version: `1.2.3`, nothing after it. Pre-releases are never offered. */
export function isStableVersion(value: string | null | undefined): value is string {
  return !!value && /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * Compares two dotted versions numerically, part by part (`0.10.0` > `0.9.9`). A version
 * with a pre-release suffix sorts before the same version without one (`1.0.0-rc.1` <
 * `1.0.0`). Anything unreadable compares by its readable prefix; that is enough to decide
 * "newer" for the versions npm and PyPI publish, which is all it is used for.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = '', pre] = value.trim().replace(/^v/, '').split(/-(.*)/s, 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The newer of two versions, either of which may be unknown. */
export function newerOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

export type RegistryKind = 'npm' | 'pypi';

/** Asks a package registry for the newest stable version. Installs nothing. */
export interface PackageRegistry {
  /** The newest stable version, or `null` when the registry names none. Throws when unreachable. */
  latest(kind: RegistryKind, name: string): Promise<string | null>;
}

export interface PackageRegistryOptions {
  fetchImpl?: typeof fetch;
  /** Default `https://registry.npmjs.org`. */
  npmUrl?: string;
  /** Default `https://pypi.org`. */
  pypiUrl?: string;
  timeoutMs?: number;
}

/**
 * The public registries, read the way `npm view <pkg> version` and PyPI's JSON API read
 * them. A pre-release someone tagged `latest` (it happens) is not offered: the hub waits
 * for a release.
 */
export function createPackageRegistry(options: PackageRegistryOptions = {}): PackageRegistry {
  const fetchImpl = options.fetchImpl ?? fetch;
  const npmUrl = (options.npmUrl ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const pypiUrl = (options.pypiUrl ?? 'https://pypi.org').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;

  const getJson = async (url: string): Promise<unknown> => {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  };

  return {
    async latest(kind, name) {
      if (kind === 'npm') {
        // `@scope/name` is one path segment to the registry: the slash is encoded.
        const body = (await getJson(`${npmUrl}/${name.replace('/', '%2f')}/latest`)) as {
          version?: unknown;
        } | null;
        const version = typeof body?.version === 'string' ? body.version : null;
        return isStableVersion(version) ? version : null;
      }
      const body = (await getJson(`${pypiUrl}/pypi/${encodeURIComponent(name)}/json`)) as {
        info?: { version?: unknown };
      } | null;
      const version = typeof body?.info?.version === 'string' ? body.info.version : null;
      return isStableVersion(version) ? version : null;
    },
  };
}

/** One installed agent the checker may ask about, as the service describes it. */
export interface UpdateCandidate {
  agentId: string;
  slug: string;
  registry: RegistryKind;
  package: string;
  /** The catalog's pin — the tested baseline. */
  pinned: string;
  installed: string | null;
  autoUpdate: boolean;
}

/** What the checker needs from the registry service; `AgentsService` implements it. */
export interface UpdatePolicyStore {
  updateCandidates(): UpdateCandidate[];
  /** Records the registry's answer; returns whether an update is now available. */
  recordLatest(agentId: string, latest: string | null): boolean;
  /** Starts the update job for an idle agent; `false` when it could not start. */
  autoUpgrade(agentId: string): boolean;
}

/** What the checker needs from the runner. */
export interface AgentActivity {
  /** Whether any turn of this agent is in flight. */
  busyFor(agentId: string): boolean;
}

export interface UpdateCheckReport {
  checked: string[];
  failed: string[];
  available: string[];
  started: string[];
  /** Auto-update on, update available, but the agent was working: retried later. */
  deferred: string[];
}

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
export const IDLE_RETRY_MS = 10 * 60_000;
export const FIRST_CHECK_DELAY_MS = 2 * 60_000;

export interface UpdateCheckerOptions {
  store: UpdatePolicyStore;
  activity: AgentActivity;
  registry: PackageRegistry;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** Between two registry checks. Default six hours. */
  intervalMs?: number;
  /** Between two tries of a deferred auto-update. Default ten minutes. */
  idleRetryMs?: number;
  /** After boot, before the first check. Default two minutes. */
  firstCheckMs?: number;
}

/**
 * The periodic check and the idle-only auto-update. `start()` arms the timers; every timer
 * is `unref`'d, so a hub with nothing else to do can still exit, and `stop()` clears them.
 */
export class AgentUpdateChecker {
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private running: Promise<UpdateCheckReport> | null = null;
  /** Agents whose auto-update waits for them to go idle. */
  private readonly waiting = new Set<string>();

  constructor(private readonly options: UpdateCheckerOptions) {}

  start(): void {
    this.stop();
    const every = this.options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
    const first = this.options.firstCheckMs ?? FIRST_CHECK_DELAY_MS;
    this.timer = setTimeout(() => this.tick(every), first);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
  }

  private tick(every: number): void {
    void this.checkAll().finally(() => {
      this.timer = setTimeout(() => this.tick(every), every);
      this.timer.unref?.();
    });
  }

  /** One pass: ask the registry about every installed agent, then take due auto-updates. */
  checkAll(): Promise<UpdateCheckReport> {
    // Two passes at once would ask twice and could start the same update twice.
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<UpdateCheckReport> {
    const report: UpdateCheckReport = {
      checked: [],
      failed: [],
      available: [],
      started: [],
      deferred: [],
    };
    for (const candidate of this.options.store.updateCandidates()) {
      let latest: string | null;
      try {
        latest = await this.options.registry.latest(candidate.registry, candidate.package);
      } catch (error) {
        report.failed.push(candidate.slug);
        this.options.log.warn(
          { agent: candidate.slug, err: error },
          'agents: could not ask the registry for a newer version',
        );
        continue;
      }
      report.checked.push(candidate.slug);
      const available = this.options.store.recordLatest(candidate.agentId, latest);
      if (!available) {
        this.waiting.delete(candidate.agentId);
        continue;
      }
      report.available.push(candidate.slug);
      if (candidate.autoUpdate) this.waiting.add(candidate.agentId);
    }
    this.applyWaiting(report);
    if (report.available.length > 0 || report.failed.length > 0) {
      this.options.log.info(report, 'agents: update check');
    }
    return report;
  }

  /**
   * Starts every waiting auto-update whose agent is idle. An agent with a run in flight
   * keeps waiting and is tried again after `idleRetryMs`; nothing is ever updated under a
   * running turn.
   */
  applyWaiting(
    report: UpdateCheckReport = {
      checked: [],
      failed: [],
      available: [],
      started: [],
      deferred: [],
    },
  ): UpdateCheckReport {
    const candidates = new Map(
      this.options.store.updateCandidates().map((candidate) => [candidate.agentId, candidate]),
    );
    for (const agentId of [...this.waiting]) {
      const candidate = candidates.get(agentId);
      // Uninstalled, switched off since, or already updated by hand: nothing to wait for.
      if (!candidate?.autoUpdate) {
        this.waiting.delete(agentId);
        continue;
      }
      if (this.options.activity.busyFor(agentId)) {
        report.deferred.push(candidate.slug);
        continue;
      }
      this.waiting.delete(agentId);
      if (this.options.store.autoUpgrade(agentId)) report.started.push(candidate.slug);
    }
    if (this.waiting.size > 0 && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.applyWaiting();
      }, this.options.idleRetryMs ?? IDLE_RETRY_MS);
      this.retry.unref?.();
    }
    return report;
  }
}
