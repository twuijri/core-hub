#!/usr/bin/env node
// CLIProxyAPI (router-for-me/CLIProxyAPI, MIT) — the format translator behind the hub's model
// gateway (ADR 0029). One pinned release (`pin.json`), one file per platform, each checked
// against its SHA-256 before anything is unpacked. Used by the image build (Dockerfile), the
// desktop packaging (apps/desktop/scripts/after-pack.cjs), the real gateway test in CI, and a
// developer's machine (`pnpm cliproxy:fetch`).
//
//   node scripts/cliproxy/fetch.mjs [--platform linux-x64] [--dest <dir>]
//
// The folder it fills holds the executable (`cli-proxy-api`, `.exe` on Windows) and the
// project's LICENSE next to it (`LICENSE.CLIProxyAPI`). Without `--dest` it is
// `~/.cache/corehub/cliproxy/<version>/<platform>`, where the hub looks in development.
// A folder that already holds the pinned version (a `VERSION` file written last) is kept.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The pinned release, as `pin.json` declares it. */
export const PIN = JSON.parse(readFileSync(path.join(here, 'pin.json'), 'utf8'));

/** `process.platform`-`process.arch`, the key `pin.json` names each asset under. */
export function currentPlatform(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** The executable's file name on a platform. */
export function binaryName(platform) {
  return platform.startsWith('win32-') ? `${PIN.binary}.exe` : PIN.binary;
}

/** Where a developer's copy lives (and where the hub looks for one in development). */
export function defaultDest(platform = currentPlatform()) {
  return path.join(homedir(), '.cache', 'corehub', 'cliproxy', PIN.version, platform);
}

function assetOf(platform) {
  const asset = PIN.assets[platform];
  if (!asset) {
    throw new Error(
      `cliproxy: no ${PIN.name} ${PIN.version} release for ${platform} (have: ${Object.keys(PIN.assets).join(', ')})`,
    );
  }
  return asset;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`cliproxy: ${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function unpack(archive, file, into) {
  if (file.endsWith('.zip')) {
    try {
      execFileSync('unzip', ['-o', '-q', archive, '-d', into], { stdio: 'ignore' });
      return;
    } catch {
      // Windows has no unzip; its bsdtar reads zip files.
    }
  }
  execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'ignore' });
}

/**
 * Downloads the pinned release for `platform` into `dest` and returns the executable's path.
 * Refuses a file whose SHA-256 is not the pinned one.
 */
export async function fetchCliproxy({ platform = currentPlatform(), dest, log = console.log } = {}) {
  const asset = assetOf(platform);
  const into = path.resolve(dest ?? defaultDest(platform));
  const executable = path.join(into, binaryName(platform));
  const stamp = path.join(into, 'VERSION');
  if (
    existsSync(executable) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8').trim() === `${PIN.version} ${asset.sha256}`
  ) {
    log(`cliproxy: ${PIN.name} ${PIN.version} (${platform}) already in ${into}`);
    return executable;
  }
  const url = `https://github.com/${PIN.repository}/releases/download/v${PIN.version}/${asset.file}`;
  log(`cliproxy: downloading ${url}`);
  const bytes = await download(url);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== asset.sha256) {
    throw new Error(
      `cliproxy: ${asset.file} has SHA-256 ${sha256}, the pin says ${asset.sha256}; refusing it`,
    );
  }
  const work = mkdtempSync(path.join(tmpdir(), 'corehub-cliproxy-'));
  try {
    const archive = path.join(work, asset.file);
    writeFileSync(archive, bytes);
    const unpacked = path.join(work, 'x');
    mkdirSync(unpacked);
    unpack(archive, asset.file, unpacked);
    const found = path.join(unpacked, binaryName(platform));
    if (!existsSync(found)) throw new Error(`cliproxy: ${asset.file} holds no ${binaryName(platform)}`);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    copyFileSync(found, executable);
    chmodSync(executable, 0o755);
    copyFileSync(path.join(unpacked, 'LICENSE'), path.join(into, `LICENSE.${PIN.name}`));
    writeFileSync(stamp, `${PIN.version} ${asset.sha256}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log(`cliproxy: ${PIN.name} ${PIN.version} (${platform}) verified and unpacked into ${into}`);
  return executable;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchCliproxy({ platform: argument('platform'), dest: argument('dest') }).then(
    (file) => console.log(file),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
