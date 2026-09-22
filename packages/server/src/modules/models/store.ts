/**
 * Row access for the `models` module: the small typed reads and writes every operation
 * shares.
 *
 * There is no seeding. A row in `providers` exists because somebody added it
 * (`models.createProvider`); the bundled catalogue is a list of *presets* a client offers
 * in its "Add provider" dialog, not a list of rows (contract decision §26). ADR 0006's
 * "visible and unconfigured, never hidden" still holds — it is the preset list that is
 * visible now, and the Models screen shows what the person actually configured.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';
import { catalogueEntry, type ProviderCatalogueEntry } from './catalogue.js';
import {
  ensembles,
  modelDefaults,
  models,
  providers,
  speechSettings,
  type EnsembleRow,
  type ModelDefaultRow,
  type ModelRole,
  type ModelRow,
  type ProviderRow,
  type SpeechSettingsRow,
} from './schema.js';

export interface StoreOptions {
  db: ModuleDb;
  now?: () => Date;
}

export class ModelsStore {
  private readonly db: ModuleDb;
  private readonly now: () => Date;

  constructor(options: StoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  listProviders(workspace: string, kind?: string): ProviderRow[] {
    return this.db
      .select()
      .from(providers)
      .where(and(eq(providers.workspace, workspace), isNull(providers.archivedAt)))
      .orderBy(asc(providers.slug))
      .all()
      .filter((row) => !kind || row.kind === kind);
  }

  provider(workspace: string, id: string): ProviderRow | undefined {
    return this.db
      .select()
      .from(providers)
      .where(and(eq(providers.workspace, workspace), eq(providers.id, id)))
      .get();
  }

  providerBySlug(workspace: string, slug: string): ProviderRow | undefined {
    return this.db
      .select()
      .from(providers)
      .where(and(eq(providers.workspace, workspace), eq(providers.slug, slug)))
      .get();
  }

  /** Every provider row that shares one credential family — "one key, many rows". */
  familyRows(workspace: string, family: string): ProviderRow[] {
    return this.db
      .select()
      .from(providers)
      .where(and(eq(providers.workspace, workspace), eq(providers.family, family)))
      .all();
  }

  modelsOf(providerId: string): ModelRow[] {
    return this.db
      .select()
      .from(models)
      .where(and(eq(models.providerId, providerId), isNull(models.archivedAt)))
      .orderBy(asc(models.modelKey))
      .all();
  }

  model(providerId: string, modelKey: string): ModelRow | undefined {
    return this.db
      .select()
      .from(models)
      .where(and(eq(models.providerId, providerId), eq(models.modelKey, modelKey)))
      .get();
  }

  modelById(workspace: string, id: string): ModelRow | undefined {
    return this.db
      .select()
      .from(models)
      .where(and(eq(models.workspace, workspace), eq(models.id, id)))
      .get();
  }

  /**
   * Every non-archived model of the workspace, ordered by provider then model id.
   *
   * Not by row id: two models discovered in the same millisecond get ULIDs whose order
   * is random, and a picker whose order changes between two identical requests is a bug
   * a person can see. The catalogue's cursor is the `(provider_id, model_key)` pair for
   * the same reason (`service.ts` §listCatalogue).
   */
  allModels(workspace: string): ModelRow[] {
    return this.db
      .select()
      .from(models)
      .where(and(eq(models.workspace, workspace), isNull(models.archivedAt)))
      .orderBy(asc(models.providerId), asc(models.modelKey))
      .all();
  }

  defaults(workspace: string): ModelDefaultRow[] {
    return this.db.select().from(modelDefaults).where(eq(modelDefaults.workspace, workspace)).all();
  }

  defaultFor(workspace: string, role: ModelRole): ModelDefaultRow | undefined {
    return this.db
      .select()
      .from(modelDefaults)
      .where(and(eq(modelDefaults.workspace, workspace), eq(modelDefaults.role, role)))
      .get();
  }

  setDefault(
    scope: { workspace: string; ownerId: string },
    role: ModelRole,
    modelId: string,
    fallbacks: string[],
  ): void {
    const at = this.now();
    const existing = this.defaultFor(scope.workspace, role);
    if (existing) {
      this.db
        .update(modelDefaults)
        .set({ modelId, fallbackModelIds: fallbacks, updatedAt: at })
        .where(eq(modelDefaults.id, existing.id))
        .run();
      return;
    }
    this.db
      .insert(modelDefaults)
      .values({
        id: newUlid(),
        ownerId: scope.ownerId,
        workspace: scope.workspace,
        createdAt: at,
        updatedAt: at,
        role,
        modelId,
        fallbackModelIds: fallbacks,
      })
      .run();
  }

  clearDefault(workspace: string, role: ModelRole): void {
    this.db
      .delete(modelDefaults)
      .where(and(eq(modelDefaults.workspace, workspace), eq(modelDefaults.role, role)))
      .run();
  }

  listEnsembles(workspace: string): EnsembleRow[] {
    return this.db
      .select()
      .from(ensembles)
      .where(and(eq(ensembles.workspace, workspace), isNull(ensembles.archivedAt)))
      .orderBy(asc(ensembles.createdAt))
      .all();
  }

  ensemble(workspace: string, id: string): EnsembleRow | undefined {
    return this.db
      .select()
      .from(ensembles)
      .where(and(eq(ensembles.workspace, workspace), eq(ensembles.id, id)))
      .get();
  }

  speech(workspace: string): SpeechSettingsRow | undefined {
    return this.db
      .select()
      .from(speechSettings)
      .where(eq(speechSettings.workspace, workspace))
      .get();
  }

  ensureSpeech(scope: { workspace: string; ownerId: string }): SpeechSettingsRow {
    const existing = this.speech(scope.workspace);
    if (existing) return existing;
    const at = this.now();
    this.db
      .insert(speechSettings)
      .values({
        id: newUlid(),
        ownerId: scope.ownerId,
        workspace: scope.workspace,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    const created = this.speech(scope.workspace);
    if (!created) throw new Error('speech settings row disappeared right after insert');
    return created;
  }

  /**
   * Replaces a provider's discovered catalogue with what the provider just answered.
   * Models a person typed by hand (`source: manual`) survive; everything the hub
   * discovered before and the provider no longer lists is archived, not deleted, so a
   * session that still names it can still explain itself.
   */
  replaceCatalogue(
    scope: { workspace: string; ownerId: string },
    providerId: string,
    discovered: {
      key: string;
      label: string;
      kind: ModelRow['kind'];
      contextWindow?: number | null;
      maxOutputTokens?: number | null;
      capabilities?: ModelRow['capabilities'];
      pricing?: ModelRow['pricing'];
      preview?: boolean;
    }[],
  ): { added: number; updated: number; archived: number } {
    const at = this.now();
    const existing = this.db.select().from(models).where(eq(models.providerId, providerId)).all();
    const byKey = new Map(existing.map((row) => [row.modelKey, row]));
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;
    for (const item of discovered) {
      seen.add(item.key);
      const row = byKey.get(item.key);
      const values = {
        label: item.label,
        kind: item.kind,
        contextWindow: item.contextWindow ?? null,
        maxOutputTokens: item.maxOutputTokens ?? null,
        capabilities: item.capabilities ?? [],
        pricing: item.pricing ?? {},
        preview: item.preview ?? false,
        archivedAt: null,
        updatedAt: at,
      };
      if (row) {
        // A hand-added model the provider now lists becomes a discovered one; an alias or
        // a visibility choice the person made is theirs and stays.
        this.db
          .update(models)
          .set({ ...values, source: row.source === 'manual' ? 'discovered' : row.source })
          .where(eq(models.id, row.id))
          .run();
        updated += 1;
        continue;
      }
      this.db
        .insert(models)
        .values({
          id: newUlid(),
          ownerId: scope.ownerId,
          workspace: scope.workspace,
          createdAt: at,
          providerId,
          modelKey: item.key,
          source: 'discovered',
          ...values,
        })
        .run();
      added += 1;
    }
    const stale = existing
      .filter((row) => !seen.has(row.modelKey) && row.source !== 'manual' && !row.archivedAt)
      .map((row) => row.id);
    if (stale.length > 0) {
      this.db
        .update(models)
        .set({ archivedAt: at, updatedAt: at })
        .where(inArray(models.id, stale))
        .run();
    }
    return { added, updated, archived: stale.length };
  }

  catalogueEntryFor(row: ProviderRow): ProviderCatalogueEntry | undefined {
    return catalogueEntry(row.slug);
  }
}
