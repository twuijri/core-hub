import { defineConfig } from 'vitest/config';

// `pnpm test --filter @corehub/server` runs the unit project (one test per module lives next
// to the module); `pnpm contract:test` runs every OpenAPI operation against the app.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
          // These are unit tests of modules, but most of them boot a whole hub: Fastify, a
          // fresh SQLite file with every migration, and Argon2id at 19 MiB per password. On a
          // loaded machine (or a CI runner) several of those in parallel routinely pass 5 s,
          // vitest's default, which showed up as a different file timing out on every run.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          include: ['tests/contract/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
