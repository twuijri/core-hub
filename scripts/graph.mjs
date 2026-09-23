#!/usr/bin/env node
// `pnpm graph`: build Graphify's map of this repository, the same on every machine
// (docs/harness/knowledge-graph.md).
//
// - From scratch. `graphify update .` merges into the graph.json it finds, and keeps nodes
//   it did not extract this time; a committed map would then carry the renamed node below
//   twice. Code is parsed locally with no model, so a full build takes seconds.
// - With root-relative names only. Graphify names an import whose target it did not scan (a
//   git-ignored file, such as the generated contract client) after the *absolute* path:
//   `home_<user>_<checkout>_packages_…`. That would put the builder's home directory in a
//   committed file and make every machine's map differ; it is rewritten to the
//   root-relative form every other node already has.
// - With the checkout's folder name and the date out of the report's title.
// - In one canonical order (see `canonical` below).
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'graphify-out';

rmSync(`${OUT}/graph.json`, { force: true });
const build = spawnSync('graphify', ['update', '.'], { stdio: 'inherit' });
if (build.error || build.status !== 0) {
  console.error(
    build.error?.code === 'ENOENT'
      ? 'graph  Graphify is not installed: uv tool install graphifyy==0.9.66'
      : 'graph  graphify update failed',
  );
  process.exit(1);
}

const root = `${process
  .cwd()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')}_`;
for (const file of ['graph.json', 'graph.html']) {
  const path = `${OUT}/${file}`;
  const text = readFileSync(path, 'utf8');
  const next = text.split(root).join('');
  if (next !== text) writeFileSync(path, next);
}
const graphFile = `${OUT}/graph.json`;
const graph = JSON.parse(readFileSync(graphFile, 'utf8'));
writeFileSync(graphFile, `${JSON.stringify(canonical(graph), null, 2)}\n`);

const report = `${OUT}/GRAPH_REPORT.md`;
writeFileSync(
  report,
  readFileSync(report, 'utf8').replace(/^# Graph Report - .*$/m, '# Graph Report - majlis'),
);

/** Nodes by id, and each undirected edge with its ends in order, then edges in order. */
function canonical(graph) {
  const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const links = graph.links
    .map((link) =>
      !graph.directed && link.source > link.target
        ? { ...link, source: link.target, target: link.source }
        : link,
    )
    .map((link) => [JSON.stringify(link), link])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, link]) => link);
  return { ...graph, nodes, links };
}
