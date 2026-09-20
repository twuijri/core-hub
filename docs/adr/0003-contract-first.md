# ADR 0003 — Contract first, clients generated

Status: accepted (2026-09-21)

## Context
Our mobile apps drifted from the server twice (wrong pet routes, ignored
language field) because paths were hand-typed. Four clients cannot be kept in
step by reading.

## Decision
`packages/contracts` is the single source of truth: OpenAPI 3.1 for HTTP and
JSON Schema for realtime events. CI generates the TypeScript, Kotlin and Swift
clients and fails if a client references a path or event not in the contract.
Every contract change carries an example request and response, in Arabic
where text is user-facing, and a compatibility note.

## Consequences
Design happens in the contract file and its review, not in code. Breaking
changes are versioned (`/api/v2`) and recorded in an ADR.
