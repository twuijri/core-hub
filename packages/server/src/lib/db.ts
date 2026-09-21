// The database handle a module works with. Modules never import app/ (ARCHITECTURE §Modules);
// they take `app.hub.database` at registration time and narrow it here. Only SQLite is wired
// end to end today (src/db/README.md §PostgreSQL option), so a module asks for the SQLite
// handle and fails loudly otherwise instead of silently running against an unmigrated engine.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/** A Drizzle handle usable with any module's own tables (query builder API, no relational schema). */
export type ModuleDb = BetterSQLite3Database<Record<string, unknown>>;

export function requireSqlite(database: { kind: string; db: unknown }): ModuleDb {
  if (database.kind !== 'sqlite') {
    throw new Error(
      `database kind "${database.kind}" is not supported by the modules yet (packages/server/src/db/README.md)`,
    );
  }
  return database.db as ModuleDb;
}
