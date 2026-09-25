/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads its hooks as CommonJS. */
// electron-builder afterPack hook: the embedded hub carries the native binaries of every
// platform (they come that way from npm); an installer keeps only its own.
const { readdirSync, rmSync, existsSync } = require('node:fs');
const path = require('node:path');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const arch = ARCH[context.arch] ?? String(context.arch);
  const resources =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const keep = `${platform}-${arch}`;
  for (const pkg of ['better-sqlite3', 'argon2']) {
    const dir = path.join(resources, 'hub', 'node_modules', pkg, 'prebuilds');
    if (!existsSync(dir)) throw new Error(`after-pack: ${dir} is missing`);
    let kept = 0;
    for (const entry of readdirSync(dir)) {
      // better-sqlite3: <platform>-<arch>.node; argon2: <platform>-<arch>/…
      const name = entry.replace(/\.node$/, '');
      if (name === keep) kept += 1;
      else rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
    if (kept === 0) throw new Error(`after-pack: ${pkg} has no prebuilt binary for ${keep}`);
  }
};
