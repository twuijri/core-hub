# ADR 0002 — How agents connect

Status: accepted (2026-09-21)

## Context
Ekko Studio wires each agent by hand. AionUi showed that the Agent Client
Protocol (ACP) lets one adapter drive twenty CLIs. Hermes Agent has its own
gateway API and messaging surfaces.

## Decision
One interface, `AgentAdapter` (`discover`, `start`, `send`, `stream`,
`interrupt`, `capabilities`, `settings`), with three implementations:
1. **ACP adapter** — any agent that speaks ACP over stdio; auto-detected on
   the host like AionUi does.
2. **Hermes adapter** — talks to Hermes Agent's gateway for sessions, memory,
   skills, jobs and its messaging channels.
3. **Process harness** — for CLIs without ACP: a PTY, a transcript parser and
   a capability whitelist. Last resort, clearly marked "limited" in the UI.

Rooms, tasks and schedules only ever see `AgentAdapter`.

## Alternatives rejected
- Per-agent bespoke integration (Ekko's way): the reason its agent manager
  grew inconsistent.
- MCP as the only bridge: MCP exposes tools to agents, not agents to a hub.

## Consequences
Adding an agent is one adapter file plus a registry entry. The agent list in
every client is the server's registry, never a hardcoded list.
