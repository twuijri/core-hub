/**
 * agents — the curated registry the clients read, the per-workspace settings, and the
 * install lifecycle as jobs.
 *
 * Shape of the module (ADR 0002, ADR 0006):
 * - the **catalog** (`catalog/`) is the list of agents the owner approved; it is seeded
 *   into the `agents` table on boot, so Hermes is always present and every approved
 *   coding agent is listed even when it is not installed (`status: not_installed`, never
 *   hidden). A person can install or remove a catalog entry and nothing else.
 * - on boot the table is **reconciled against the data volume**: an agent whose directory
 *   holds a working binary is `installed`, one whose directory is gone is `not_installed`,
 *   and an `installing` row left by a killed container becomes `failed`. Installs
 *   therefore survive a container restart and an image rebuild.
 * - install, update and uninstall are jobs: HTTP answers `202 { job_id }` immediately and
 *   the work reports `job.progress` and ends in `job.completed` or `job.failed`
 *   (invariant 4). Each also emits `agent.updated` on `/rt/jobs`.
 * - probing the host happens on boot and inside the jobs, never on a read, so
 *   `agents.list` is a database read.
 *
 * Queries are synchronous: the SQLite driver is (`lib/db.ts`).
 */
import {
  credentialState,
  type CredentialProbeOptions,
  type CredentialState,
} from './agent-credentials.js';
import { agentOwnModel } from './agent-own-model.js';
import { GATEWAY_MAIN_MODEL, GATEWAY_SMALL_MODEL } from './gateway-models.js';
import { applyGatewayConfig } from './gateway-config.js';
import { homedir } from 'node:os';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleDb } from '../../lib/db.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import type { Realtime } from '../../lib/realtime.js';
import { HubError, agentUnavailable, conflict, notFound, stateInvalid } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import { t, type Language } from '../../i18n/index.js';
import type { AuditService, JobRow, JobRunner } from '../audit/index.js';
import { decodeAvatarDataUrl, type DecodedAvatar, type WorkspaceScope } from '../auth/index.js';
import type { AgentAvatars } from './avatars.js';
import {
  CATALOG,
  assertCatalogIsWellFormed,
  isManaged,
  pinnedVersion,
  type CatalogEntry,
} from './catalog/index.js';
import type { AdapterSet } from './adapters/index.js';
import type {
  AdapterKind,
  AgentProbe,
  AgentTarget,
  FallbackModel,
  SettingsSection,
} from './adapters/types.js';
import type { AgentInstaller } from './installer.js';
import {
  compareVersions,
  isStableVersion,
  newerOf,
  type PackageRegistry,
  type UpdateCandidate,
  type UpdatePolicyStore,
} from './update-policy.js';
import type { AgentGatewayGrant, AgentModelsPort } from './ports.js';
import { agents, agentSettings, agentAdapters } from './schema.js';
import {
  serializeAgent,
  type AgentRow,
  type AgentSettingsRow,
  type ContractAgent,
  type RuntimeState,
} from './serialize.js';

const NOT_APPLICABLE: RuntimeState = { state: 'not_applicable', url: null, error: null };

/** Reconciling one catalog entry at boot longer than this is logged with its name. */
const SLOW_RECONCILE_MS = 500;

/** How long an installed agent's health check may take when the hub checks it at boot. */
export const BOOT_HEALTH_TIMEOUT_MS = 10_000;

/** An install or update of this process holds the row. */
function busyInstalling(row: { installState: string }): boolean {
  return row.installState === 'installing' || row.installState === 'updating';
}

/** Who asked for an install; only the id and the role matter here. */
export interface Actor {
  userId: string;
}

export interface AgentsServiceOptions {
  db: ModuleDb;
  /** Where uploaded agent pictures live (`avatars.ts`); absent, every agent is drawn. */
  avatars?: AgentAvatars;
  log: FastifyBaseLogger;
  realtime: Realtime;
  audit: AuditService;
  jobs: JobRunner;
  adapters: AdapterSet;
  installer: AgentInstaller;
  /**
   * The shared provider store (ADR 0010). Absent until the `models` module registers it;
   * an agent then starts with its own settings only, never with a wrong key.
   */
  models?: () => AgentModelsPort | null;
  /**
   * The agent runtime's profile for a workspace id (ADR 0014): its slug, `default` for the
   * hub's default workspace, `null` for one the hub does not know (the runtime's default
   * then). Filled from `auth` at composition; absent in a hub composed without it.
   */
  profileOf?: (workspaceId: string) => string | null;
  /**
   * Hermes's messaging gateways, for its card (`AgentRuntime.gateways`). Absent, or empty,
   * where the hub does not run Hermes.
   */
  gateways?: () => NonNullable<RuntimeState['gateways']>;
  catalog?: readonly CatalogEntry[];
  language?: Language;
  now?: () => Date;
  /** How long each installed agent's health check may take at boot (10 s; tests shorten it). */
  bootHealthTimeoutMs?: number;
  /**
   * Where an installed coding agent's own sign-in is looked for (`agent-credentials.ts`): the
   * environment the hub hands its agents and their home. Absent: no card says either way.
   */
  credentialProbe?: CredentialProbeOptions;
  /**
   * Retired (§144): every coding agent goes through the gateway wherever the hub runs. Accepted
   * from an older caller and ignored.
   */
  modelSourceDefault?: () => 'hub' | 'auto';
  /**
   * Where the hub writes files of its own for agents on the model gateway (Gemini CLI's home when
   * it is signed in another way; `gateway-config.ts`): `<DATA_DIR>/gateway/agents`. Absent: an agent that needs one
   * keeps its own account.
   */
  gatewayStateDir?: string;
  /**
   * Where `check-update` and the periodic check ask for a newer version
   * (`update-policy.ts`). Absent: the hub knows only the catalog's pins.
   */
  registry?: PackageRegistry;
  /**
   * The profile a change nobody asked for is announced in and its job filed under — an
   * auto-update. The hub's default workspace; absent or `null`, no auto-update starts.
   */
  systemScope?: () => WorkspaceScope | null;
  /**
   * Hermes's own updater, where the Hermes the hub runs is one the person installed on this
   * computer (the desktop app's local mode): `agents.upgrade` runs it (`AgentInstall.self_update`).
   * Absent, Hermes cannot be updated from the hub (the image carries its own).
   */
  hermesUpdate?: HermesUpdater;
}

export interface HermesUpdater {
  /** Whether the Hermes on this host is the person's own install, updated by itself. */
  available(): boolean;
  /** Runs Hermes's own updater, each line of output to `onLine`; rejects with its last line. */
  run(onLine: (line: string) => void): Promise<void>;
  /** After an update: the Hermes processes the hub runs start again on the new code. */
  restart(): Promise<void>;
}

/** How long a run asked for during an install or update waits for it (`settled`). */
export const HOLD_FOR_UPDATE_MS = 15 * 60_000;

export interface AgentPatchInput {
  name?: string;
  enabled?: boolean;
  auto_update?: boolean;
  default_model?: unknown;
  avatar?: unknown;
}

export interface ReconcileReport {
  installed: string[];
  missing: string[];
  interrupted: string[];
}

/**
 * What one turn runs on. Two names for the provider, deliberately:
 *
 * - `provider` is what the *agent's runtime* calls it (Hermes's slug, or the
 *   `providers:` block the hub wrote for it — ADR 0012);
 * - `providerId` is the hub's own row, which only an adapter that makes the request
 *   itself can use (`adapters/direct.ts`).
 *
 * A runtime that has never heard of the provider gets `provider: null` and still gets
 * the model; the hub's own adapter gets the row and needs no name at all.
 */
export interface AgentSelection {
  model: string | null;
  provider: string | null;
  providerId: string | null;
}

export class AgentsService implements UpdatePolicyStore {
  private readonly catalog: readonly CatalogEntry[];
  /** Install and update jobs in flight, by agent row id, for `settled()`. */
  private readonly lifecycles = new Map<string, Promise<void>>();
  /** Called once an install or update of an agent has ended, whatever its outcome. */
  private readonly settledListeners: ((agentId: string) => void)[] = [];
  private readonly language: Language;
  private readonly now: () => Date;
  /** Runtime probes are process state, not rows: they live for the life of the server. */
  private readonly runtimes = new Map<string, RuntimeState>();

  constructor(private readonly options: AgentsServiceOptions) {
    this.catalog = options.catalog ?? CATALOG;
    this.language = options.language ?? 'en';
    this.now = options.now ?? (() => new Date());
  }

  private get db(): ModuleDb {
    return this.options.db;
  }

  // ------------------------------------------------------------------ boot

  /**
   * Seeds the catalog and reconciles the table against the volume. Once per boot: `seed` while
   * the hub mounts, `reconcileInstalls` once it is ready (it runs the agents' CLIs).
   */
  async bootstrap(ownerId: string): Promise<ReconcileReport> {
    const seeded = this.seed(ownerId);
    const probed = await this.reconcileInstalls();
    return { ...probed, interrupted: seeded.interrupted };
  }

  /**
   * The catalog's rows, written from the catalog, and the installs a restart cut short settled.
   * Database work only — no agent CLI runs and nothing is awaited — so the hub can do it while
   * it mounts, however many agents the volume holds (a slow `--version` once kept the hub
   * from starting at all).
   */
  seed(ownerId: string): ReconcileReport {
    assertCatalogIsWellFormed(this.catalog);
    const report: ReconcileReport = { installed: [], missing: [], interrupted: [] };
    // The harness adapter has no catalog entries yet but must exist as a row so a client
    // can see that the kind is declared (ADR 0002).
    this.adapterRowId('harness', ownerId);
    for (const entry of this.catalog) {
      try {
        const row = this.seedEntry(entry, ownerId);
        if (this.settleInterrupted(entry, row)) report.interrupted.push(entry.id);
      } catch (error) {
        this.options.log.warn(
          { agent: entry.id, err: error },
          'agents: could not seed a catalog entry',
        );
      }
    }
    if (report.interrupted.length > 0) {
      this.options.log.warn(
        { agents: report.interrupted },
        'agents: installs interrupted by a restart',
      );
    }
    return report;
  }

  /**
   * Every catalog agent checked against the volume: a bundled one by its adapter's probe
   * (`hermes --version`, the gateway's `/health`), a managed one by its health check. Each runs
   * a CLI, so this is done once the hub serves, never while it mounts; an agent whose install
   * a person started meanwhile is left to that install.
   */
  async reconcileInstalls(): Promise<ReconcileReport> {
    const report: ReconcileReport = { installed: [], missing: [], interrupted: [] };
    // Side by side: one slow CLI does not hold up the others' checks.
    const outcomes = await Promise.all(
      this.catalog.map(async (entry) => {
        const began = performance.now();
        let outcome: Awaited<ReturnType<AgentsService['reconcile']>> | null = null;
        try {
          const row = this.db.select().from(agents).where(eq(agents.slug, entry.id)).get();
          if (row && !busyInstalling(row)) outcome = await this.reconcile(entry, row);
        } catch (error) {
          this.options.log.warn(
            { agent: entry.id, err: error },
            'agents: could not reconcile a catalog entry',
          );
        }
        // A probe runs the agent's CLI: a slow one is named.
        const ms = Math.round(performance.now() - began);
        if (ms >= SLOW_RECONCILE_MS) {
          this.options.log.warn({ agent: entry.id, ms }, 'agents: reconciling an agent took long');
        }
        return { id: entry.id, outcome };
      }),
    );
    for (const { id, outcome } of outcomes) {
      if (outcome === 'installed') report.installed.push(id);
      if (outcome === 'missing') report.missing.push(id);
    }
    return report;
  }

  // ----------------------------------------------------------------- reads

  list(
    scope: WorkspaceScope,
    filter: { kind?: AdapterKind; language?: Language },
  ): ContractAgent[] {
    return (
      this.db
        .select()
        .from(agents)
        .where(isNull(agents.archivedAt))
        .all()
        .filter((row) => !filter.kind || row.adapterKind === filter.kind)
        // The harness is declared but not selectable (ADR 0002): it has no catalog entry
        // yet, and a row nobody can choose would be noise in every picker.
        .filter((row) => row.selectable)
        .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
        .map((row) => this.present(row, scope, this.settingsRow(scope.id, row.id), filter.language))
    );
  }

  get(scope: WorkspaceScope, id: string, language?: Language): ContractAgent {
    const row = this.loadAgent(id);
    return this.present(row, scope, this.settingsRow(scope.id, row.id), language);
  }

  /** `Profile.agent_count`: agents this workspace can actually pick right now. */
  countEnabled(workspaceId: string): number {
    return this.db
      .select()
      .from(agents)
      .where(and(isNull(agents.archivedAt), eq(agents.installState, 'installed')))
      .all()
      .filter((row) => this.settingsRow(workspaceId, row.id)?.enabled ?? true).length;
  }

  /** Whether a workspace has this agent switched on (`agent_settings.enabled`). */
  isEnabled(workspaceId: string, agentId: string): boolean {
    return this.settingsRow(workspaceId, agentId)?.enabled ?? true;
  }

  settings(scope: WorkspaceScope, id: string): SettingsSection[] {
    const row = this.loadAgent(id);
    const stored = this.settingsRow(scope.id, row.id);
    return this.options.adapters.byKind(row.adapterKind).settings(this.targetOf(row), {
      ...(stored?.settings ?? {}),
      ...(stored?.workingDir ? { working_dir: stored.workingDir } : {}),
      ...(stored ? { approval_mode: stored.approvalMode } : {}),
    });
  }

  // --------------------------------------------------------------- writes

  update(scope: WorkspaceScope, id: string, patch: AgentPatchInput): ContractAgent {
    const row = this.loadAgent(id);
    if (patch.default_model != null) {
      // `models` owns providers and models; none exist, so nothing can be pointed at.
      throw notFound({ resource: 'model' });
    }
    // A picture is checked before anything is written, so a bad one changes nothing.
    const avatar = patch.avatar === undefined ? undefined : this.avatarPatch(patch.avatar);
    const at = this.now();
    const changes: Partial<typeof agents.$inferInsert> = { updatedAt: at };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.auto_update !== undefined) {
      if (patch.auto_update && !row.packageName) {
        throw stateInvalid({
          field: 'auto_update',
          reason: 'this agent ships in the image, so the hub does not update it',
        });
      }
      changes.autoUpdate = patch.auto_update;
    }
    if (avatar !== undefined) {
      const store = this.avatarStore();
      if (avatar) store.write(id, avatar);
      else store.remove(id);
    }
    if (Object.keys(changes).length > 1 || avatar !== undefined) {
      this.db.update(agents).set(changes).where(eq(agents.id, id)).run();
    }
    const settings = this.ensureSettings(scope, id, row.ownerId);
    if (patch.enabled !== undefined) {
      this.db
        .update(agentSettings)
        .set({ enabled: patch.enabled, updatedAt: at })
        .where(eq(agentSettings.id, settings.id))
        .run();
    }
    return this.announce(this.loadAgent(id), scope);
  }

  /**
   * The picture an `agents.update` asks for: an uploaded PNG or JPEG (`auth`'s data-URL rule,
   * 512 KB), or back to the one drawn from the slug (`generated` or `null`). Null = remove.
   */
  private avatarPatch(input: unknown): DecodedAvatar | null {
    if (input === null) return null;
    const avatar = input as { kind?: unknown; data_url?: unknown };
    if (avatar.kind === 'generated') return null;
    if (avatar.kind === 'image' && typeof avatar.data_url === 'string') {
      this.avatarStore();
      return decodeAvatarDataUrl(avatar.data_url);
    }
    throw new HubError('validation_failed', { details: { field: 'avatar', reason: 'invalid' } });
  }

  private avatarStore(): AgentAvatars {
    if (!this.options.avatars) {
      throw stateInvalid({ field: 'avatar', reason: 'this hub stores no agent pictures' });
    }
    return this.options.avatars;
  }

  /** The agent's uploaded picture, or null when it is drawn from its slug. */
  avatar(id: string): { mime: string; bytes: Buffer } | null {
    this.loadAgent(id);
    return this.options.avatars?.read(id) ?? null;
  }

  updateSettings(
    scope: WorkspaceScope,
    id: string,
    input: { section: string; values: Record<string, unknown> },
  ): { section: SettingsSection; restart_job_id: string | null } {
    const row = this.loadAgent(id);
    const sections = this.settings(scope, id);
    const section = sections.find((candidate) => candidate.key === input.section);
    if (
      !section &&
      input.section === 'models' &&
      Object.keys(input.values).every((key) => key === 'model_source')
    ) {
      // The retired model source choice (§144): an app from before it still sends it. Accepted,
      // stored nowhere, changes nothing — every coding agent goes through the hub's gateway.
      return {
        section: {
          key: 'models',
          title: { ar: 'النماذج', en: 'Models' },
          restart_required: false,
          fields: [],
        },
        restart_job_id: null,
      };
    }
    if (!section) throw notFound({ resource: 'settings_section', id: input.section });
    const allowed = new Set(section.fields.map((field) => field.key));
    const unknown = Object.keys(input.values).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw stateInvalid({ unknown_fields: unknown });

    const stored = this.ensureSettings(scope, id, row.ownerId);
    const at = this.now();
    const changes: Partial<typeof agentSettings.$inferInsert> = {
      settings: { ...stored.settings, ...input.values },
      updatedAt: at,
    };
    if (typeof input.values.working_dir === 'string') changes.workingDir = input.values.working_dir;
    if (typeof input.values.approval_mode === 'string') {
      changes.approvalMode = input.values.approval_mode as 'ask';
    }
    this.db.update(agentSettings).set(changes).where(eq(agentSettings.id, stored.id)).run();

    const updated = this.settings(scope, id).find((s) => s.key === input.section);
    this.announce(this.loadAgent(id), scope);
    return {
      section: updated ?? section,
      // A section marked `restart_required` will return a restart job once the hub owns
      // the Hermes runtime; `agents.restart` is still a documented 501 stub.
      restart_job_id: null,
    };
  }

  /**
   * Which of an agent's skills this person pinned.
   *
   * The skills folder belongs to the agent; the pin is the hub's opinion about it, so it
   * lives in the hub's own settings row and not as a marker file dropped into somebody
   * else's directory — where a pack's next update would quietly remove it.
   *
   * It is read and written here rather than through `updateSettings`, because that path
   * validates against the sections the *adapter* declares, and this is not one of them.
   */
  pinnedSkills(scope: WorkspaceScope, id: string): string[] {
    const row = this.loadAgent(id);
    const stored = this.settingsRow(scope.id, row.id);
    const value = (stored?.settings as { pinnedSkills?: unknown } | undefined)?.pinnedSkills;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  setPinnedSkills(scope: WorkspaceScope, id: string, keys: readonly string[]): string[] {
    const row = this.loadAgent(id);
    const stored = this.ensureSettings(scope, id, row.ownerId);
    const pinnedSkills = [...new Set(keys)];
    this.db
      .update(agentSettings)
      .set({ settings: { ...stored.settings, pinnedSkills }, updatedAt: this.now() })
      .where(eq(agentSettings.id, stored.id))
      .run();
    return pinnedSkills;
  }

  // ------------------------------------------------------------------ jobs

  install(scope: WorkspaceScope, actor: Actor, id: string): JobRow {
    return this.lifecycleJob(scope, actor, id, 'install');
  }

  upgrade(scope: WorkspaceScope, actor: Actor, id: string): JobRow {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    if (row && this.selfUpdates(row)) return this.hermesSelfUpdate(scope, actor, row);
    return this.lifecycleJob(scope, actor, id, 'update');
  }

  /** `AgentInstall.self_update`: Hermes the person installed here, updated by its own updater. */
  private selfUpdates(row: AgentRow): boolean {
    return (
      row.adapterKind === 'hermes' &&
      row.source === 'user_cli' &&
      row.installState === 'installed' &&
      (this.options.hermesUpdate?.available() ?? false)
    );
  }

  /**
   * `hermes update --yes` on the person's own Hermes, asked for from its card (the person
   * confirmed there), then the Hermes the hub runs is restarted on the new code and probed
   * again. A run asked for meanwhile waits for it, as for any update.
   */
  private hermesSelfUpdate(scope: WorkspaceScope, actor: Actor, row: AgentRow): JobRow {
    const updater = this.options.hermesUpdate!;
    if (this.lifecycles.has(row.id)) throw conflict({ reason: 'already_running' });
    let settle: () => void = () => undefined;
    this.lifecycles.set(
      row.id,
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const finish = () => {
      this.lifecycles.delete(row.id);
      settle();
    };
    const started = t('jobs.update_started', this.language);
    const before = row.version;
    return this.options.jobs.start(
      {
        kind: 'agents.update',
        workspace: scope.id,
        ownerId: actor.userId,
        entityKind: 'agent',
        entityId: row.id,
        message: started,
      },
      async (handle) => {
        handle.progress(5, started);
        try {
          await updater.run((line) => handle.progress(50, line));
          handle.progress(80, t('jobs.restart_started', this.language));
          await updater.restart();
          await this.reprobe(row.slug);
        } catch (error) {
          finish();
          this.announce(this.loadAgent(row.id), scope);
          throw error;
        }
        finish();
        const fresh = this.loadAgent(row.id);
        this.announce(fresh, scope);
        this.options.audit.record({
          actorKind: 'user',
          actorId: actor.userId,
          ownerId: actor.userId,
          workspace: scope.id,
          action: 'agents.updated',
          entityKind: 'agent',
          entityId: fresh.id,
          summary: `${fresh.name} update`,
          data: { version: fresh.version, previous_version: before, updater: 'hermes update' },
        });
        handle.progress(100, t('jobs.update_done', this.language));
        return { version: fresh.version };
      },
    );
  }

  uninstall(scope: WorkspaceScope, actor: Actor, id: string): JobRow {
    return this.lifecycleJob(scope, actor, id, 'uninstall');
  }

  checkUpdate(scope: WorkspaceScope, actor: Actor, id: string): JobRow {
    const { row, entry } = this.loadCatalogued(id);
    return this.options.jobs.start(
      {
        kind: 'agents.check_update',
        workspace: scope.id,
        ownerId: actor.userId,
        entityKind: 'agent',
        entityId: row.id,
        message: t('jobs.check_started', this.language),
      },
      async (handle) => {
        handle.progress(30, t('jobs.check_started', this.language));
        // The catalog's pin is the tested baseline and the floor of "latest"; the registry
        // is asked for anything newer, without installing it (`update-policy.ts`).
        const pinned = pinnedVersion(entry);
        const managed = isManaged(entry) && row.source === 'managed';
        const health = managed ? await this.options.installer.health(entry) : null;
        const at = this.now();
        this.db
          .update(agents)
          .set({
            latestVersion: newerOf(pinned, stable(row.latestVersion)),
            version: health?.version ?? row.version,
            lastError: health?.error ?? null,
            updatedAt: at,
          })
          .where(eq(agents.id, row.id))
          .run();
        // Where this agent's releases are listed: npm for one the hub installed, GitHub for a
        // Hermes the person installed and updates with its own updater (§132).
        const source: { kind: 'npm' | 'github'; name: string } | null =
          managed && entry.install.kind === 'npm'
            ? { kind: 'npm', name: entry.install.package }
            : entry.releases && this.selfUpdates(row)
              ? { kind: 'github', name: entry.releases.github }
              : null;
        if (source && this.options.registry) {
          handle.progress(60, t('jobs.check_started', this.language));
          let latest: string | null;
          try {
            latest = await this.options.registry.latest(source.kind, source.name);
          } catch (error) {
            this.announce(this.loadAgent(row.id), scope);
            throw new HubError('service_unavailable', {
              message: `could not ask the registry about ${source.name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              details: { agent_id: row.id, reason: 'registry_unreachable' },
            });
          }
          this.recordLatest(row.id, latest);
        } else {
          this.db.update(agents).set({ checkedAt: at }).where(eq(agents.id, row.id)).run();
        }
        const fresh = this.loadAgent(row.id);
        this.announce(fresh, scope);
        handle.progress(100, t('jobs.check_done', this.language));
        return {
          latest_version: fresh.latestVersion,
          pinned_version: pinned,
          update_available: updateAvailable(fresh),
        };
      },
    );
  }

  /**
   * `agents.restart`: restart the runtime the hub supervises (ADR 0008). Only Hermes has
   * one; a gateway the hub merely found, or no gateway at all, is nothing it can restart.
   */
  restart(
    scope: WorkspaceScope,
    actor: Actor,
    id: string,
    runtime: { managed(): boolean; restart(): Promise<void> },
  ): JobRow {
    const { row, entry } = this.loadCatalogued(id);
    if (entry.adapter !== 'hermes') {
      throw stateInvalid({ agent_id: row.id, reason: 'no runtime process to restart' });
    }
    if (!runtime.managed()) {
      throw stateInvalid({ agent_id: row.id, reason: 'runtime_not_managed' });
    }
    return this.options.jobs.start(
      {
        kind: 'agents.restart',
        workspace: scope.id,
        ownerId: actor.userId,
        entityKind: 'agent',
        entityId: row.id,
        message: t('jobs.restart_started', this.language),
      },
      async (handle) => {
        handle.progress(10, t('jobs.restart_started', this.language));
        await runtime.restart();
        this.announce(this.loadAgent(row.id), scope);
        handle.progress(100, t('jobs.restart_done', this.language));
        return {};
      },
    );
  }

  discover(scope: WorkspaceScope, actor: Actor): JobRow {
    return this.options.jobs.start(
      {
        kind: 'agents.discover',
        workspace: scope.id,
        ownerId: actor.userId,
        message: t('jobs.discover_started', this.language),
      },
      async (handle) => {
        const found: string[] = [];
        const ignored: string[] = [];
        const all = this.options.adapters.all();
        for (const [index, adapter] of all.entries()) {
          if (handle.cancelRequested()) break;
          handle.progress(Math.round(((index + 1) / all.length) * 90), `${adapter.name}: scanning`);
          for (const discovered of await adapter.discover()) {
            const existing = this.db
              .select()
              .from(agents)
              .where(eq(agents.slug, discovered.slug))
              .get();
            if (!existing) {
              // A binary on the host that the owner never approved stays out of the
              // registry (ADR 0006: catalog entries only). It is reported, not stored.
              ignored.push(discovered.slug);
              continue;
            }
            const at = this.now();
            this.db
              .update(agents)
              .set({
                installState: 'installed',
                // A catalog agent found outside the hub's own directory is the person's
                // own CLI, not something the hub installed.
                source: existing.source === 'managed' ? 'managed' : 'user_cli',
                executablePath: discovered.executablePath,
                version: discovered.version,
                detectedAt: at,
                lastError: null,
                updatedAt: at,
              })
              .where(eq(agents.id, existing.id))
              .run();
            this.announce(this.loadAgent(existing.id), scope);
            found.push(discovered.slug);
          }
        }
        handle.progress(100, t('jobs.discover_done', this.language));
        return { found, ignored };
      },
    );
  }

  private lifecycleJob(
    scope: WorkspaceScope,
    actor: Actor,
    id: string,
    kind: 'install' | 'update' | 'uninstall',
    trigger: 'user' | 'auto' = 'user',
  ): JobRow {
    const { row, entry } = this.loadCatalogued(id);
    if (!isManaged(entry)) {
      throw agentUnavailable({
        agent_id: row.id,
        status: row.installState,
        reason: 'this agent ships inside the image; the hub does not install or remove it',
      });
    }
    if (row.installState === 'installing' || row.installState === 'updating') {
      throw conflict({ reason: 'already_running', job_id: row.installJobId });
    }
    if (kind === 'install' && row.installState === 'installed') {
      throw conflict({ reason: 'already_installed' });
    }
    if (kind !== 'install' && row.installState === 'not_installed') {
      throw conflict({ reason: 'not_installed' });
    }

    const busyState = kind === 'update' ? 'updating' : 'installing';
    const started = t(`jobs.${kind}_started`, this.language);
    const done = t(`jobs.${kind}_done`, this.language);

    // The busy state is written before the worker can start, so a fast install cannot be
    // overtaken by its own bookkeeping and leave the row stuck at `installing`.
    this.db
      .update(agents)
      .set({ installState: busyState, updatedAt: this.now() })
      .where(eq(agents.id, row.id))
      .run();
    this.announce(this.loadAgent(row.id), scope);

    // A run asked for while this job works waits for it (`settled`, `AgentRunner.start`).
    let settle: () => void = () => undefined;
    if (kind !== 'uninstall') {
      this.lifecycles.set(
        row.id,
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    }
    const finish = () => {
      if (kind === 'uninstall') return;
      this.lifecycles.delete(row.id);
      settle();
      for (const listener of this.settledListeners) {
        try {
          listener(row.id);
        } catch (error) {
          this.options.log.warn({ err: error, agent: row.slug }, 'agents: settle listener failed');
        }
      }
    };

    const job = this.options.jobs.start(
      {
        kind: `agents.${kind}`,
        workspace: scope.id,
        ownerId: actor.userId,
        entityKind: 'agent',
        entityId: row.id,
        message: started,
      },
      async (handle) => {
        handle.progress(5, started);
        try {
          if (kind === 'uninstall') {
            await this.options.installer.uninstall(entry, async (percent, message) =>
              handle.progress(percent, message),
            );
            const at = this.now();
            this.db
              .update(agents)
              .set({
                installState: 'not_installed',
                source: 'none',
                executablePath: null,
                version: null,
                installJobId: null,
                lastError: null,
                updatedAt: at,
              })
              .where(eq(agents.id, row.id))
              .run();
          } else {
            const versions = kind === 'update' ? await this.updateTarget(row, entry) : undefined;
            const outcome = await this.options.installer.install(
              entry,
              async (percent, message) => handle.progress(percent, message),
              versions,
            );
            const at = this.now();
            this.db
              .update(agents)
              .set({
                installState: 'installed',
                source: 'managed',
                executablePath: outcome.executablePath,
                version: outcome.version,
                // What the registry named is still true after taking it; the pin is the floor.
                latestVersion: newerOf(pinnedVersion(entry), stable(row.latestVersion)),
                installJobId: null,
                lastError: null,
                updatedAt: at,
              })
              .where(eq(agents.id, row.id))
              .run();
          }
        } catch (error) {
          const at = this.now();
          this.db
            .update(agents)
            .set({
              // A failed uninstall leaves the agent installed; a failed install leaves a
              // directory the person can retry into.
              installState: kind === 'uninstall' ? 'installed' : 'failed',
              installJobId: null,
              lastError: error instanceof Error ? error.message : String(error),
              updatedAt: at,
            })
            .where(eq(agents.id, row.id))
            .run();
          this.announce(this.loadAgent(row.id), scope);
          finish();
          throw error;
        }
        const fresh = this.loadAgent(row.id);
        this.announce(fresh, scope);
        finish();
        this.options.audit.record({
          // An auto-update is the hub's own doing, on the owner's standing instruction.
          actorKind: trigger === 'auto' ? 'system' : 'user',
          actorId: actor.userId,
          ownerId: actor.userId,
          workspace: scope.id,
          action: `agents.${kind === 'uninstall' ? 'uninstalled' : kind === 'update' ? 'updated' : 'installed'}`,
          entityKind: 'agent',
          entityId: fresh.id,
          summary: `${fresh.name} ${kind}`,
          data: {
            version: fresh.version,
            pinned_version: pinnedVersion(entry),
            ...(trigger === 'auto' ? { trigger } : {}),
          },
        });
        handle.progress(100, done);
        return { version: fresh.version };
      },
    );

    // Attach the job id only while the row is still busy: the worker may already be done.
    this.db
      .update(agents)
      .set({ installJobId: job.id })
      .where(and(eq(agents.id, row.id), inArray(agents.installState, ['installing', 'updating'])))
      .run();
    return job;
  }

  // --------------------------------------------------------- update policy

  /**
   * Resolves once no install or update of this agent is in flight — at once when none is,
   * and after `timeoutMs` at the latest, so a stuck job cannot hold a run for ever.
   */
  async settled(agentId: string, timeoutMs = HOLD_FOR_UPDATE_MS): Promise<void> {
    const pending = this.lifecycles.get(agentId);
    if (!pending) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Called with the agent's row id each time one of its installs or updates ends. */
  onSettled(listener: (agentId: string) => void): void {
    this.settledListeners.push(listener);
  }

  /**
   * Installed agents the hub itself installed and so can update (`update-policy.ts`), and a
   * Hermes the person installed, which its own updater updates (§119): its releases are looked
   * up on GitHub (§132), never taken on their own (`autoUpdate` is always off for it).
   */
  updateCandidates(): UpdateCandidate[] {
    const candidates: UpdateCandidate[] = [];
    for (const row of this.db.select().from(agents).where(isNull(agents.archivedAt)).all()) {
      const entry = this.catalog.find((candidate) => candidate.id === row.slug);
      if (entry?.releases && this.selfUpdates(row)) {
        candidates.push({
          agentId: row.id,
          slug: row.slug,
          registry: 'github',
          package: entry.releases.github,
          pinned: entry.testedVersion ?? '0.0.0',
          installed: row.version,
          autoUpdate: false,
        });
        continue;
      }
      if (row.installState !== 'installed' || row.source !== 'managed') continue;
      if (!entry || entry.install.kind !== 'npm') continue;
      candidates.push({
        agentId: row.id,
        slug: row.slug,
        registry: 'npm',
        package: entry.install.package,
        pinned: entry.install.version,
        installed: row.version,
        autoUpdate: row.autoUpdate,
      });
    }
    return candidates;
  }

  /**
   * Writes what the registry answered. `latest_version` is the newer of that answer and
   * the pin — the registry going backwards, or answering nothing, never advertises a
   * downgrade. Returns whether the agent now has an update available.
   */
  recordLatest(agentId: string, latest: string | null): boolean {
    const row = this.loadAgent(agentId);
    const entry = this.catalog.find((candidate) => candidate.id === row.slug);
    const pinned = entry ? pinnedVersion(entry) : null;
    const at = this.now();
    this.db
      .update(agents)
      .set({
        latestVersion: newerOf(pinned, stable(latest)),
        checkedAt: at,
        updatedAt: at,
      })
      .where(eq(agents.id, agentId))
      .run();
    const fresh = this.loadAgent(agentId);
    const scope = this.options.systemScope?.();
    if (scope && fresh.latestVersion !== row.latestVersion) this.announce(fresh, scope);
    return updateAvailable(fresh);
  }

  /**
   * Starts the update of an idle agent on the owner's standing `auto_update`. The caller
   * (`AgentUpdateChecker`) has already made sure no run of it is in flight; from here the
   * row is `updating`, so a run asked for now waits instead of starting.
   */
  autoUpgrade(agentId: string): boolean {
    const scope = this.options.systemScope?.();
    if (!scope) return false;
    const row = this.loadAgent(agentId);
    if (!row.autoUpdate || !updateAvailable(row)) return false;
    try {
      this.lifecycleJob(scope, { userId: row.ownerId }, agentId, 'update', 'auto');
      return true;
    } catch (error) {
      this.options.log.warn({ err: error, agent: row.slug }, 'agents: auto-update did not start');
      return false;
    }
  }

  /**
   * The exact versions an update installs: the newest the registry named for the agent's
   * own package, if it is past the pin — otherwise the pin. A companion package (Pi's ACP
   * adapter) follows: at its pin when the agent stays at its pin, at its own newest stable
   * release when the agent moves past it.
   */
  private async updateTarget(
    row: AgentRow,
    entry: CatalogEntry,
  ): Promise<Record<string, string> | undefined> {
    if (entry.install.kind !== 'npm') return undefined;
    const pinned = entry.install.version;
    const latest = stable(row.latestVersion);
    if (!latest || compareVersions(latest, pinned) <= 0) return undefined;
    const versions: Record<string, string> = { [entry.install.package]: latest };
    for (const companion of entry.install.companions ?? []) {
      const registry = this.options.registry;
      // An unreachable registry keeps the companion at its pin rather than failing the update.
      const next = registry
        ? await registry.latest('npm', companion.package).catch(() => null)
        : null;
      versions[companion.package] = newerOf(companion.version, stable(next)) ?? companion.version;
    }
    return versions;
  }

  // --------------------------------------------------------------- helpers

  loadAgent(id: string): AgentRow {
    const row = this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), isNull(agents.archivedAt)))
      .get();
    if (!row) throw notFound({ resource: 'agent', id });
    return row;
  }

  /** The registry row for a catalog id (`hermes`, `claude-code`). Throws a 404. */
  loadAgentBySlug(slug: string): AgentRow {
    const row = this.db.select().from(agents).where(eq(agents.slug, slug)).get();
    if (!row) throw notFound({ resource: 'agent', id: slug });
    return row;
  }

  /** An agent id is only meaningful while it is still a catalog entry (ADR 0006). */
  private loadCatalogued(id: string): { row: AgentRow; entry: CatalogEntry } {
    const row = this.loadAgent(id);
    const entry = this.catalog.find((candidate) => candidate.id === row.slug);
    if (!entry) throw notFound({ resource: 'agent', id });
    return { row, entry };
  }

  private settingsRow(workspaceId: string, agentId: string): AgentSettingsRow | undefined {
    return this.db
      .select()
      .from(agentSettings)
      .where(and(eq(agentSettings.workspace, workspaceId), eq(agentSettings.agentId, agentId)))
      .get();
  }

  /** Settings are created lazily the first time a workspace touches an agent. */
  private ensureSettings(
    scope: WorkspaceScope,
    agentId: string,
    ownerId: string,
  ): AgentSettingsRow {
    const existing = this.settingsRow(scope.id, agentId);
    if (existing) return existing;
    const at = this.now();
    this.db
      .insert(agentSettings)
      .values({
        id: newUlid(),
        ownerId,
        workspace: scope.id,
        agentId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    const created = this.settingsRow(scope.id, agentId);
    if (!created) throw notFound({ resource: 'agent_settings', id: agentId });
    return created;
  }

  private targetOf(row: AgentRow): AgentTarget {
    return {
      slug: row.slug,
      name: row.name,
      command: row.command,
      executablePath: row.executablePath,
      endpoint: row.endpoint,
    };
  }

  /**
   * The target for a conversation: the registry row plus this workspace's settings
   * (working directory, non-secret env) and what the run asks for. Used by the runner.
   */
  targetFor(
    row: AgentRow,
    workspaceId: string,
    run: {
      sessionRef: string | null;
      cwd: string | null;
      model: string | null;
      provider?: string | null;
      reasoningEffort: string | null;
      /** The model gateway's grant, when this process runs on the hub's models (ADR 0029). */
      gateway?: AgentGatewayGrant | null;
    },
  ): AgentTarget {
    const settings = this.settingsRow(workspaceId, row.id);
    const cwd = run.cwd ?? settings?.workingDir ?? null;
    const selection = this.selectionFor(row, workspaceId, run);
    const onGateway = run.gateway
      ? this.gatewayEnvironment(row, workspaceId, settings, selection, run.gateway)
      : null;
    const env = onGateway?.env ?? this.environmentFor(row, workspaceId, settings);
    return {
      ...this.targetOf(row),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(onGateway ? { envRemove: onGateway.remove } : {}),
      ...(onGateway?.sessionConfig ? { sessionConfig: onGateway.sessionConfig } : {}),
      ...(cwd ? { cwd } : {}),
      // The hub's own adapter has no process to hand an environment to: it resolves the
      // workspace's provider at the moment of each turn (`adapters/direct.ts`).
      workspace: workspaceId,
      // Hermes runs the conversation in the workspace's own profile — its config, SOUL,
      // memory, skills and sessions (ADR 0014 stage 3).
      profile: this.options.profileOf?.(workspaceId) ?? null,
      ...(settings ? { settings: settings.settings } : {}),
      sessionRef: run.sessionRef,
      model: selection.model,
      modelProvider: selection.provider,
      modelProviderId: selection.providerId,
      reasoningEffort: run.reasoningEffort,
    };
  }

  /**
   * What one turn should run on: the model id as its provider names it, and the name the
   * agent's runtime knows that provider by.
   *
   * Three things are resolved here that used to be one raw string handed straight to the
   * agent (the defect of 2026-09-22):
   *
   * 1. the composer sends a **catalogue key** (`"<provider slug>/<model>"`), which is not
   *    a model id anything can serve — it is split back into a provider and a model;
   * 2. the run's **provider** is named explicitly, so the agent does not fall back on
   *    whatever its own configuration last said;
   * 3. absent both, the agent's inherited default is used, and its provider too.
   *
   * A model the workspace does not know is passed through untouched rather than dropped:
   * a person who typed a model id the catalogue has not seen still means it.
   */
  selectionFor(
    row: AgentRow,
    workspaceId: string,
    run: { model?: string | null; provider?: string | null },
  ): AgentSelection {
    const port = this.options.models?.() ?? null;
    const asked = run.model?.trim() ?? '';
    if (asked && port) {
      try {
        // A run on the agent's default names the model by its bare id and the provider by its
        // row (`AgentDirectory.defaultProvider`): that row first. The bare id alone is found in
        // whichever provider lists it first — another provider's model of the same name, such
        // as a subscription the gateway does not lend (owner, 2026-09-30: a new Codex chat ran
        // on its own account and asked for a sign-in).
        const slug =
          run.provider && !asked.includes('/') && port.providerSlug
            ? port.providerSlug(workspaceId, run.provider)
            : null;
        const ref =
          (slug ? port.resolveModelKey(workspaceId, `${slug}/${asked}`) : null) ??
          port.resolveModelKey(workspaceId, asked);
        if (ref) {
          return {
            model: ref.model,
            provider: port.runtimeProviderName(workspaceId, ref.provider_id),
            providerId: ref.provider_id,
          };
        }
      } catch {
        // A provider store that cannot answer must not stop a turn the agent can serve.
      }
    }
    if (asked) return { model: asked, provider: null, providerId: null };
    const fallback = this.defaultModelOf(row, workspaceId);
    if (!fallback) return { model: null, provider: null, providerId: null };
    try {
      return {
        model: fallback.model,
        provider: port?.runtimeProviderName(workspaceId, fallback.provider_id) ?? null,
        providerId: fallback.provider_id,
      };
    } catch {
      return { model: fallback.model, provider: null, providerId: fallback.provider_id };
    }
  }

  /**
   * Where a turn on `selection` moves on to when its model fails (contract decision §54): the
   * profile's chain, without the model the turn already runs on. Empty when the provider
   * store cannot answer — a turn is never stopped for want of a fallback.
   */
  fallbacksFor(workspaceId: string, selection: AgentSelection): FallbackModel[] {
    const port = this.options.models?.() ?? null;
    if (!port?.fallbackChain) return [];
    try {
      return port
        .fallbackChain(workspaceId)
        .filter(
          (member) =>
            !(member.providerId === selection.providerId && member.model === selection.model),
        );
    } catch {
      return [];
    }
  }

  /** The hub's slug for the provider of a selection, for naming the model that answered. */
  providerSlugOf(workspaceId: string, selection: AgentSelection): string | null {
    const port = this.options.models?.() ?? null;
    if (!port?.providerSlug || !selection.providerId) return null;
    try {
      return port.providerSlug(workspaceId, selection.providerId);
    } catch {
      return null;
    }
  }

  /**
   * The environment a process agent inherits (ADR 0010 §Propagation).
   *
   * The workspace's shared provider keys come first, under the names this agent's
   * catalog entry declared; the agent's own non-secret `env` and its explicit
   * `secret_refs` override them. Nobody entered a key for this agent: installing it was
   * the whole setup.
   */
  private environmentFor(
    row: AgentRow,
    workspaceId: string,
    settings: AgentSettingsRow | undefined,
  ): Record<string, string> {
    const port = this.options.models?.() ?? null;
    const declared = this.catalog.find((entry) => entry.id === row.slug)?.credentials ?? {};
    if (!port) return { ...(settings?.env ?? {}) };
    try {
      return port.environmentFor(workspaceId, declared, {
        ...(settings?.env ? { settingsEnv: settings.env } : {}),
        ...(settings?.secretRefs ? { secretRefs: settings.secretRefs } : {}),
      });
    } catch (error) {
      // A provider store that cannot answer must not stop an agent that needs no key.
      this.options.log.warn(
        { agent: row.slug, err: error },
        'agents: could not resolve the shared provider credentials',
      );
      return { ...(settings?.env ?? {}) };
    }
  }

  // ------------------------------------------------- the model gateway (ADR 0029)

  /**
   * Where this agent's model calls go in this profile: `hub` — through the model gateway, to the
   * model the turn chose, with no provider key handed to it. `null` where it is not the hub's to
   * say: Hermes and the hub's own agent (they reach the gateway their own way), an agent the
   * gateway does not wire yet, and a hub whose operator switched the gateway off
   * (`COREHUB_MODEL_GATEWAY=off`).
   *
   * There is no other answer (the owner, 2026-09-30: «ابي كل الايجنتات تمر عن طريقنا مالها اتصال
   * بنفسها … كل شي يكون عن طريق الهب بدون زر», DECISIONS §144): the agent's settings no longer
   * choose, its own sign-in on this computer does not count, and when the hub has no model for
   * it the turn fails with `gatewayMiss`'s words instead of running on the agent's own account.
   * `agent` stays in the type for callers written against the opt-in design; it is never
   * returned.
   */
  modelSourceFor(
    row: AgentRow,
    _workspaceId: string,
    _selection: AgentSelection,
  ): 'hub' | 'agent' | null {
    const entry = this.catalog.find((candidate) => candidate.id === row.slug);
    if (!entry?.gateway) return null;
    const gateway = this.options.models?.()?.gateway;
    if (!gateway) return null;
    if (!(gateway.enabled?.() ?? gateway.available())) return null;
    return 'hub';
  }

  /**
   * Why a turn that must run on the hub's models cannot, in words for the chat — pointing at
   * what to fix (Settings → Models, the model picker, or Agents). `null` when it can, or when
   * `modelSourceFor` says the agent is not the gateway's.
   */
  gatewayMiss(row: AgentRow, workspaceId: string, selection: AgentSelection): string | null {
    if (this.modelSourceFor(row, workspaceId, selection) !== 'hub') return null;
    const entry = this.catalog.find((candidate) => candidate.id === row.slug)!;
    const gateway = this.options.models!()!.gateway!;
    if (!gateway.available()) {
      return `${row.name} cannot run: Core Hub's model gateway is not available on this hub (its CLIProxyAPI is missing), and agents reach models only through it. Check the hub's log, or ask the administrator.`;
    }
    if (entry.gateway!.config === 'gemini-settings' && !this.options.gatewayStateDir) {
      return `${row.name} cannot run: Core Hub has nowhere to write its model gateway settings. Check the hub's log, or ask the administrator.`;
    }
    if (
      entry.gateway!.minVersion &&
      row.version &&
      compareVersions(row.version, entry.gateway!.minVersion) < 0
    ) {
      return `${row.name} ${row.version} cannot run on Core Hub's models: it needs version ${entry.gateway!.minVersion} or newer. Update it in Agents.`;
    }
    if (!selection.providerId || !selection.model) {
      return `${row.name} cannot run: Core Hub has no model for it. Add a provider or choose a default model in Settings → Models, or pick a model for this chat.`;
    }
    let serves: boolean;
    try {
      serves = gateway.serves(workspaceId, selection.providerId);
    } catch {
      serves = false;
    }
    if (!serves) {
      const port = this.options.models?.() ?? null;
      const name = port?.providerSlug?.(workspaceId, selection.providerId) ?? 'its provider';
      return `${row.name} cannot run on «${selection.model}» of ${name}: Core Hub's model gateway cannot serve that provider (it has no key the hub can use, or it is a sign-in only Hermes can use). Pick another model, or add the provider again in Settings → Models.`;
    }
    return null;
  }

  /** A gateway token for one agent process (the runner revokes it when the process goes). */
  openGateway(
    row: AgentRow,
    workspaceId: string,
    input: { sessionId: string; userId: string | null; alive(): boolean },
  ): Promise<AgentGatewayGrant> {
    const gateway = this.options.models?.()?.gateway;
    if (!gateway) return Promise.reject(new Error('this hub has no model gateway'));
    return gateway.open({
      workspace: workspaceId,
      agentId: row.id,
      agentSlug: row.slug,
      sessionId: input.sessionId,
      userId: input.userId,
      alive: input.alive,
    });
  }

  /**
   * An agent's environment on the gateway: its own settings `env` and `secret_refs` as ever, but
   * none of the profile's provider keys, and nothing that would outrank the token (the entry's
   * `clears` and its key variables); then the gateway's address, token and model alias. A proxy
   * the host sets is told to leave the loopback gateway alone.
   */
  private gatewayEnvironment(
    row: AgentRow,
    workspaceId: string,
    settings: AgentSettingsRow | undefined,
    selection: AgentSelection,
    grant: AgentGatewayGrant,
  ): {
    env: Record<string, string>;
    remove: string[];
    sessionConfig?: Record<string, string>;
  } | null {
    const entry = this.catalog.find((candidate) => candidate.id === row.slug)!;
    const wiring = entry.gateway!;
    const port = this.options.models?.() ?? null;
    let own: Record<string, string> = { ...(settings?.env ?? {}) };
    if (port) {
      try {
        // No `declared` families: the profile's keys are exactly what the agent must not get.
        own = port.environmentFor(
          workspaceId,
          {},
          {
            ...(settings?.env ? { settingsEnv: settings.env } : {}),
            ...(settings?.secretRefs ? { secretRefs: settings.secretRefs } : {}),
          },
        );
      } catch (error) {
        this.options.log.warn(
          { agent: row.slug, err: error },
          'agents: could not resolve the agent settings for the model gateway',
        );
      }
    }
    let contextWindow: number | null;
    try {
      contextWindow =
        selection.providerId && selection.model
          ? (port?.gateway?.contextWindow(workspaceId, selection.providerId, selection.model) ??
            null)
          : null;
    } catch {
      contextWindow = null;
    }
    const context = {
      anthropicBaseUrl: grant.anthropicBaseUrl,
      openaiBaseUrl: grant.openaiBaseUrl,
      googleBaseUrl: grant.googleBaseUrl,
      origin: grant.origin,
      token: grant.token,
      mainModel: GATEWAY_MAIN_MODEL,
      smallModel: GATEWAY_SMALL_MODEL,
      contextWindow,
    };
    const wired = wiring.env(context);
    // The piece of its own configuration no variable can say (Gemini CLI, Grok Build, Pi).
    let sessionConfig: Record<string, string> | undefined;
    if (wiring.config) {
      const hostEnv = this.options.credentialProbe?.env ?? {};
      const seen = { ...hostEnv, ...own };
      const written = applyGatewayConfig({
        kind: wiring.config,
        context,
        env: seen,
        home: this.options.credentialProbe?.home ?? seen.HOME ?? homedir(),
        stateDir: this.options.gatewayStateDir ?? '',
      });
      if (!written.ok) {
        // Nothing half-wired, and no quiet fall back to the agent's own account (§144).
        this.options.log.warn(
          { agent: row.slug, reason: written.reason },
          'agents: could not write the model gateway into the agent’s own settings',
        );
        throw new HubError('provider_not_configured', {
          message: `${row.name} cannot run: Core Hub could not write its model gateway settings (${written.reason}). Check the hub's log.`,
        });
      }
      Object.assign(wired, written.env);
      sessionConfig = written.sessionConfig;
    }
    const remove = [...new Set([...wiring.clears, ...Object.values(entry.credentials)])].filter(
      (name) => !(name in wired),
    );
    const gone = new Set(remove.map((name) => name.toUpperCase()));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(own)) {
      if (!gone.has(name.toUpperCase())) env[name] = value;
    }
    Object.assign(env, wired);
    const loopback = ['127.0.0.1', 'localhost', '::1'];
    const hostEnv = this.options.credentialProbe?.env ?? {};
    for (const name of ['NO_PROXY', 'no_proxy']) {
      const current = env[name] ?? hostEnv[name] ?? '';
      const listed = current
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      env[name] = [...listed, ...loopback.filter((host) => !listed.includes(host))].join(',');
    }
    return { env, remove, ...(sessionConfig ? { sessionConfig } : {}) };
  }

  /**
   * The model this agent uses when a run does not name one: the model pinned to it in
   * this workspace, else the workspace default for its kind (ADR 0010).
   */
  defaultModelOf(
    row: AgentRow,
    workspaceId: string,
  ): { provider_id: string; model: string } | null {
    const port = this.options.models?.() ?? null;
    if (!port) return null;
    const settings = this.settingsRow(workspaceId, row.id);
    try {
      return port.defaultModelFor(workspaceId, row.adapterKind, settings?.defaultModelId ?? null);
    } catch {
      return null;
    }
  }

  /** The supervised runtime reports here; the row and the `agent.updated` event follow. */
  setRuntime(slug: string, runtime: RuntimeState): void {
    const row = this.db.select().from(agents).where(eq(agents.slug, slug)).get();
    if (!row) return;
    this.runtimes.set(row.id, runtime);
  }

  /** The runtime block of a row; Hermes's carries its messaging gateways when the hub runs them. */
  private runtimeOf(row: AgentRow): RuntimeState {
    const runtime = this.runtimes.get(row.id) ?? NOT_APPLICABLE;
    if (row.adapterKind !== 'hermes' || !this.options.gateways) return runtime;
    const gateways = this.options.gateways();
    return gateways.length > 0 ? { ...runtime, gateways } : runtime;
  }

  /** Re-run the adapter probe for one catalog entry (after the runtime came up). */
  async reprobe(slug: string): Promise<void> {
    const row = this.db.select().from(agents).where(eq(agents.slug, slug)).get();
    if (!row) return;
    const probe = await this.options.adapters.byKind(row.adapterKind).probe(this.targetOf(row));
    this.applyProbe(row, probe);
  }

  private present(
    row: AgentRow,
    scope: WorkspaceScope,
    settings: AgentSettingsRow | undefined,
    language: Language = this.language,
  ): ContractAgent {
    const modelSource =
      row.adapterKind === 'acp' && row.installState === 'installed'
        ? this.modelSourceSafe(row, scope.id)
        : null;
    return serializeAgent(row, {
      modelSource,
      gatewayMinContext:
        this.catalog.find((entry) => entry.id === row.slug)?.gateway?.minContext ?? null,
      profile: scope.slug,
      hasAvatar: this.options.avatars?.has(row.id) ?? false,
      settings,
      runtime: this.runtimeOf(row),
      defaultModel: this.defaultModelOf(row, scope.id),
      name: this.displayName(row, language),
      selfUpdate: this.selfUpdates(row),
      // On the hub's models it answers with the hub's providers, whatever it has of its own.
      credentials: modelSource === 'hub' ? 'ready' : this.credentialsOf(row, scope.id, settings),
      ownModel:
        this.options.credentialProbe &&
        row.adapterKind === 'acp' &&
        row.installState === 'installed'
          ? agentOwnModel(row.slug, this.options.credentialProbe)
          : null,
    });
  }

  /** `modelSourceFor` at the profile's default, for the card; never throws. */
  private modelSourceSafe(row: AgentRow, workspaceId: string): 'hub' | 'agent' | null {
    try {
      return this.modelSourceFor(row, workspaceId, this.selectionFor(row, workspaceId, {}));
    } catch (error) {
      this.options.log.warn(
        { agent: row.slug, err: error },
        'agents: could not read the model source',
      );
      return null;
    }
  }

  /**
   * Whether an installed coding agent has a key or a sign-in to answer with (`ready` /
   * `missing`), where the hub can know; `null` elsewhere (`agent-credentials.ts`).
   */
  private credentialsOf(
    row: AgentRow,
    workspaceId: string,
    settings: AgentSettingsRow | undefined,
  ): CredentialState | null {
    const probe = this.options.credentialProbe;
    if (!probe || row.adapterKind !== 'acp' || row.installState !== 'installed') return null;
    const entry = this.catalog.find((candidate) => candidate.id === row.slug);
    if (!entry) return null;
    try {
      return credentialState(
        row.slug,
        Object.values(entry.credentials),
        this.environmentFor(row, workspaceId, settings),
        probe,
      );
    } catch (error) {
      this.options.log.warn({ agent: row.slug, err: error }, 'agents: could not read credentials');
      return null;
    }
  }

  /**
   * The name a client shows. Brands ("Hermes", "Codex") read the same in both
   * languages and have no second name; the hub's own agent is an ordinary word and does
   * (TEAM-RULES §4: no user-facing string without Arabic and English).
   *
   * A row somebody renamed keeps the name they gave it: the catalog's Arabic is offered
   * only while the row still carries the catalog's English.
   */
  private displayName(row: AgentRow, language: Language): string {
    if (language !== 'ar') return row.name;
    const entry = this.catalog.find((candidate) => candidate.id === row.slug);
    if (!entry?.nameAr || row.name !== entry.name) return row.name;
    return entry.nameAr;
  }

  private announce(row: AgentRow, scope: WorkspaceScope): ContractAgent {
    const agent = this.present(row, scope, this.settingsRow(scope.id, row.id));
    this.options.realtime.emit(
      REALTIME_NAMESPACES.jobs,
      'agent.updated',
      { profile: scope.slug },
      { agent },
    );
    return agent;
  }

  private adapterRowId(kind: AdapterKind, ownerId: string): string {
    const existing = this.db.select().from(agentAdapters).where(eq(agentAdapters.kind, kind)).get();
    if (existing) return existing.id;
    const adapter = this.options.adapters.byKind(kind);
    const id = newUlid();
    const at = this.now();
    this.db
      .insert(agentAdapters)
      .values({
        id,
        ownerId,
        kind,
        name: adapter.name,
        version: adapter.version,
        capabilities: adapter.capabilities(),
        status: 'available',
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return id;
  }

  /** Creates the row for a catalog entry, or brings an existing row back in line with it. */
  private seedEntry(entry: CatalogEntry, ownerId: string): AgentRow {
    const adapterId = this.adapterRowId(entry.adapter, ownerId);
    const at = this.now();
    const existing = this.db.select().from(agents).where(eq(agents.slug, entry.id)).get();
    if (existing) {
      // The catalog is the source of truth for everything except install state: an
      // approved change to capabilities or to the pinned package reaches the row here.
      this.db
        .update(agents)
        .set({
          vendor: entry.vendor,
          licence: entry.licence,
          adapterId,
          adapterKind: entry.adapter,
          command: [entry.binary, ...entry.protocolArgs],
          packageName: entry.install.kind === 'npm' ? entry.install.package : null,
          // A newer version the registry named survives a restart; a new pin past it wins.
          latestVersion: newerOf(pinnedVersion(entry), stable(existing.latestVersion)),
          capabilities: entry.capabilities,
          sections: entry.sections,
          selectable: this.options.adapters.byKind(entry.adapter).selectable,
          limited: entry.adapter === 'harness',
          updatedAt: at,
        })
        .where(eq(agents.id, existing.id))
        .run();
      return this.loadAgent(existing.id);
    }
    const id = newUlid();
    this.db
      .insert(agents)
      .values({
        id,
        ownerId,
        slug: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        licence: entry.licence,
        adapterId,
        adapterKind: entry.adapter,
        source: entry.install.kind === 'bundled' ? 'builtin' : 'none',
        command: [entry.binary, ...entry.protocolArgs],
        packageName: entry.install.kind === 'npm' ? entry.install.package : null,
        latestVersion: pinnedVersion(entry),
        endpoint: entry.defaultEndpoint ?? null,
        capabilities: entry.capabilities,
        sections: entry.sections,
        limited: entry.adapter === 'harness',
        selectable: this.options.adapters.byKind(entry.adapter).selectable,
        installState: 'not_installed',
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return this.loadAgent(id);
  }

  /**
   * A row still `installing` or `updating` when the hub starts: nothing is running, so the job
   * that set it died with the previous process. Whether the files are there decides.
   */
  private settleInterrupted(entry: CatalogEntry, row: AgentRow): boolean {
    if (!busyInstalling(row)) return false;
    this.db
      .update(agents)
      .set({
        installState: this.options.installer.isPresent(entry) ? 'installed' : 'failed',
        installJobId: null,
        lastError: 'the install did not finish before the hub stopped',
        updatedAt: this.now(),
      })
      .where(eq(agents.id, row.id))
      .run();
    return true;
  }

  /**
   * The volume is the truth about what is installed. This runs on every boot so a
   * container restart, a `docker pull` or a half-finished install leaves the table
   * agreeing with the disk.
   */
  private async reconcile(
    entry: CatalogEntry,
    row: AgentRow,
  ): Promise<'installed' | 'missing' | 'unchanged'> {
    const at = this.now();

    if (!isManaged(entry)) {
      // Bundled: the adapter's probe decides, because the binary is in the image.
      const probe = await this.options.adapters.byKind(row.adapterKind).probe(this.targetOf(row));
      // Read again: an install a person started while the probe ran owns the row now.
      this.applyProbe(
        this.db.select().from(agents).where(eq(agents.id, row.id)).get() ?? row,
        probe,
      );
      return probe.installed ? 'installed' : 'missing';
    }

    if (this.options.installer.isPresent(entry)) {
      const health = await this.options.installer.health(entry, {
        timeoutMs: this.options.bootHealthTimeoutMs ?? BOOT_HEALTH_TIMEOUT_MS,
      });
      const now = this.db.select().from(agents).where(eq(agents.id, row.id)).get();
      if (!now || busyInstalling(now)) return 'unchanged';
      this.db
        .update(agents)
        .set({
          installState: health.ok ? 'installed' : 'failed',
          source: 'managed',
          // The program actually there: an install from before a rename runs the old one (§139).
          executablePath:
            this.options.installer.executablePath?.(entry) ??
            `${this.options.installer.binDirFor(entry.id)}/${entry.binary}`,
          // A bridge that prints no version (`claude-code-acp`) keeps the one its install read.
          version: health.version ?? now.version,
          detectedAt: at,
          lastError: health.error,
          updatedAt: at,
        })
        .where(eq(agents.id, row.id))
        .run();
      this.runtimes.set(row.id, NOT_APPLICABLE);
      return health.ok ? 'installed' : 'missing';
    }

    this.runtimes.set(row.id, NOT_APPLICABLE);
    if (row.installState === 'not_installed') return 'unchanged';
    // The row says installed but the directory is gone: someone cleared the volume.
    this.db
      .update(agents)
      .set({
        installState: 'not_installed',
        source: 'none',
        executablePath: null,
        version: null,
        lastError: null,
        updatedAt: at,
      })
      .where(eq(agents.id, row.id))
      .run();
    return 'missing';
  }

  /** Writes what an adapter probe learned onto the row. */
  private applyProbe(row: AgentRow, probe: AgentProbe): void {
    this.runtimes.set(row.id, probe.runtime);
    if (row.installState === 'installing' || row.installState === 'updating') return;
    const at = this.now();
    this.db
      .update(agents)
      .set({
        installState: probe.installed ? 'installed' : 'not_installed',
        source: probe.source,
        executablePath: probe.executablePath,
        version: probe.version,
        detectedAt: probe.installed ? at : null,
        lastError: probe.error,
        updatedAt: at,
      })
      .where(eq(agents.id, row.id))
      .run();
  }
}

/** Hermes is pinned to the top of the registry (ADR 0006); the rest sort by name. */
/**
 * Hermes first (ADR 0006), the hub's own agent second, then everything installable.
 *
 * Those two are the whole of a fresh install (ADOPTION-BACKLOG §2.15), and they are the
 * two a person can use before they have installed anything, so they lead the list.
 */
function order(row: AgentRow): number {
  if (row.adapterKind === 'hermes') return 0;
  if (row.adapterKind === 'builtin') return 1;
  return 2;
}

/** A version the hub may offer: stable, or nothing. */
function stable(value: string | null | undefined): string | null {
  return isStableVersion(value) ? value : null;
}

/** Whether a row's installed version is older than the newest version it knows of. */
export function updateAvailable(row: Pick<AgentRow, 'version' | 'latestVersion'>): boolean {
  return (
    !!row.version && !!row.latestVersion && compareVersions(row.latestVersion, row.version) > 0
  );
}
