#!/usr/bin/env node
// `pnpm graph`: build Graphify's map of this repository, the same on every machine
// (docs/harness/knowledge-graph.md).
//
// - From the repository's own files only. Graphify resolves imports through whatever is on
//   disk, so a checkout with `node_modules` and built packages (`dist/`, the generated
//   contract client) gets nodes a fresh clone does not. The map is built in a temporary
//   copy of the files git tracks, plus new files it does not ignore — your change,
//   committed or not, and nothing a build left behind.
// - From scratch. `graphify update .` merges into the graph.json it finds and keeps nodes it
//   did not extract this time; the copy has no graph.json. Code is parsed locally with no
//   model, so a full build takes seconds.
// - With root-relative names only. Graphify names an import whose target it did not scan
//   after the *absolute* path (`tmp_corehub_graph_…_packages_…`); those names are rewritten
//   to the root-relative form every other node already has.
// - With the date out of the report's title, and in one canonical order (see `canonical`):
//   Graphify clusters in the order the file system lists files, which differs between
//   machines, so communities move; nodes and edges do not.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT = 'graphify-out';
const KEEP = [
  'graph.json',
  'graph.html',
  'GRAPH_REPORT.md',
  '.graphify_labels.json',
  '.graphify_labels.json.sig',
  '.graphify_root',
];

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split('\0')
  .filter((file) => file && !file.startsWith(`${OUT}/`) && existsSync(file));

const work = mkdtempSync(path.join(tmpdir(), 'corehub-graph-'));
try {
  for (const file of files) {
    mkdirSync(path.join(work, path.dirname(file)), { recursive: true });
    copyFileSync(file, path.join(work, file));
  }
  const build = spawnSync('graphify', ['update', '.'], { cwd: work, stdio: 'inherit' });
  if (build.error || build.status !== 0) {
    console.error(
      build.error?.code === 'ENOENT'
        ? 'graph  Graphify is not installed: uv tool install graphifyy==0.9.66'
        : 'graph  graphify update failed',
    );
    process.exit(1);
  }

  const root = `${work
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}_`;
  mkdirSync(OUT, { recursive: true });
  for (const name of KEEP) {
    const from = path.join(work, OUT, name);
    if (!existsSync(from)) continue;
    const text = readFileSync(from, 'utf8').split(root).join('');
    writeFileSync(path.join(OUT, name), text);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const graphFile = `${OUT}/graph.json`;
const graph = JSON.parse(readFileSync(graphFile, 'utf8'));
// The copy is not a git checkout; say which commit the map was built on top of.
graph.built_at_commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(graphFile, `${JSON.stringify(canonical(graph), null, 2)}\n`);

const report = `${OUT}/GRAPH_REPORT.md`;
writeFileSync(
  report,
  readFileSync(report, 'utf8').replace(/^# Graph Report - .*$/m, '# Graph Report - corehub'),
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
