# Agent Map — Core Hub

This file is the short map for coding agents and new contributors. Keep it
small; details live in `docs/`.

## What this is
A from-scratch, self-hosted hub for AI agents, owned by twuijri. Server first;
web, desktop, Android and iOS are clients of one contract. Nothing here is
derived from Hermes Studio / Ekko Studio code (BSL 1.1). See
`docs/adr/0004-clean-room.md` — it is a hard rule, not guidance.

## First reads (in order)
- `docs/ARCHITECTURE.md` — system, boundaries, invariants.
- `docs/adr/` — decisions. Do not re-litigate a decision in a PR; write a new
  ADR that supersedes it.
- `docs/contracts/README.md` — the API/realtime contract is the source of
  truth; clients are generated from it, never hand-typed.
- `docs/clients/NAVIGATION.md` — the navigation map all clients implement.
- `docs/TEAM-RULES.md` — branch, record, check, PR, merge, release.
- `docs/harness/validation.md` — which checks to run for which change.
- `docs/STATUS.md` — what is built and what is still a 501 stub; read it
  before claiming anything works.
- `docs/DEVELOPMENT.md` — run the hub, the web client and the checks locally.
- `docs/clients/DESIGN.md` — the shared look: chat-centric, glass only on
  floating chrome, drag and drop only where it means something.
- `graphify-out/` — the committed map of the code (Graphify). Query it before reading files across modules; `pnpm graph` rebuilds it locally for you, but never commit it: the code-map bot opens "Update the code map" after each merge into `main`. See `docs/harness/knowledge-graph.md`.

## Layout
- `packages/contracts` — OpenAPI + realtime event schemas + generated clients.
- `packages/server` — the hub (TypeScript, Fastify, Socket.IO, Drizzle).
- `packages/cli` — the reference terminal client, generated from the contract; proves Phase 0 (ADR 0007). `docs/clients/CLI.md`.
- `packages/ui-tokens` — design tokens (`tokens.json` → CSS variables + types); WCAG contrast test.
- `packages/web` — the web client (Vite + React), one screen per navigation destination; served by the hub from `/`.
- `apps/desktop`, `apps/android`, `apps/ios` — native shells (later phases).
- `docs/` — everything a contributor needs; `docs/changes/` — one record per task.

## Hard rules
- Server code lives in a module under `packages/server/src/modules/<domain>`;
  modules talk through their public `index.ts` only; composition happens in
  `packages/server/src/app/`. See `docs/ARCHITECTURE.md` §Modules.
- Every endpoint and every realtime event is declared in `packages/contracts`
  before it is implemented. A PR that adds one without the contract fails CI.
- Every user-facing string exists in Arabic and English, and every screen's
  entry label equals its title (`docs/clients/NAVIGATION.md`).
- One task = one branch from `main` + one change record in `docs/changes/` +
  green checks + a PR. Only the owner merges to `main`. No auto-merge by agents.
- Observe before you invent (ADR 0012): run the product being learned from,
  read its screens and traffic, write a specification in our words — then
  implement from the specification, not from anyone's source.
- Clients are built from scratch on the contract (ADR 0007); the owner's
  earlier apps are behaviour references only, never code or constraints.
- Never commit secrets, hostnames of the owner's servers, or third-party code.
- When stuck, improve the harness (docs, tests, scripts, CI) instead of
  repeating the same attempt.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- The map is committed by the code-map bot only (`.github/workflows/code-map.yml`), after each merge into `main`. Do not commit `graphify-out/` in a PR: CI fails a PR that changes it. The map in `main` may lag the code by a merge or two.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `pnpm graph` (not plain `graphify update .`: see `docs/harness/knowledge-graph.md`) to keep your local graph current (AST-only, no API cost); leave the result unstaged.
