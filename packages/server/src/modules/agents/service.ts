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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleDb } from '../../lib/db.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import type { Realtime } from '../../lib/realtime.js';
import { agentUnavailable, conflict, notFound, stateInvalid } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import { t, type Language } from '../../i18n/index.js';
import type { AuditService, JobRow, JobRunner } from '../audit/index.js';
import type { WorkspaceScope } from '../auth/index.js';
import {
  CATALOG,
  assertCatalogIsWellFormed,
  isManaged,
  pinnedVersion,
  type CatalogEntry,
} from './catalog/index.js';
import type { AdapterSet } from './adapters/index.js';
import type { AdapterKind, AgentProbe, AgentTarget, SettingsSection } from './adapters/types.js';
import type { AgentInstaller } from './installer.js';
import type { AgentModelsPort } from './ports.js';
import { agents, agentSettings, agentAdapters } from './schema.js';
import {
  serializeAgent,
  type AgentRow,
  type AgentSettingsRow,
  type ContractAgent,
  type RuntimeState,
} from './serialize.js';

const NOT_APPLICABLE: RuntimeState = { state: 'not_applicable', url: null, error: null };

/** Who asked for an install; only the id and the role matter here. */
export interface Actor {
  userId: string;
}

export interface AgentsServiceOptions {
  db: ModuleDb;
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
  catalog?: readonly CatalogEntry[];
  language?: Language;
  now?: () => Date;
}

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

export class AgentsService {
  private readonly catalog: readonly CatalogEntry[];
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

  /** Seeds the catalog and reconciles the table against the volume. Once per boot. */
  async bootstrap(ownerId: string): Promise<ReconcileReport> {
    assertCatalogIsWellFormed(this.catalog);
    const report: ReconcileReport = { installed: [], missing: [], interrupted: [] };
    // The harness adapter has no catalog entries yet but must exist as a row so a client
    // can see that the kind is declared (ADR 0002).
    this.adapterRowId('harness', ownerId);
    for (const entry of this.catalog) {
      try {
        const row = this.seedEntry(entry, ownerId);
        const outcome = await this.reconcile(entry, row);
        if (outcome === 'installed') report.installed.push(entry.id);
        if (outcome === 'missing') report.missing.push(entry.id);
        if (outcome === 'interrupted') report.interrupted.push(entry.id);
      } catch (error) {
        this.options.log.warn(
          { agent: entry.id, err: error },
          'agents: could not reconcile a catalog entry',
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

  // ----------------------------------------------------------------- reads

  list(scope: WorkspaceScope, filter: { kind?: AdapterKind }): ContractAgent[] {
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
        .map((row) => this.present(row, scope, this.settingsRow(scope.id, row.id)))
    );
  }

  get(scope: WorkspaceScope, id: string): ContractAgent {
    const row = this.loadAgent(id);
    return this.present(row, scope, this.settingsRow(scope.id, row.id));
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
    if (patch.avatar != null) {
      throw stateInvalid({
        field: 'avatar',
        reason: 'agent avatars are attachments; the knowledge module that stores them is Phase 4',
      });
    }
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
    if (Object.keys(changes).length > 1) {
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

  updateSettings(
    scope: WorkspaceScope,
    id: string,
    input: { section: string; values: Record<string, unknown> },
  ): { section: SettingsSection; restart_job_id: string | null } {
    const row = this.loadAgent(id);
    const sections = this.settings(scope, id);
    const section = sections.find((candidate) => candidate.key === input.section);
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

  // ------------------------------------------------------------------ jobs

  install(scope: WorkspaceScope, actor: Actor, id: string): JobRow {
    return this.lifecycleJob(scope, actor, id, 'install');
  }

  upgrade(scope: WorkspaceScope, actor: Actor, id: string): JobRow {
    return this.lifecycleJob(scope, actor, id, 'update');
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
        // The catalog's pin is what "up to date" means: the hub never installs a version
        // the owner did not approve, so it never advertises one either.
        const pinned = pinnedVersion(entry);
        const health = isManaged(entry) ? await this.options.installer.health(entry) : null;
        const at = this.now();
        this.db
          .update(agents)
          .set({
            latestVersion: pinned,
            version: health?.version ?? row.version,
            checkedAt: at,
            lastError: health?.error ?? null,
            updatedAt: at,
          })
          .where(eq(agents.id, row.id))
          .run();
        const fresh = this.loadAgent(row.id);
        this.announce(fresh, scope);
        handle.progress(100, t('jobs.check_done', this.language));
        return {
          latest_version: pinned,
          update_available: !!pinned && !!fresh.version && pinned !== fresh.version,
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
            const outcome = await this.options.installer.install(entry, async (percent, message) =>
              handle.progress(percent, message),
            );
            const at = this.now();
            this.db
              .update(agents)
              .set({
                installState: 'installed',
                source: 'managed',
                executablePath: outcome.executablePath,
                version: outcome.version,
                latestVersion: pinnedVersion(entry),
                checkedAt: at,
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
          throw error;
        }
        const fresh = this.loadAgent(row.id);
        this.announce(fresh, scope);
        this.options.audit.record({
          actorKind: 'user',
          actorId: actor.userId,
          ownerId: actor.userId,
          workspace: scope.id,
          action: `agents.${kind === 'uninstall' ? 'uninstalled' : kind === 'update' ? 'updated' : 'installed'}`,
          entityKind: 'agent',
          entityId: fresh.id,
          summary: `${fresh.name} ${kind}`,
          data: { version: fresh.version },
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
    },
  ): AgentTarget {
    const settings = this.settingsRow(workspaceId, row.id);
    const cwd = run.cwd ?? settings?.workingDir ?? null;
    const env = this.environmentFor(row, workspaceId, settings);
    const selection = this.selectionFor(row, workspaceId, run);
    return {
      ...this.targetOf(row),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      sessionRef: run.sessionRef,
      model: selection.model,
      modelProvider: selection.provider,
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
  ): { model: string | null; provider: string | null } {
    const port = this.options.models?.() ?? null;
    const asked = run.model?.trim() ?? '';
    if (asked && port) {
      try {
        const ref = port.resolveModelKey(workspaceId, asked);
        if (ref) {
          return {
            model: ref.model,
            provider: port.runtimeProviderName(workspaceId, ref.provider_id),
          };
        }
      } catch {
        // A provider store that cannot answer must not stop a turn the agent can serve.
      }
    }
    if (asked) return { model: asked, provider: null };
    const fallback = this.defaultModelOf(row, workspaceId);
    if (!fallback) return { model: null, provider: null };
    try {
      return {
        model: fallback.model,
        provider: port?.runtimeProviderName(workspaceId, fallback.provider_id) ?? null,
      };
    } catch {
      return { model: fallback.model, provider: null };
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
  ): ContractAgent {
    return serializeAgent(row, {
      profile: scope.slug,
      settings,
      runtime: this.runtimes.get(row.id) ?? NOT_APPLICABLE,
      defaultModel: this.defaultModelOf(row, scope.id),
    });
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
          latestVersion: pinnedVersion(entry),
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
   * The volume is the truth about what is installed. This runs on every boot so a
   * container restart, a `docker pull` or a half-finished install leaves the table
   * agreeing with the disk.
   */
  private async reconcile(
    entry: CatalogEntry,
    row: AgentRow,
  ): Promise<'installed' | 'missing' | 'interrupted' | 'unchanged'> {
    const at = this.now();

    if (row.installState === 'installing' || row.installState === 'updating') {
      // Nothing is running: this process just started, so the job that set this state
      // died with the previous one.
      this.db
        .update(agents)
        .set({
          installState: this.options.installer.isPresent(entry) ? 'installed' : 'failed',
          installJobId: null,
          lastError: 'the install did not finish before the hub stopped',
          updatedAt: at,
        })
        .where(eq(agents.id, row.id))
        .run();
      return 'interrupted';
    }

    if (!isManaged(entry)) {
      // Bundled: the adapter's probe decides, because the binary is in the image.
      const probe = await this.options.adapters.byKind(row.adapterKind).probe(this.targetOf(row));
      this.applyProbe(row, probe);
      return probe.installed ? 'installed' : 'missing';
    }

    if (this.options.installer.isPresent(entry)) {
      const health = await this.options.installer.health(entry);
      this.db
        .update(agents)
        .set({
          installState: health.ok ? 'installed' : 'failed',
          source: 'managed',
          executablePath: `${this.options.installer.binDirFor(entry.id)}/${entry.binary}`,
          version: health.version,
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
function order(row: AgentRow): number {
  return row.adapterKind === 'hermes' ? 0 : 1;
}
