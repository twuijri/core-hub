# ADR 0007 — Every client is built from scratch on the contract

Status: accepted (2026-09-21)

## Context
The owner has an earlier pair of native phone apps (MIT, his own) and the
Hermes Studio fork's desktop shell. Reusing them would drag their shapes and
bugs into Majlis and couple the new server to old clients.

## Decision
- Web, desktop, Android and iOS clients for Majlis are new code, generated
  from `packages/contracts` and implementing `docs/clients/NAVIGATION.md`.
- The earlier apps are **behaviour references only** (what a screen shows),
  never a source of code, of API shapes or of constraints on the server.
- The server is never adjusted to fit an old client. Phase 0 is verified with
  a reference client inside this repository (`packages/cli` — a small terminal
  client generated from the contract), not with the old apps.

## Consequences
Phase 0's "done" changes: pairing, agents and a streamed session are proven
with the in-repo reference client. The phone apps arrive in their own phases
with the same navigation manifest and parity tests as the web client.
