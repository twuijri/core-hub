#!/usr/bin/env node
// Downloads the Electron runtime for this machine. `pnpm install` does not run electron's own
// postinstall (pnpm-workspace.yaml `allowBuilds: electron: false`), so the ~100 MB download
// happens only where the desktop app is actually run, built or smoke-tested.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require.resolve('electron/package.json');
const result = spawnSync(process.execPath, [path.join(path.dirname(pkg), 'install.js')], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
const binary = require('electron');
console.log(`electron runtime ready: ${binary}`);
