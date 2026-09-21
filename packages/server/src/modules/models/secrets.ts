/**
 * The workspace secret store: the `secrets` table plus the key ring (`crypto.ts`).
 *
 * This is the only code in the hub that turns a plaintext credential into a row and back.
 * Other modules never see a plaintext: they hold a `secrets.id`
 * (`agents.agent_settings.secret_refs`, `notify.webhooks.signing_secret_id`,
 * `plugins.plugin_bindings.secret_refs`) and ask the propagation layer to resolve it at
 * the moment a process starts (ADR 0010).
 *
 * Reads are cached per (workspace, secret id) for the life of the process, because a
 * coding agent may be started many times a minute and AES is not the point of the cost —
 * the cache is invalidated on every write and wipe of that row.
 */
import { and, eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { newUlid } from '../../db/ids.js';
import { DataKeyRing } from './crypto.js';
import { secrets, type SecretKind, type SecretRow } from './schema.js';

export interface SecretStoreOptions {
  db: ModuleDb;
  keys: DataKeyRing;
  now?: () => Date;
}

/** What a client may learn about a secret: that it exists, and its last four characters. */
export interface SecretSummary {
  id: string;
  name: string;
  kind: SecretKind;
  /** False once wiped: the row is kept, the ciphertext is not. */
  present: boolean;
  hint: string | null;
  rotatedAt: Date | null;
}

export class SecretStore {
  private readonly db: ModuleDb;
  private readonly keys: DataKeyRing;
  private readonly now: () => Date;
  private readonly cache = new Map<string, string>();

  constructor(options: SecretStoreOptions) {
    this.db = options.db;
    this.keys = options.keys;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Stores `plaintext` under `name` in this workspace, creating or replacing the row.
   * Returns the row id, which is what other modules reference.
   */
  put(
    scope: { workspace: string; ownerId: string },
    name: string,
    plaintext: string,
    kind: SecretKind = 'api_key',
  ): string {
    const sealed = this.keys.seal(plaintext);
    const at = this.now();
    const existing = this.rowByName(scope.workspace, name);
    if (existing) {
      this.db
        .update(secrets)
        .set({
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          keyId: sealed.keyId,
          hint: sealed.hint,
          kind,
          rotatedAt: at,
          wipedAt: null,
          archivedAt: null,
          updatedAt: at,
        })
        .where(eq(secrets.id, existing.id))
        .run();
      this.cache.set(existing.id, plaintext);
      return existing.id;
    }
    const id = newUlid();
    this.db
      .insert(secrets)
      .values({
        id,
        ownerId: scope.ownerId,
        workspace: scope.workspace,
        name,
        kind,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyId: sealed.keyId,
        hint: sealed.hint,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    this.cache.set(id, plaintext);
    return id;
  }

  /**
   * The plaintext, or null when the row is absent or wiped. Every caller of this is a
   * propagation path (a process environment, an HTTP header the hub itself sends); the
   * value never reaches a response body or a log line.
   */
  reveal(workspace: string, id: string): string | null {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const row = this.row(workspace, id);
    if (!row?.ciphertext || !row.nonce || row.wipedAt) return null;
    const plaintext = this.keys.open({
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      keyId: row.keyId,
    });
    this.cache.set(id, plaintext);
    return plaintext;
  }

  /** Whether a usable secret is stored, without decrypting it. */
  has(workspace: string, id: string | null | undefined): boolean {
    if (!id) return false;
    const row = this.row(workspace, id);
    return !!row?.ciphertext && !row.wipedAt;
  }

  summary(workspace: string, id: string | null | undefined): SecretSummary | null {
    if (!id) return null;
    const row = this.row(workspace, id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      present: !!row.ciphertext && !row.wipedAt,
      hint: row.hint,
      rotatedAt: row.rotatedAt,
    };
  }

  /**
   * Clears the ciphertext and keeps the row, so references from other modules still
   * resolve to "there was a secret here, and it is gone" (domain README §Archive rule 3).
   */
  wipe(workspace: string, id: string): void {
    const at = this.now();
    this.db
      .update(secrets)
      .set({ ciphertext: null, nonce: null, hint: null, wipedAt: at, updatedAt: at })
      .where(and(eq(secrets.workspace, workspace), eq(secrets.id, id)))
      .run();
    this.cache.delete(id);
  }

  /**
   * Rotation: mint a new data key version and re-seal every row that is not on it yet.
   * Returns how many rows moved. Rows sealed under a version the ring no longer holds are
   * reported rather than silently skipped, because that is data loss, not a detail.
   */
  rotate(): { keyId: string; resealed: number; unreadable: string[] } {
    const keyId = this.keys.rotate();
    const unreadable: string[] = [];
    let resealed = 0;
    const at = this.now();
    for (const row of this.db.select().from(secrets).all()) {
      if (!row.ciphertext || !row.nonce || row.wipedAt) continue;
      if (row.keyId === keyId) continue;
      try {
        const sealed = this.keys.reseal({
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          keyId: row.keyId,
        });
        this.db
          .update(secrets)
          .set({
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            keyId: sealed.keyId,
            rotatedAt: at,
            updatedAt: at,
          })
          .where(eq(secrets.id, row.id))
          .run();
        resealed += 1;
      } catch {
        unreadable.push(row.id);
      }
    }
    this.cache.clear();
    return { keyId, resealed, unreadable };
  }

  private row(workspace: string, id: string): SecretRow | undefined {
    return this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.workspace, workspace), eq(secrets.id, id)))
      .get();
  }

  private rowByName(workspace: string, name: string): SecretRow | undefined {
    return this.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.workspace, workspace), eq(secrets.name, name)))
      .get();
  }
}
