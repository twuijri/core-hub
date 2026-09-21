# Validation matrix

| Change touches | Run before the PR |
|---|---|
| `packages/contracts` | `pnpm contracts:lint` (OpenAPI + schemas), `pnpm contracts:generate` (all three clients regenerate with no diff left uncommitted), `pnpm test --filter contracts` |
| `packages/server` | `pnpm typecheck`, `pnpm test --filter server`, `pnpm contract:test` (every route exercised from the generated client), `pnpm lint` |
| `packages/cli` | `pnpm typecheck`, `pnpm test --filter @majlis/cli` (unit + the in-process integration test against the real server), `pnpm contracts:check-clients`, `pnpm i18n:check`, `pnpm lint`, `pnpm build` then `node packages/cli/dist/bin.js --help` |
| `packages/ui-tokens` | `pnpm --filter @majlis/ui-tokens test` (WCAG AA contrast of every declared pair in both themes and over every glass level), `pnpm tokens:build` leaves `dist/` regenerated |
| `packages/web` | `pnpm typecheck`, `pnpm test --filter @majlis/web` (navigation parity, logical CSS, i18n coverage, reducer, auth client), `pnpm contracts:check-clients`, `pnpm i18n:check`, `pnpm nav:check`, `pnpm lint`, `pnpm build`, then `pnpm web:e2e` (three Playwright journeys against the real hub; `playwright install chromium` once) |
| `docs/clients/navigation.json` | `pnpm nav:check` plus the web parity test (`pnpm test --filter @majlis/web`) |
| a module's schema | `pnpm db:generate` produces a migration; `pnpm db:migrate` on a fresh SQLite and on PostgreSQL in CI |
| any user text | `pnpm i18n:check` (ar/en parity, no missing keys) |
| the agents catalog (`modules/agents/catalog/`) | `pnpm test --filter server` — the catalog guard checks unique ids, an exact version pin and a licence on every entry (ADR 0006); the pinned versions themselves are the owner's review |
| `docs/clients/NAVIGATION.md` | the client parity tests of every existing client |
| release | `pnpm build`, Docker image builds, smoke test against the image, `/understand` regenerated and `.ua/` committed (docs/harness/knowledge-graph.md) |

Never claim a check passed without pasting its output in the change record.
