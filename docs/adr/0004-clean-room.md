# ADR 0004 — Clean room

Status: accepted (2026-09-21)

## Context
The owner runs a personal fork of Hermes Studio (BSL 1.1: non-commercial only
until 2029-05-10). Core Hub must be usable commercially and must not be a
derivative work of that code base.

## Decision
- No file, function, string table, asset, schema or configuration is copied
  from Hermes Studio / Ekko Studio, nor from the owner's fork of it.
- Ideas, feature lists, user flows and API *shapes we choose ourselves* are
  fine; they are not protected. Where an idea came from is recorded in
  `docs/inspirations/` with the source project's licence.
- Code from MIT/Apache-2.0 projects may be reused only as a whole file with
  its notice kept, listed in `THIRD-PARTY-NOTICES.md`, and only when an ADR
  says why writing it ourselves was worse.
- Contributors working in this repository do not have the Studio source open
  in the same task. AI agents are instructed the same way in every brief.

## Consequences
Slower first weeks, no licence exposure. A review checklist item asks "was any
Studio source consulted for this change?" and the answer must be no.
