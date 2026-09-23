#!/usr/bin/env node
// The committed code map is the one this tree builds (docs/harness/knowledge-graph.md).
//
// Run after `graphify update .` on a clean checkout: it compares the graph.json committed in
// HEAD with the one just built. Graphify is deterministic for code (tree-sitter, no model),
// so any difference means somebody changed code without rebuilding the map. The commit the
// map was built from is left out: it is always the parent of the commit that carries it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = 'graphify-out/graph.json';

function load(text, where) {
  try {
    const graph = JSON.parse(text);
    delete graph.built_at_commit;
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
