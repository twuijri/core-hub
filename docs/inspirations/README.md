# Inspirations ledger

Every idea we took, where from, its licence, and what we did differently.
Ideas are free; code is not (ADR 0004). One file per source project (in
Arabic, with the project's own terms kept in English). Licences below are
verified from each project's `LICENSE` file, not from badges (2026-09-21).
Capability comparison: `FEATURE-MATRIX.md`.

| Project | Licence | What we took | Page |
|---|---|---|---|
| Hermes Studio / Ekko Studio (the fork we run today) | BSL 1.1 — **no code** (source deliberately not opened) | the feature set: agent manager, multi-agent rooms, workflows, device pairing, computer apps; and the navigation mistakes we avoid | `hermes-studio.md` |
| Hermes Agent (the runtime we drive) | MIT | its gateway/API surface, sessions, memory, skills, jobs and messaging channels as the input for our `hermes` adapter | `hermes-agent.md` |
| clawboard | MIT | harness-agnostic board with a documented REST/OpenAPI + CLI surface; projects, journal, knowledge, plugins; review gate; signed webhooks | `clawboard.md` |
| AionUi | Apache-2.0 | ACP as the universal agent connector; auto-detecting installed CLIs; detected engine vs. assistant config; custom assistants | `aionui.md` |
| Vibe Kanban | Apache-2.0 (project is sunsetting) | one worktree per task, task attempts, parallel agent runs from a board | `vibe-kanban.md` |
| Multica | Multica License = Apache-2.0 text + Part I conditions (no hosted/embedded commercial use without a commercial licence, UI branding must stay, attribution for backend use) — **no code** | assign issues to agents like teammates; run state machine; scheduled standups (autopilots); execution logs with cost | `multica.md` |
| Proliferate | AGPL-3.0 — **no code** | frozen workflow invocations; human-in-loop nodes; subagent laws; budget envelopes | `proliferate.md` |
| agenthub | Apache-2.0 | structured, replayable ACP timelines; remote execution nodes; task/attempt/run vocabulary | `agenthub.md` |
| Claw-Kanban | Apache-2.0 | role-based auto-assignment of tasks to agents; fail-closed runs; chat-to-card | `claw-kanban.md` |
| Hubcode | AGPL-3.0 — **no code** (repo located 2026-09-21 at github.com/hubtool/hubcode; the earlier "repo not located" entry was wrong) | shared live sessions with voice; kanban per worktree; worker+verifier loops | `hubcode.md` |
