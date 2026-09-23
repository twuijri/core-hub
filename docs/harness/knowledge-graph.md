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
  map can be committed and a workflow can tell whether it is current.
- **One map for every assistant.** The skill is installed in the repository for
  Claude Code (`.claude/`) and Codex (`.codex/`, `AGENTS.md`); whoever clones the
  repository gets the map and the instructions to use it.

## Setup (once per machine)
```bash
uv tool install graphifyy==0.9.66   # the CLI; the package name has two y's
```
Do **not** run `graphify hook install` here: its hooks run plain `graphify update .` after
every commit, which brings back what `pnpm graph` takes out (below).
Use the pinned version: CI builds with it, and another version may build a
different map. `uv` itself: <https://docs.astral.sh/uv/>.

## What is committed, and by whom
`graphify-out/graph.json` (the map), `GRAPH_REPORT.md` (communities, hubs, suggested
questions), `graph.html` (open it in a browser) and the community labels. Not
committed: `cache/` and `manifest.json` (file times on one machine) — a rebuild takes
seconds. `.graphifyignore` leaves out what would drown the code: the per-event JSON
schemas under `packages/contracts/events/` and the test screenshots.

**Only the code-map bot commits `graphify-out/`** (owner decision, 2026-09-23; change record
`docs/changes/2026-09-23-twuijri-code-map-bot.md`). Pull requests do not carry it: `graph.json`
changes almost entirely with any code change, so when every PR carried a rebuilt map, each
merge made every other open PR conflict in `graphify-out/` alone. The map in `main` may lag
`main`'s code by a merge or two; that is the accepted price.

## Working with it
- **Before reading files across modules**, ask the map:
  `graphify query "<question>"`, `graphify path "<A>" "<B>"`,
  `graphify explain "<concept>"`, `graphify affected "<symbol>"`.
- **For your own use**, `pnpm graph` after a pull or while you work: it rebuilds the map in
  your checkout so queries see your change. **Do not commit `graphify-out/`**: leave it
  unstaged, or put `main`'s copy back before you commit
  (`git restore --source=origin/main --staged --worktree -- graphify-out`).
- **A PR that changes `graphify-out/`** fails the CI job *PR leaves graphify-out/ to the
  code-map bot*; the command above fixes it. An older branch that still carries map commits
  conflicts once more in `graphify-out/`: resolve by taking `main`'s side.

## The code-map bot
Workflow `.github/workflows/code-map.yml` runs on every push to `main` (and by hand,
`workflow_dispatch`). Only the newest run survives (`concurrency`). It installs the pinned
Graphify on a clean checkout, runs `pnpm graph`, then `pnpm graph:check`, which compares the
built `graph.json` with the one committed in `main` (nodes and edges only: it leaves out
`built_at_commit` and the communities).
- **Stale:** it commits `graphify-out/` (`chore(graph): update code map`) on a fresh
  `bot/code-map` branched from that `main` commit, force-pushes that branch only, and opens —
  or updates — the single PR **"Update the code map"**. The owner merges it like any PR.
  A newer merge replaces it with a map of the newer `main`.
- **Current:** it closes an open bot PR, if any.

**Why it starts the checks itself.** GitHub starts no `pull_request` (or `push`) workflow for
a push or a PR made with the workflow's `GITHUB_TOKEN`, so the required checks would never
report on the bot's commit and the PR could not be merged. `workflow_dispatch` is the
exception, so `ci.yml` and `change-record.yml` accept it and the bot starts both on
`bot/code-map`; their check runs carry the required names and land on the bot's commit.
`scripts/check-change-record.mjs` exempts a change set that touches `graphify-out/` and
nothing else — the bot PR has no task to record. The CI job *PR leaves graphify-out/ to the
code-map bot* fails any other PR that changes `graphify-out/`.

**One-time repository setting.** `GITHUB_TOKEN` may open a PR only when *Settings → Actions
→ General → Workflow permissions → Allow GitHub Actions to create and approve pull requests*
is on. Without it the bot still pushes `bot/code-map` and fails with that instruction.

`pnpm graph:check` stays useful locally: after `pnpm graph`, it says whether `main`'s map is
behind the code in your checkout (on a branch with code changes it is, by design).

**Why `pnpm graph` (`scripts/graph.mjs`) and not plain `graphify update .`:**
- Graphify resolves imports through whatever is on disk, so a checkout with
  `node_modules` and built packages (`dist/`, the generated contract client) gets nodes a
  fresh clone does not (26 of them, the first time CI checked). The script builds in a
  temporary copy of the files git tracks plus new files it does not ignore — the change
  being made, committed or not, and nothing a build left behind.
- Graphify names an import whose target it did not scan — the generated contract client,
  which is git-ignored — after its *absolute* path (`home_<user>_<checkout>_packages_…`).
  The script rewrites those names to the root-relative form every other node has, and
  takes the checkout's folder name and the date out of the report's title, so every
  machine builds the same map. `pnpm graph:check` refuses a map that still carries such a
  path.
- `graphify update .` merges into the `graph.json` it finds and keeps what it did not
  extract this time, so the renamed node would come back twice. The copy has no map, so
  every build is from scratch; with no model involved that takes about five seconds.
- A commit made by the bot is built on a clean CI checkout, so what it proposes is what any
  fresh clone would build.

## Rule for agents
Before a change that spans more than one module, query the map for those modules and
cite what it showed in the change record under «القرار». `docs/` stays the source of
truth for intent (ADRs, contracts, navigation); the map is what the code does today.
If they disagree, fix the code or the doc — the map follows the code.
