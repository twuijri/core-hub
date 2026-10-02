// argon2 (the hub's password hashing) stopped shipping a darwin-x64 binary in 0.45 (0.44 had
// one; 0.45.1's prebuilds are darwin-arm64, linux, win32 and freebsd only). The Intel Mac app
// (DECISIONS §152) needs one, so on a Mac the desktop build compiles argon2's own sources for
// x86_64 — node-gyp `--arch=x64`, which Apple's clang cross-compiles on an Apple Silicon Mac — and
// puts the result where node-gyp-build looks for it: prebuilds/darwin-x64/argon2.node. It is
// N-API (napi 8), so the Node headers it is compiled against do not tie it to one Node version.
//
// Elsewhere (Linux, Windows) nothing is done: those hosts build no Mac app. The CI smoke test on
// an Intel runner (desktop.yml, "Intel Mac") loads the result in the packaged x64 app.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Makes sure `<into>/prebuilds/darwin-x64/argon2.node` exists, compiled from the sources in
 * `source` (the installed argon2 package, with its build-time dependencies beside it).
 * @param {{ source: string, into: string, log?: (line: string) => void }} options
 * @returns {'present' | 'built' | 'skipped'}
 */
export function ensureArgon2DarwinX64({ source, into, log = console.log }) {
  const target = path.join(into, 'prebuilds', 'darwin-x64');
  if (existsSync(target) && readdirSync(target).some((f) => f.endsWith('.node'))) return 'present';
  if (process.platform !== 'darwin') {
    log('argon2: no darwin-x64 binary, and this is not a Mac: the Intel Mac app is built on one');
    return 'skipped';
  }
  log('argon2: compiling darwin-x64 from its sources (node-gyp --arch=x64)');
  const build = spawnSync('npx', ['--yes', 'node-gyp@11', 'rebuild', '--arch=x64'], {
    cwd: source,
    stdio: 'inherit',
    env: { ...process.env, ZERO_AR_DATE: '1', npm_config_arch: 'x64' },
  });
  if (build.status !== 0) throw new Error('argon2: node-gyp could not compile darwin-x64');
  const binary = path.join(source, 'build', 'Release', 'argon2.node');
  const archs = spawnSync('lipo', ['-archs', binary], { encoding: 'utf8' });
  if (archs.status !== 0 || !/\bx86_64\b/.test(archs.stdout)) {
    throw new Error(`argon2: the compiled binary is not x86_64 (${archs.stdout.trim()})`);
  }
  mkdirSync(target, { recursive: true });
  copyFileSync(binary, path.join(target, 'argon2.node'));
  // The installed package is left as it was: its own darwin-arm64 binary loads, not this build.
  rmSync(path.join(source, 'build'), { recursive: true, force: true });
  return 'built';
}
