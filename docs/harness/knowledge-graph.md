# Knowledge graph (Graphify)

We keep a map of the code base in the repository with
[Graphify](https://github.com/Graphify-Labs/graphify) (Apache-2.0). It is a
**developer aid only**: never a runtime dependency, never imported by the product,
never part of the build or the image. It replaced Understand-Anything on
2026-09-23 (owner decision; change record
`docs/changes/2026-09-23-twuijri-graphify-map.md`).

## Why Graphify
- **Code costs nothing to map.** Code is parsed locally with tree-sitter: no model,
  no tokens, nothing leaves the machine. The map of this repository builds in
  about five seconds.
- **Deterministic.** The same tree gives the same `graph.json`, byte for byte, so the
  map can be committed and CI can check that it is current.
- **One map for every assistant.** The skill is installed in the repository for
  Claude Code (`.claude/`) and Codex (`.codex/`, `AGENTS.md`); whoever clones the
  repository gets the map and the instructions to use it.

## Setup (once per machine, once per clone)
```bash
uv tool install graphifyy==0.9.66   # the CLI; the package name has two y's
graphify hook install               # once per clone: rebuild on commit/checkout + merge driver
```
Use the pinned version: CI builds with it, and another version may build a
different map. `uv` itself: <https://docs.astral.sh/uv/>.

## What is committed
`graphify-out/graph.json` (the map), `GRAPH_REPORT.md` (communities, hubs, suggested
questions), `graph.html` (open it in a browser) and the community labels. Not
committed: `cache/` and `manifest.json` (file times on one machine) — a rebuild takes
seconds. `.graphifyignore` leaves out what would drown the code: the per-event JSON
schemas under `packages/contracts/events/` and the test screenshots.

## Working with it
- **Before reading files across modules**, ask the map:
  `graphify query "<question>"`, `graphify path "<A>" "<B>"`,
  `graphify explain "<concept>"`, `graphify affected "<symbol>"`.
- **Before you commit a code change**, `pnpm graph` (`graphify update .`, then `scripts/graph-portable.mjs`) and commit
  `graphify-out/` with it. The hook does this after a commit too, which leaves the
  next commit to carry it; running it yourself keeps each commit whole.
- **After a pull or a merge**, `pnpm graph`.
- **A conflict in `graph.json`** is not resolved by hand: the merge driver unions the
  two maps; without it, take either side and run `pnpm graph`.

## The check
CI job *Code map is current* installs the pinned Graphify on a clean checkout of the
PR's head, runs `pnpm graph` and `pnpm graph:check`, which compares the built
`graph.json` with the committed one (leaving out `built_at_commit`). A stale map fails
the PR with the command that fixes it.

**Why `pnpm graph` and not plain `graphify update .`:** Graphify names an import whose
target it did not scan — the generated contract client, which is git-ignored — after its
*absolute* path (`home_<user>_<checkout>_packages_…`). `scripts/graph-portable.mjs`
rewrites those names to the root-relative form every other node has, and takes the
checkout's folder name and the date out of the report's title, so every machine builds
the same map. `pnpm graph:check` refuses a map that still carries such a path.

## Rule for agents
Before a change that spans more than one module, query the map for those modules and
cite what it showed in the change record under «القرار». `docs/` stays the source of
truth for intent (ADRs, contracts, navigation); the map is what the code does today.
If they disagree, fix the code or the doc — the map follows the code.
