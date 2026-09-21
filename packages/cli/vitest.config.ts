import { defineConfig } from 'vitest/config';

// Unit tests (argument parsing, config store, rendering) run in milliseconds; the
// integration test boots the real server in-process and gets a longer timeout.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
