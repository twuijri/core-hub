# ADR 0001 — Server stack

Status: accepted (2026-09-21)

## Context
The first client set already exists (native Android and iOS, MIT, owned by us)
and speaks REST + Socket.IO. Hermes Agent is Python; coding agents speak ACP
(JSON-RPC over stdio). The team is one owner plus AI agents; the deployment
target is a single Docker container on the owner's host, with PostgreSQL as an
option for shared installs.

## Decision
- TypeScript on Node 24, **Fastify** for HTTP, **Socket.IO** for realtime,
  **Drizzle ORM** with SQLite (default) and PostgreSQL (optional), **zod** for
  runtime validation generated from the contract, **pnpm** workspaces.
- One process, one container, one data directory. Optional workers later.

## Alternatives rejected
- Koa/Express: no schema-first typing; Fastify's JSON-schema routes match our
  contract-first rule.
- Python server: would sit closer to Hermes but far from the generated
  TypeScript/Kotlin/Swift clients and the web client.
- PostgreSQL only: too heavy for a one-box personal install; SQLite first.

## Consequences
Contract types flow from OpenAPI into Fastify route schemas; no route exists
without a schema. A migration tool (Drizzle Kit) is part of the release.
