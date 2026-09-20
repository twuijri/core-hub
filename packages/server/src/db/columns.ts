/**
 * Shared column helpers for every module schema.
 *
 * The schemas are written with `drizzle-orm/sqlite-core` (SQLite is the
 * default engine, ADR 0001). Every helper here maps to exactly one
 * PostgreSQL column type so the optional PostgreSQL schema can be produced
 * mechanically; the mapping is documented in `packages/server/src/db/README.md`.
 *
 *   ulid()        text(26)                    -> char(26)
 *   timestampMs() integer, epoch milliseconds -> bigint
 *   bool()        integer 0/1                 -> boolean
 *   json()        text holding JSON           -> jsonb
 *   money         integer micro-USD           -> bigint  (declared inline)
 *   enum          text + CHECK (inList)       -> text + CHECK
 *
 * Modules import this file and `ids.ts` only; they never import each other's
 * schema files (cross-module references are plain id columns, see
 * docs/domain/README.md §Ownership).
 */
import { sql, type SQL } from 'drizzle-orm';
import { integer, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { newUlid } from './ids.js';

/** A ULID column (26 chars). Used for ids and for every reference to an id. */
export const ulid = (name: string) => text(name, { length: 26 });

/** Epoch milliseconds, exposed as `Date` in TypeScript. */
export const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** 0/1 integer exposed as `boolean`. */
export const bool = (name: string) => integer(name, { mode: 'boolean' });

/** JSON stored as text; `T` is the TypeScript shape the module guarantees. */
export const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

/** `'{}'` / `'[]'` defaults for json columns, rendered literally in DDL. */
export const EMPTY_OBJECT = sql`'{}'`;
export const EMPTY_ARRAY = sql`'[]'`;

/**
 * `column IN ('a', 'b', ...)` for CHECK constraints. Values are inlined as
 * literals (not bound parameters) so Drizzle Kit can render them in DDL.
 */
export function inList(column: AnySQLiteColumn, values: readonly string[]): SQL {
  const literals = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * Columns every table carries. Global tables (no workspace scope, ADR 0005)
 * use this directly; scoped tables use `scopedColumns()`.
 *
 * `owner_id` is the user who created the row. Rows the server creates on its
 * own (adapter registry, snapshots, lockouts) carry the owner account's id.
 */
export function globalColumns() {
  return {
    id: ulid('id').primaryKey().$defaultFn(newUlid),
    ownerId: ulid('owner_id').notNull(),
    createdAt: timestampMs('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestampMs('updated_at')
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  };
}

/**
 * Columns every workspace-scoped table carries: the global set plus
 * `workspace`, the ULID of the `workspaces` row named by `X-Hub-Profile`.
 * Every query on a scoped table filters by it (invariant 3).
 */
export function scopedColumns() {
  return {
    ...globalColumns(),
    workspace: ulid('workspace').notNull(),
  };
}
