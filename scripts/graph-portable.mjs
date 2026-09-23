#!/usr/bin/env node
// Makes Graphify's map the same on every machine (docs/harness/knowledge-graph.md).
//
// Graphify names a node after its path from the repository root — except an import whose
// target it did not scan (a git-ignored file, such as the generated contract client), which
// it names after the *absolute* path: `home_<user>_<checkout>_packages_…`. That would put
// the builder's home directory in a committed file and make every machine's map differ.
// This rewrites those names to the root-relative form every other node already has, and
// takes the checkout's folder name and the date out of the report's title.
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'graphify-out';
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

const report = `${OUT}/GRAPH_REPORT.md`;
const text = readFileSync(report, 'utf8');
writeFileSync(report, text.replace(/^# Graph Report - .*$/m, '# Graph Report - majlis'));
