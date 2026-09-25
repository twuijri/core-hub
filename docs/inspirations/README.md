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
| shadcn/ui | MIT — **no code** (the way of working, not the files) | own the component files in your own repository, Radix for behaviour, one styling layer you control | `shadcn-ui.md` |
| assistant-ui | MIT — **no code, not adopted** (2026-09-22) | the external-store runtime shape (`onNew` + `isRunning` + `onCancel`) as proof our server-owned run model is a normal one; the server-side approval gate vocabulary | `assistant-ui.md` |
| Hubcode | AGPL-3.0 — **no code** (repo located 2026-09-21 at github.com/hubtool/hubcode; the earlier "repo not located" entry was wrong) | shared live sessions with voice; kanban per worktree; worker+verifier loops | `hubcode.md` |
| DeepSeek harness (owner's description only, 2026-09-25) | unknown — **no code, no assets, no text** (nothing opened) | the idea of a per-conversation "Trajectory" tab: steps on a timeline with performance metrics | `trajectory.md` |
| Claude's "Background tasks" panel (owner's description only, 2026-09-25) | proprietary product — **no code, no assets, no text** (nothing opened) | the idea of seeing an agent's running subagents and every background job in one place, with a way to stop them | `subagents-background.md` |

## ما نأخذه ومتى
`ADOPTION-BACKLOG.md` يجمع كل فكرة قررنا أخذها، مرتَّبة بمرحلتها من
`docs/ROADMAP.md`. أي فكرة جديدة من أي مشروع تُسجَّل هناك قبل أن تُبنى.
