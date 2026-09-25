#!/usr/bin/env node
// Checks what the Windows packaging made (run by .github/workflows/desktop.yml on Windows):
//
//   node scripts/check-windows-package.mjs asar <app.asar> <github|store> <version>
//       the app inside says the expected update channel and version;
//   node scripts/check-windows-package.mjs msix <unpacked .msix folder> <version>
//       the Store package's manifest carries the product identity, X.Y.Z.0, both languages,
//       the corehub:// protocol and the brand tiles, and the app inside is the Store channel.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { msixVersion } from './release-assets.mjs';

const problems = [];
const expect = (ok, message) => {
  if (!ok) problems.push(message);
};

/** package.json from an asar archive (header: pickled JSON; files follow it). */
function asarPackageJson(file) {
  const buf = readFileSync(file);
  const headerSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'));
  const entry = header.files?.['package.json'];
  if (!entry) throw new Error(`${file}: no package.json`);
  const start = 8 + headerSize + Number(entry.offset);
  return JSON.parse(buf.subarray(start, start + entry.size).toString('utf8'));
}

function checkAsar(file, channel, version) {
  const pkg = asarPackageJson(file);
  const stamped = pkg.corehubChannel ?? 'github';
  expect(stamped === channel, `${file}: channel ${stamped}, expected ${channel}`);
  expect(pkg.version === version, `${file}: version ${pkg.version}, expected ${version}`);
  console.log(`asar: ${path.basename(file)} channel=${stamped} version=${pkg.version}`);
}

function checkMsix(dir, version) {
  const manifest = readFileSync(path.join(dir, 'AppxManifest.xml'), 'utf8');
  const has = (text, what) => expect(manifest.includes(text), `AppxManifest.xml: no ${what}`);
  has('Name="AbdulazizAltuwijri.CoreHub"', 'Identity Name AbdulazizAltuwijri.CoreHub');
  has("Publisher='CN=814A0A23-0E7E-4406-8883-4E483DF08BDA'", 'the Partner Center publisher');
  has(`Version="${msixVersion(version)}"`, `Version ${msixVersion(version)}`);
  has('ProcessorArchitecture="x64"', 'x64 architecture');
  has('<DisplayName>Core Hub</DisplayName>', 'display name Core Hub');
  has('<PublisherDisplayName>Abdulaziz Altuwijri</PublisherDisplayName>', 'publisher display name');
  has('<Resource Language="en-US" />', 'English');
  has('<Resource Language="ar" />', 'Arabic');
  has('<uap:Protocol Name="corehub">', 'the corehub:// protocol');
  has('Executable="app\\corehub.exe"', 'app\\corehub.exe as the executable');
  has('<rescap:Capability Name="runFullTrust"/>', 'runFullTrust');
  expect(existsSync(path.join(dir, 'app', 'corehub.exe')), 'app\\corehub.exe is missing');
  expect(
    existsSync(path.join(dir, 'app', 'resources', 'hub', 'dist', 'app', 'hub.mjs')),
    'the embedded hub is missing',
  );
  expect(existsSync(path.join(dir, 'resources.pri')), 'resources.pri (scaled tiles) is missing');
  const assets = readdirSync(path.join(dir, 'assets'));
  for (const tile of ['StoreLogo', 'Square44x44Logo', 'Square150x150Logo', 'Wide310x150Logo'])
    expect(
      assets.some((a) => a.startsWith(`${tile}.scale-`)),
      `assets: no ${tile} (the Electron sample would show)`,
    );
  // The Store build carries the plain X.Y.Z (scripts/package.mjs).
  const core = msixVersion(version).replace(/\.0$/, '');
  checkAsar(path.join(dir, 'app', 'resources', 'app.asar'), 'store', core);
  console.log(`msix: manifest ${msixVersion(version)}, ${assets.length} tiles`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'asar' && args.length === 3) checkAsar(args[0], args[1], args[2]);
else if (command === 'msix' && args.length === 2) checkMsix(args[0], args[1]);
else {
  console.error(
    'usage: check-windows-package.mjs asar <file> <channel> <version> | msix <dir> <version>',
  );
  process.exit(2);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
