# ADR 0006 — Hermes Agent is the base; other agents are installed on demand

Status: accepted (2026-09-21)

## Context
The owner's words: "the agents are there, you install the ones you want, but
the base is Hermes". Ekko Studio treats every agent as an equal card; in
practice one runtime carries the memory, the skills, the scheduled jobs and
the messaging channels, and the others are tools you add.

## Decision
- **Hermes Agent (MIT) is always present.** The hub ships knowing how to find
  or provision it, its adapter is first-class, and the hub's own memory,
  skills, jobs and channels views are Hermes's. A hub without Hermes is
  "not configured", never "empty".
- **Coding agents are optional installs** from the `agents` registry: the
  registry lists what the hub knows (ACP-capable CLIs and harnessed CLIs),
  shows install state on the host, and installs/updates/removes on request.
  Uninstalled agents stay visible as "available", never hidden.
- Rooms, tasks and schedules can use any installed agent; defaults point
  at Hermes.

## Alternatives rejected
- All agents equal (Ekko): fragments memory/skills/jobs across runtimes and
  produced the inconsistent agent manager the owner disliked.
- Hermes only: loses the coding agents that tasks and rooms exist for.

## Consequences
- The Docker image contains the hub and the Hermes runtime only, so it stays
  small.
- Side agents come from a **curated catalog** shipped with the hub
  (`packages/server/src/modules/agents/catalog/`): the project owner approves
  each entry (id, install recipe, version pin, health check, licence). A user
  can install or remove only catalog entries — never an arbitrary agent — and
  the hub runs the install as one of its own jobs.
- Installs land in the data volume (`${DATA_DIR}/agents/<id>`), never in the
  image, and are recorded in the `agents` table with their state
  (`not_installed`, `installing`, `installed`, `failed`). They survive a
  container restart and an image rebuild; on start the hub reconciles the
  table against the volume and repairs or marks what is missing.
The Agent Manager screen has one pinned "Hermes" section and one "Coding
agents" section with install buttons. The `hermes` adapter is required for the
server to report `ready`; ACP/process adapters are optional.
