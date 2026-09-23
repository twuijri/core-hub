#!/usr/bin/env node
// The committed code map is the one this tree builds (docs/harness/knowledge-graph.md).
//
// Run after `pnpm graph` on a clean checkout: it compares the graph.json committed in
// HEAD with the one just built. Graphify reads code with tree-sitter and no model, so the
// nodes and edges are the same on every machine and any difference means somebody changed
// code without rebuilding the map. Left out of the comparison: the commit the map was built
// from (always the parent of the commit that carries it), and the communities — Graphify
// clusters in the order the file system lists files, which differs between machines.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = 'graphify-out/graph.json';

function load(text, where) {
  try {
    const graph = JSON.parse(text);
    delete graph.built_at_commit;
    graph.nodes = graph.nodes
      .map(({ community: _c, community_name: _n, ...node }) => node)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    graph.links = graph.links
      .map((link) =>
        !graph.directed && link.source > link.target
          ? { ...link, source: link.target, target: link.source }
          : link,
      )
      .map((link) => JSON.stringify(link))
      .sort();
    return graph;
  } catch (error) {
    console.error(`graph:check  ${where} is not a graph: ${error.message}`);
    process.exit(1);
  }
}

let committedText;
try {
  committedText = execFileSync('git', ['show', `HEAD:${FILE}`], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
} catch {
  console.error(
    `graph:check  ${FILE} is not committed. Run \`pnpm graph\` and commit graphify-out/.`,
  );
  process.exit(1);
}
const committed = load(committedText, `HEAD:${FILE}`);
const built = load(readFileSync(FILE, 'utf8'), FILE);

// A map must not carry a path from the machine that built it: Graphify names an import of a
// file it did not scan after its absolute path, and `scripts/graph.mjs` (`pnpm graph`)
// is what rewrites it.
const local = /(^|_)(home|users|tmp|private|var)_[a-z0-9_]*_/;
const leaked = committed.nodes.filter(
  (node) => node.type === 'external' && local.test(String(node.id)),
);
if (leaked.length > 0) {
  console.error(
    `graph:check  the committed map carries paths from the machine that built it:\n` +
      leaked.map((node) => `             ${node.id}`).join('\n') +
      '\n             Run `pnpm graph` (not plain `graphify update .`) and commit graphify-out/.',
  );
  process.exit(1);
}

const same = JSON.stringify(committed) === JSON.stringify(built);
if (!same) {
  const count = (graph) => `${graph.nodes?.length ?? 0} nodes, ${graph.links?.length ?? 0} edges`;
  console.error(
    `graph:check  the committed map is stale (committed: ${count(committed)}; this tree: ${count(built)}).\n` +
      '             Run `pnpm graph` and commit graphify-out/ with your change.',
  );
  process.exit(1);
}
console.log(`graph:check  OK — ${built.nodes.length} nodes, ${built.links.length} edges, current`);
