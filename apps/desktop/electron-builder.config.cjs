// Installers for the desktop app (ADR 0020). Built by `pnpm --filter @corehub/desktop package`
// after `pnpm build`. Nothing here publishes: `publish: null`, and CI keeps the files as
// workflow artifacts only. Code signing and notarisation are not configured yet — the owner
// decides (docs/changes/2026-09-25-twuijri-desktop-packaging.md, TODO).
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.twuijri.corehub',
  productName: 'Core Hub',
  executableName: 'corehub',
  copyright: 'Copyright © twuijri. Apache-2.0.',
  directories: { output: 'release', buildResources: 'assets' },
  // The main process is one bundle; the app needs no node_modules at run time.
  files: ['package.json', 'dist/**/*', '!dist/hub/**', '!dist/**/*.map'],
  // The embedded hub of local mode runs as its own Node process and loads native modules, so it
  // lives outside the archive (src/main/index.ts reads it from resources/hub).
  extraResources: [
    { from: 'dist/hub', to: 'hub', filter: ['**/*'] },
    // electron-builder leaves node_modules out of a copy unless it is named.
    { from: 'dist/hub/node_modules', to: 'hub/node_modules', filter: ['**/*'] },
  ],
  // Keeps only this platform's SQLite and argon2 binaries in resources/hub.
  afterPack: './scripts/after-pack.cjs',
  asar: true,
  // Chromium's own strings, for the two languages the app speaks (the rest is ~8 MB).
  electronLanguages: ['ar', 'en-US'],
  npmRebuild: false,
  nodeGypRebuild: false,
  publish: null,
  protocols: [{ name: 'Core Hub', schemes: ['corehub'] }],
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Network',
    icon: 'assets/icon.png',
    synopsis: 'A self-hosted hub for AI agents',
    maintainer: 'twuijri <twuijri@users.noreply.github.com>',
    mimeTypes: ['x-scheme-handler/corehub'],
    syncDesktopName: true,
  },
  deb: { packageName: 'corehub', artifactName: 'corehub_${version}_${arch}.${ext}' },
  mac: {
    // Apple silicon only: argon2 (the hub's password hashing) ships no darwin-x64 binary, so an
    // Intel build could not run local mode. Proposed — owner to confirm (ADR 0023).
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    icon: 'assets/icon.png',
    // TODO(owner): Developer ID signing and notarisation. Unsigned builds open with a warning.
    identity: null,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.png',
    // TODO(owner): Authenticode signing. Unsigned installers show a SmartScreen warning.
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'Core-Hub-Setup-${version}-${arch}.${ext}',
  },
  dmg: { artifactName: 'Core-Hub-${version}-${arch}.${ext}' },
  appImage: { artifactName: 'Core-Hub-${version}-${arch}.${ext}' },
};
