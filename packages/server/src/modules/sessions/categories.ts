/**
 * Session categories (contract decision §53): the folders of a profile's chats list.
 *
 * A category is the profile's, shared by everyone who may enter it, as the profile's sessions
 * are. Its order is `position`, kept dense (`0…n-1`) by every write here, so a client can
 * show `position` as it is and reorder with one patch per move. Moving a session in or out of
 * a category is `sessions.update` (`category_id`), which asks `require` here first.
 *
 * Separate from `store.ts` / `service.ts` so the category rules live in one file; the
 * session side (clearing `category_id` and announcing each session) is handed in by the
 * service as a callback.
 */
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ModuleDatabase } from '../../db/handle.js';
import { newUlid } from '../../db/ids.js';
import { HubError, notFound } from '../../lib/errors.js';
import { sessionCategories, sessions } from './schema.js';

/** The list is not paged (contract): a profile holds at most this many. */
export const MAX_CATEGORIES = 100;

export type CategoryRow = typeof sessionCategories.$inferSelect;

export interface CategoryScope {
  workspace: string;
  profile: string;
  userId: string;
}

export interface CategoryInput {
  name?: string | undefined;
  color?: string | null | undefined;
  position?: number | undefined;
}

/** What "the same name" means within a profile: trimmed, case ignored. */
export function nameKeyOf(name: string): string {
  return name.trim().toLocaleLowerCase('en');
}

/** Where `item` lands when moved to `to` in `ids` (past the end is the end). */
export function reorder(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((each) => each !== id);
  const at = Math.max(0, Math.min(to, rest.length));
  rest.splice(at, 0, id);
  return rest;
}

export class SessionCategories {
  constructor(private readonly db: ModuleDatabase) {}

  private rows(workspace: string): CategoryRow[] {
    return this.db
      .select()
      .from(sessionCategories)
      .where(eq(sessionCategories.workspace, workspace))
      .orderBy(asc(sessionCategories.position), asc(sessionCategories.createdAt))
      .all();
  }

  /** Conversations in each category that are not archived, for `session_count`. */
  private counts(workspaces: readonly string[]): Map<string, number> {
    if (workspaces.length === 0) return new Map();
    const rows = this.db
      .select({ categoryId: sessions.categoryId, n: count() })
      .from(sessions)
      .where(
        and(
          inArray(sessions.workspace, [...workspaces]),
          isNull(sessions.archivedAt),
          sql`${sessions.categoryId} is not null`,
        ),
      )
      .groupBy(sessions.categoryId)
      .all();
    return new Map(rows.map((row) => [row.categoryId as string, row.n]));
  }

  private toWire(row: CategoryRow, profile: string, n: number): Record<string, unknown> {
    return {
      id: row.id,
      profile,
      owner_id: row.ownerId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      name: row.name,
      color: row.color ?? null,
      position: row.position,
      session_count: n,
    };
  }

  private one(scope: CategoryScope, row: CategoryRow): Record<string, unknown> {
    return this.toWire(row, scope.profile, this.counts([scope.workspace]).get(row.id) ?? 0);
  }

  list(scope: CategoryScope): { items: Record<string, unknown>[] } {
    return this.listAcross([scope]);
  }

  /** Every profile in `scopes` (ADR 0016), each profile's categories in its own order. */
  listAcross(scopes: readonly CategoryScope[]): { items: Record<string, unknown>[] } {
    const counts = this.counts(scopes.map((scope) => scope.workspace));
    return {
      items: scopes.flatMap((scope) =>
        this.rows(scope.workspace).map((row) =>
          this.toWire(row, scope.profile, counts.get(row.id) ?? 0),
        ),
      ),
    };
  }

  /** Every session filed under `categoryId`, archived ones too. */
  sessionIdsIn(workspace: string, categoryId: string): string[] {
    return this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.workspace, workspace), eq(sessions.categoryId, categoryId)))
      .all()
      .map((row) => row.id);
  }

  /** The category, or `404` — also for another profile's (invariant 2). */
  require(workspace: string, id: string): CategoryRow {
    const row = this.db
      .select()
      .from(sessionCategories)
      .where(and(eq(sessionCategories.workspace, workspace), eq(sessionCategories.id, id)))
      .get();
    if (!row) throw notFound({ resource: 'session_category', id });
    return row;
  }

  private assertFreeName(workspace: string, key: string, except: string | null): void {
    const clash = this.db
      .select({ id: sessionCategories.id })
      .from(sessionCategories)
      .where(and(eq(sessionCategories.workspace, workspace), eq(sessionCategories.nameKey, key)))
      .get();
    if (clash && clash.id !== except) {
      throw new HubError('conflict', {
        messageKey: 'sessions.category_name_taken',
        details: { field: 'name', reason: 'name_taken' },
      });
    }
  }

  /** Writes `ids` back as positions `0…n-1`; only rows whose place changed are touched. */
  private renumber(workspace: string, ids: readonly string[], current: CategoryRow[]): void {
    const before = new Map(current.map((row) => [row.id, row.position]));
    ids.forEach((id, position) => {
      if (before.get(id) === position) return;
      this.db
        .update(sessionCategories)
        .set({ position, updatedAt: new Date() })
        .where(and(eq(sessionCategories.workspace, workspace), eq(sessionCategories.id, id)))
        .run();
    });
  }

  create(scope: CategoryScope, input: CategoryInput): Record<string, unknown> {
    const name = (input.name ?? '').trim();
    if (!name) {
      throw new HubError('validation_failed', {
        details: { issues: [{ path: 'name', message: 'required' }] },
      });
    }
    const key = nameKeyOf(name);
    const id = newUlid();
    this.db.transaction(() => {
      const current = this.rows(scope.workspace);
      if (current.length >= MAX_CATEGORIES) {
        throw new HubError('conflict', {
          messageKey: 'sessions.category_limit',
          details: { reason: 'category_limit', limit: MAX_CATEGORIES },
        });
      }
      this.assertFreeName(scope.workspace, key, null);
      this.db
        .insert(sessionCategories)
        .values({
          id,
          workspace: scope.workspace,
          ownerId: scope.userId,
          name,
          nameKey: key,
          color: input.color ?? null,
          position: current.length,
        })
        .run();
      if (input.position !== undefined && input.position < current.length) {
        const ids = reorder([...current.map((row) => row.id), id], id, input.position);
        this.renumber(scope.workspace, ids, [...this.rows(scope.workspace)]);
      }
    });
    return this.one(scope, this.require(scope.workspace, id));
  }

  update(scope: CategoryScope, id: string, input: CategoryInput): Record<string, unknown> {
    this.db.transaction(() => {
      const row = this.require(scope.workspace, id);
      const changes: Partial<CategoryRow> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) {
          throw new HubError('validation_failed', {
            details: { issues: [{ path: 'name', message: 'must not be blank' }] },
          });
        }
        const key = nameKeyOf(name);
        this.assertFreeName(scope.workspace, key, row.id);
        changes.name = name;
        changes.nameKey = key;
      }
      if (input.color !== undefined) changes.color = input.color;
      if (Object.keys(changes).length > 0) {
        this.db
          .update(sessionCategories)
          .set({ ...changes, updatedAt: new Date() })
          .where(
            and(eq(sessionCategories.workspace, scope.workspace), eq(sessionCategories.id, id)),
          )
          .run();
      }
      if (input.position !== undefined) {
        const current = this.rows(scope.workspace);
        const ids = reorder(
          current.map((each) => each.id),
          id,
          input.position,
        );
        this.renumber(scope.workspace, ids, current);
      }
    });
    return this.one(scope, this.require(scope.workspace, id));
  }

  /**
   * Removes the category and closes the gap it leaves. `release` is the session side: it
   * clears `category_id` on every session in it and announces each one. It runs after the
   * row is gone, so a list refetched in between never shows a category that no longer
   * exists as the home of a session.
   */
  remove(scope: CategoryScope, id: string, release: (categoryId: string) => void): void {
    this.db.transaction(() => {
      this.require(scope.workspace, id);
      this.db
        .delete(sessionCategories)
        .where(and(eq(sessionCategories.workspace, scope.workspace), eq(sessionCategories.id, id)))
        .run();
      const current = this.rows(scope.workspace);
      this.renumber(
        scope.workspace,
        current.map((row) => row.id),
        current,
      );
    });
    release(id);
  }
}
