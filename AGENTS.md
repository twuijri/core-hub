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
- `.ua/knowledge-graph.json` (when present) — the generated map of the code; use `/understand-explain` before touching more than one module. See `docs/harness/knowledge-graph.md`.

## Layout
- `packages/contracts` — OpenAPI + realtime event schemas + generated clients.
- `packages/server` — the hub (TypeScript, Fastify, Socket.IO, Drizzle).
- `packages/web` — the web client (later phase).
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
- Never commit secrets, hostnames of the owner's servers, or third-party code.
- When stuck, improve the harness (docs, tests, scripts, CI) instead of
  repeating the same attempt.
