# Knowledge graph (Understand-Anything)

We use [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
(MIT, a Claude Code plugin) to keep a living map of the code base as it grows.
It is a **developer aid only**: never a runtime dependency, never imported by
the product, never required to build or test.

## What it produces
`/understand` analyses the repository with a multi-agent pipeline and writes
`.ua/knowledge-graph.json` (files, functions, classes, dependencies, plain
summaries, guided tours, a domain view). `/understand-dashboard` opens it;
`/understand-chat` and `/understand-explain` answer questions from it;
`/understand-diff` shows what a change touches.

## When it is regenerated
- At the end of every phase in `docs/ROADMAP.md`, before the tag.
- Before onboarding a new AI session to a large change (run
  `/understand-diff` first, `/understand` incrementally if stale).
- Not on every PR: the first run on a large tree costs many tokens; later
  runs are incremental.

## Where it lives
`.ua/` is committed so that any machine and any session sees the same map.
`docs/` stays the source of truth for intent (ADRs, contracts, navigation);
the graph is the source of truth for *what the code actually does today*.
If they disagree, fix the code or the doc, never the graph.

## Rule for agents
Before a change that spans more than one module, read the graph's summary of
those modules (`/understand-explain <module>`) and cite it in the change
record under «القرار».
