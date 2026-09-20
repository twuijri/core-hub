# ADR 0005 — Workspaces (profiles) are a filter, not a tree

Status: accepted (2026-09-21)

## Context
Users keep separate agent configurations ("profiles"): work, personal,
experiments. Ekko treats the profile as an ambient filter; that worked well.

## Decision
A workspace is a named scope with its own agents' settings, models, sessions,
rooms, board and schedules. Every request carries `X-Hub-Profile`; the server
filters everything by it. Switching workspace in a client changes the header
and refetches; it never navigates.

## Consequences
No cross-workspace joins in the domain. Admin-only screens (users, updates,
audit) are global and say so.
