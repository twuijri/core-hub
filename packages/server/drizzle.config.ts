import { defineConfig } from 'drizzle-kit';

// Drizzle Kit reads the schema barrel src/db/schema.ts (one re-export per module; a module owns
// its tables, ARCHITECTURE §Modules) and writes SQL migrations to ./drizzle. `pnpm db:generate` / `pnpm db:migrate` wrap this so
// they are no-ops until the first schema exists (see scripts/db.mjs).
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  ...(url
    ? { dialect: 'postgresql', dbCredentials: { url } }
    : {
        dialect: 'sqlite',
        dbCredentials: { url: `${process.env.DATA_DIR ?? './data'}/hub.sqlite` },
      }),
  strict: true,
  verbose: true,
});
