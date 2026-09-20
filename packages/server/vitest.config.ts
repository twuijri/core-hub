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
