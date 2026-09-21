/**
 * The whole database schema, one re-export per module.
 *
 * This file exists for Drizzle Kit (migrations) and for `app/` (the single
 * `drizzle()` instance). Modules never import it: a module sees only its own
 * `schema.ts` and references other modules' rows by id through their public
 * `index.ts` (ARCHITECTURE §Modules, invariant 1).
 *
 * Export names are unique across modules; adding a module means adding one
 * line here and one entry in docs/domain/README.md.
 */
export * from '../modules/auth/schema.js';
export * from '../modules/agents/schema.js';
export * from '../modules/sessions/schema.js';
export * from '../modules/rooms/schema.js';
export * from '../modules/tasks/schema.js';
export * from '../modules/schedules/schema.js';
export * from '../modules/knowledge/schema.js';
export * from '../modules/models/schema.js';
export * from '../modules/devices/schema.js';
export * from '../modules/notify/schema.js';
export * from '../modules/updates/schema.js';
export * from '../modules/audit/schema.js';
export * from '../modules/plugins/schema.js';
