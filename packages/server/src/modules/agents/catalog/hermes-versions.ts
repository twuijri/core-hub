/**
 * The two Hermes releases the hub is proven against (DECISIONS §119 and §132).
 *
 * - `HERMES_FLOOR` — the oldest Hermes the hub is known to work with. A person's own older
 *   Hermes still runs; its card says so (`AgentInstall.below_minimum`).
 * - `HERMES_TESTED` — the release the image carries (`packages/server/Dockerfile`
 *   `HERMES_REF`, kept equal by `scripts/hermes-watch.test.mjs`). A person's own Hermes newer than this
 *   is said on its card (`AgentInstall.tested_version`, `newer_than_tested`).
 *
 * CI runs every `*.real.test.ts` against both (`.github/workflows/ci.yml`, job `hermes-real`),
 * and the Hermes watch (`.github/workflows/hermes-watch.yml`, `scripts/hermes-watch.mjs`) runs
 * them against any newer Hermes release and proposes moving `HERMES_TESTED` to it by pull request.
 * `scripts/hermes-watch.mjs` reads and rewrites these two lines: keep each on one line, in this
 * shape.
 */
export const HERMES_FLOOR = { ref: 'v2026.9.14', version: '0.21.3' } as const;
export const HERMES_TESTED = { ref: 'v0.21.6', version: '0.21.6' } as const;
