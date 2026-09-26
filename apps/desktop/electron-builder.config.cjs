// Installers for the desktop app (ADR 0020). Built by `pnpm --filter @corehub/desktop package`
// after `pnpm build`. Nothing here publishes: `publish: null`; CI keeps the files as workflow
// artifacts, and publish-release.yml attaches them to a tag's GitHub release (docs/RELEASING.md).
//
// Windows ships two ways (owner, 2026-09-25): the NSIS `.exe` (unsigned, GitHub releases, the
// app's own update check) and the Microsoft Store MSIX (`appx` below; the Store signs it). The
// MSIX is a second packaging run, `COREHUB_CHANNEL=store … package --win` (scripts/package.mjs),
// which stamps `corehubChannel: store` so that build never checks GitHub for updates.
//
// macOS signing (docs/RELEASING.md): only when a Developer ID certificate is named through
// electron-builder's own variables — CSC_LINK / CSC_KEY_PASSWORD, or CSC_NAME with CSC_KEYCHAIN as
// the signed-build workflow does; it then notarises when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
// APPLE_TEAM_ID are set too. Without them (a pull request, a fork, a developer's machine) the
// build stays unsigned, as before.
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.twuijri.corehub',
  // The name a person sees: `Core Hub.app`, the DMG window, the menu bar and the Dock; `Core
  // Hub.exe` in a `Core Hub` folder, the Start menu shortcut and the uninstall entry; the Linux
  // menu entry and `/opt/Core Hub`. No top-level `executableName`: electron-builder names the
  // bundle, the .exe and the install folder after it (1.1.1 shipped `corehub.app` and
  // `corehub.exe`). The data folder follows none of these names (src/shared/user-data.ts).
  productName: 'Core Hub',
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
  forceCodeSigning: signed,
  protocols: [{ name: 'Core Hub', schemes: ['corehub'] }],
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Network',
    // One PNG per size (NxN.png); made with icon.icns and icon.ico by scripts/icons/build-icons.mjs.
    icon: 'assets/icons',
    synopsis: 'A self-hosted hub for AI agents',
    maintainer: 'twuijri <twuijri@users.noreply.github.com>',
    mimeTypes: ['x-scheme-handler/corehub'],
    syncDesktopName: true,
    // The binary is `/opt/Core Hub/core-hub` (and `/usr/bin/core-hub`): no space in a command
    // name, the desktop entry's Exec is quoted for the folder. What a person sees is the entry's
    // Name, "Core Hub". The entry itself stays `corehub.desktop` (package.json `desktopName`), so
    // the window class stays `corehub` = StartupWMClass and existing dock pins and the
    // `corehub://` handler keep pointing at it. 1.1.1's binary was `corehub`.
    executableName: 'core-hub',
  },
  deb: { packageName: 'corehub', artifactName: 'corehub_${version}_${arch}.${ext}' },
  mac: {
    // Apple silicon only: argon2 (the hub's password hashing) ships no darwin-x64 binary, so an
    // Intel build could not run local mode. Proposed — owner to confirm (ADR 0023).
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    icon: 'assets/icon.icns',
    // Unsigned builds open with a Gatekeeper warning; a signed one fails loudly rather than
    // falling back to unsigned.
    identity: signed ? undefined : null,
    hardenedRuntime: true,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    // Unsigned: SmartScreen asks "More info → Run anyway" (docs/RELEASING.md). SignPath
    // Foundation's free signing for open source is the option noted for later.
  },
  // The Microsoft Store package. The identity is the product's in Partner Center (public values).
  // The Store signs what it publishes, so the build stays unsigned. Tiles: assets/appx, made by
  // scripts/icons/build-icons.mjs. Version X.Y.Z.0: package.mjs stamps the plain X.Y.Z and
  // `setBuildNumber: false` keeps the fourth part 0, as the Store requires.
  appx: {
    identityName: 'AbdulazizAltuwijri.CoreHub',
    publisher: 'CN=814A0A23-0E7E-4406-8883-4E483DF08BDA',
    publisherDisplayName: 'Abdulaziz Altuwijri',
    applicationId: 'CoreHub',
    displayName: 'Core Hub',
    languages: ['en-US', 'ar'],
    backgroundColor: 'transparent',
    setBuildNumber: false,
    // MSIX needs Windows 10 1809; tested up to Windows 11 24H2.
    minVersion: '10.0.17763.0',
    maxVersionTested: '10.0.26100.0',
    electronUpdaterAware: false,
    artifactName: 'Core-Hub-${version}-${arch}.msix',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // Upgrading 1.1.1 (`corehub\corehub.exe`) moves the app to a `Core Hub` folder and points
    // `corehub://` at the new .exe at once (scripts/installer.nsh).
    include: 'scripts/installer.nsh',
    artifactName: 'Core-Hub-Setup-${version}-${arch}.${ext}',
  },
  // The window the DMG opens in, e.g. "Core Hub 1.1.1" (the default adds the arch).
  dmg: { title: '${productName} ${version}', artifactName: 'Core-Hub-${version}-${arch}.${ext}' },
  appImage: { artifactName: 'Core-Hub-${version}-${arch}.${ext}' },
};
