# Majlis (مجلس)

Majlis is a self-hosted hub that puts every AI agent you use in one place:
chat with an agent, put several agents in one room, hand agents work in Tasks
(a kanban-style section), schedule work, and reach all of it from the web,
the desktop and your phone. The server is the product; every client is a
thin, native surface over one documented contract.

This repository is built from scratch and is owned by twuijri. It borrows
*ideas* from open projects (see `docs/inspirations/`) and never copies their
code. The agent runtime it drives first is [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(MIT); coding agents connect through the Agent Client Protocol (ACP) or a
process harness.

Read in this order:

1. `AGENTS.md` — the one-page map every human or AI contributor reads first.
2. `docs/ARCHITECTURE.md` — what the system is, its boundaries, and the rules
   that keep it coherent.
3. `docs/adr/` — every decision that shaped it, with the alternatives rejected.
4. `docs/contracts/` — the API and realtime contract that all clients follow.
5. `docs/clients/NAVIGATION.md` — the one navigation map for web, desktop and
   phones.
6. `docs/TEAM-RULES.md` — how work is done, reviewed, merged and released.
7. `docs/ROADMAP.md` — the phases, in order, with what "done" means for each.
8. `docs/STATUS.md` — what is implemented today and what still answers 501.
9. `docs/DEVELOPMENT.md` — running the hub and the clients locally, and the
   checks to run before a PR.
10. `docs/clients/DESIGN.md` — the look every client shares, and why it is
    only partly glass.

Status: Phase 0 is done — the hub runs, Hermes runs inside its image, and a
message reaches it; the web and terminal clients talk to it. 64 of the 245
contract operations are implemented and the rest answer `501` honestly.
`docs/STATUS.md` has the module-by-module table; `docs/ROADMAP.md` has what
comes next; `docs/DEVELOPMENT.md` is how to run it locally.
