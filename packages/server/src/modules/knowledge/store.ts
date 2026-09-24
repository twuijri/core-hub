/**
 * Every query `knowledge` makes against the `attachments` table.
 *
 * One rule, repeated in every method: the `workspace` column is part of the predicate,
 * always (invariant 3). An id from another workspace is therefore not "forbidden", it
 * simply does not exist — which is what a 404 says.
 */
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { attachments, type AttachmentMeta } from './schema.js';

export type AttachmentRow = typeof attachments.$inferSelect;

export interface AttachmentInsert {
  workspace: string;
  ownerId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  kind: AttachmentRow['kind'];
  sourceKind: AttachmentRow['sourceKind'];
  sourceId: string | null;
  meta: AttachmentMeta;
  expiresAt: Date | null;
}

export class AttachmentStore {
  constructor(private readonly db: ModuleDb) {}

  create(input: AttachmentInsert): AttachmentRow {
    const [row] = this.db.insert(attachments).values(input).returning().all();
    return row as AttachmentRow;
  }

  /** Live row (bytes present) for this workspace, or `undefined`. */
  get(workspace: string, id: string): AttachmentRow | undefined {
    return this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.workspace, workspace),
          eq(attachments.id, id),
          isNull(attachments.deletedAt),
        ),
      )
      .get();
  }

  /** Including rows whose bytes are gone — a reference must still render "removed". */
  getEvenIfDeleted(workspace: string, id: string): AttachmentRow | undefined {
    return this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspace, workspace), eq(attachments.id, id)))
      .get();
  }

  /** The live rows for a set of ids, in one query, keyed by id. */
  many(workspace: string, ids: readonly string[]): Map<string, AttachmentRow> {
    const found = new Map<string, AttachmentRow>();
    if (ids.length === 0) return found;
    const rows = this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspace, workspace), inArray(attachments.id, [...new Set(ids)])))
      .all();
    for (const row of rows) found.set(row.id, row);
    return found;
  }

  /** An identical upload already in this workspace, so the bytes are stored once. */
  findBySha(workspace: string, sha256: string, sizeBytes: number): AttachmentRow | undefined {
    return this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.workspace, workspace),
          eq(attachments.sha256, sha256),
          eq(attachments.sizeBytes, sizeBytes),
          isNull(attachments.deletedAt),
        ),
      )
      .get();
  }

  /** How many live rows still point at these bytes (the last one owns their removal). */
  referencesTo(workspace: string, storageKey: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(attachments)
      .where(
        and(
          eq(attachments.workspace, workspace),
          eq(attachments.storageKey, storageKey),
          isNull(attachments.deletedAt),
        ),
      )
      .get();
    return row?.count ?? 0;
  }

  /**
   * Remove the row itself, for a file nothing refers to by design (an uploaded profile
   * archive once its import ended). Its storage key is free again afterwards, so the same
   * bytes can be uploaded anew.
   */
  purge(workspace: string, id: string): AttachmentRow | undefined {
    return this.db
      .delete(attachments)
      .where(and(eq(attachments.workspace, workspace), eq(attachments.id, id)))
      .returning()
      .get();
  }

  /** Mark the row deleted; the caller removes the bytes when nothing else needs them. */
  markDeleted(workspace: string, id: string, at: Date = new Date()): AttachmentRow | undefined {
    return this.db
      .update(attachments)
      .set({ deletedAt: at })
      .where(and(eq(attachments.workspace, workspace), eq(attachments.id, id)))
      .returning()
      .get();
  }

  /** Temporary rows past their time; the caller deletes their bytes. */
  expired(now: Date = new Date()): AttachmentRow[] {
    return this.db
      .select()
      .from(attachments)
      .where(and(lte(attachments.expiresAt, now), isNull(attachments.deletedAt)))
      .all();
  }
}
