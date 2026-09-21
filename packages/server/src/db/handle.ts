/**
 * The database handle a module is allowed to see.
 *
 * `app/db.ts` owns the real instance and types it against the whole schema
 * barrel; a module must import neither (ARCHITECTURE §Modules: modules never
 * import `app/`, and never the barrel that lists every other module's
 * tables). It only ever queries its own tables, so the schema generic is
 * irrelevant to it — this alias is the narrow view it gets.
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type ModuleDatabase = BetterSQLite3Database<Record<string, unknown>>;
