/**
 * The curated catalog of agents Core Hub can run (ADR 0006).
 *
 * One file per agent, approved by the project owner. This list is the **only** thing a
 * person can install: `agents.install` takes an agent id that must already be a row in
 * the registry, and the registry is seeded from here. There is no "add an agent by URL",
 * because that would make the hub install software nobody reviewed.
 *
 * Adding an agent is a pull request that adds one file here and, if it speaks a protocol
 * the hub does not know yet, one adapter (`../adapters/`).
 *
 * Hermes is first and is `bundled`: it ships in the image and is never installed or
 * removed by a job. Every other entry is installed on demand into
 * `${DATA_DIR}/agents/<id>` — the data volume, never the image.
 */
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { direct } from './direct.js';
import { geminiCli } from './gemini-cli.js';
import { goose } from './goose.js';
import { grokBuild } from './grok-build.js';
import { hermes } from './hermes.js';
import { kimiCode } from './kimi-code.js';
import { opencode } from './opencode.js';
import { pi } from './pi.js';
import { qwenCode } from './qwen-code.js';
import { DOWNLOAD_PLATFORMS, type CatalogEntry } from './types.js';

export * from './types.js';

/**
 * Hermes stays first: ADR 0006 pins it to the top of the registry. `direct` is second,
 * because a fresh install shows exactly these two and nothing else is installed yet
 * (ADOPTION-BACKLOG §2.15, owner's decision of 2026-09-22).
 */
export const CATALOG: readonly CatalogEntry[] = [
  hermes,
  direct,
  claudeCode,
  codex,
  geminiCli,
  opencode,
  qwenCode,
  kimiCode,
  pi,
  goose,
  grokBuild,
];

export const HERMES_ENTRY = hermes;
export const DIRECT_ENTRY = direct;

/** Every entry the hub can install on demand (everything except the bundled runtime). */
export const INSTALLABLE = CATALOG.filter((entry) => entry.install.kind !== 'bundled');

/** Entries driven by one adapter kind, for that adapter's own detection. */
export function entriesFor(adapter: CatalogEntry['adapter']): CatalogEntry[] {
  return CATALOG.filter((entry) => entry.adapter === adapter);
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/**
 * Licences an agent may ship under (SPDX ids). Core Hub is Apache-2.0 (ADR 0018) and runs
 * every agent as a separate process it installs on request, so any permissive licence is
 * compatible; a copyleft or source-available one is a decision for the owner, not for a
 * pull request that adds an entry. `LicenseRef-CoreHub` is the hub's own code.
 */
export const ACCEPTED_LICENCES: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'LicenseRef-CoreHub',
];

/** A released version: `1.2.3`, nothing after it — no range, no tag, no pre-release. */
const EXACT_STABLE = /^\d+\.\d+\.\d+$/;

/**
 * Guard: ids are unique and usable as a directory name and as a contract `slug`; every
 * installable package is pinned to an exact stable version; every licence is one the hub
 * accepts.
 */
export function assertCatalogIsWellFormed(catalog: readonly CatalogEntry[] = CATALOG): void {
  const seen = new Set<string>();
  const packages = new Set<string>();
  for (const entry of catalog) {
    if (!/^[a-z0-9-]{2,40}$/.test(entry.id)) {
      throw new Error(`catalog: "${entry.id}" is not a usable id (^[a-z0-9-]{2,40}$)`);
    }
    if (seen.has(entry.id)) throw new Error(`catalog: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (entry.install.kind === 'npm') {
      const pins = [
        { package: entry.install.package, version: entry.install.version },
        ...(entry.install.companions ?? []),
      ];
      for (const pin of pins) {
        if (!EXACT_STABLE.test(pin.version)) {
          throw new Error(
            `catalog: "${entry.id}" must pin an exact version of ${pin.package}, got "${pin.version}"`,
          );
        }
        // One package, one owner: two entries sharing a package would each claim the
        // other's update and fight over what "installed" means.
        if (packages.has(pin.package)) {
          throw new Error(`catalog: package "${pin.package}" is named twice`);
        }
        packages.add(pin.package);
      }
    }
    if (entry.install.kind === 'download') assertDownloadIsPinned(entry.id, entry.install);
    if (entry.signIn && (entry.signIn.args.length === 0 || entry.install.kind === 'bundled')) {
      throw new Error(`catalog: "${entry.id}" names a sign-in the hub cannot run`);
    }
    if (!entry.licence) throw new Error(`catalog: "${entry.id}" has no licence`);
    if (!ACCEPTED_LICENCES.includes(entry.licence)) {
      throw new Error(
        `catalog: "${entry.id}" is licensed "${entry.licence}", which the hub does not accept`,
      );
    }
    if ((entry.adapter === 'acp' || entry.adapter === 'harness') && !entry.binary) {
      throw new Error(`catalog: "${entry.id}" names no binary to start`);
    }
    // The hub's own agent is the hub: it has no process to start and nothing to fetch,
    // so an entry that claimed either would make the registry promise an install that
    // cannot happen.
    if (entry.adapter === 'builtin') {
      if (entry.install.kind !== 'bundled') {
        throw new Error(`catalog: builtin "${entry.id}" cannot be installed; it is the hub`);
      }
      if (entry.binary || entry.protocolArgs.length > 0) {
        throw new Error(`catalog: builtin "${entry.id}" must name no binary`);
      }
      if (!entry.nameAr) {
        throw new Error(`catalog: builtin "${entry.id}" needs an Arabic name (TEAM-RULES §4)`);
      }
    }
    // ADR 0010: an agent's credential line is the only place a variable is renamed, so a
    // typo here would silently start the agent without a key it was supposed to inherit.
    for (const [family, variable] of Object.entries(entry.credentials)) {
      if (!/^[a-z0-9-]{2,40}$/.test(family)) {
        throw new Error(`catalog: "${entry.id}" names a credential family "${family}" it cannot`);
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) {
        throw new Error(
          `catalog: "${entry.id}" maps "${family}" to "${variable}", which is not an ` +
            'environment variable name',
        );
      }
    }
  }
}

/**
 * A download recipe is only as safe as its pin: an exact version that every URL names, an
 * `https` URL, a full SHA-256 per file, and — for an archive — a relative path to the
 * executable that cannot climb out of the folder it is unpacked into.
 */
function assertDownloadIsPinned(
  id: string,
  recipe: Extract<CatalogEntry['install'], { kind: 'download' }>,
): void {
  if (!EXACT_STABLE.test(recipe.version)) {
    throw new Error(`catalog: "${id}" must pin an exact version, got "${recipe.version}"`);
  }
  const platforms = Object.keys(recipe.assets);
  if (platforms.length === 0) throw new Error(`catalog: "${id}" names no download`);
  for (const platform of platforms) {
    if (!(DOWNLOAD_PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(`catalog: "${id}" names an unknown platform "${platform}"`);
    }
    const asset = recipe.assets[platform as keyof typeof recipe.assets];
    if (!asset) continue;
    let url: URL;
    try {
      url = new URL(asset.url);
    } catch {
      throw new Error(`catalog: "${id}" ${platform} has no usable URL`);
    }
    if (url.protocol !== 'https:') {
      throw new Error(`catalog: "${id}" ${platform} must download over https`);
    }
    // The URL is the version's own file: a moving "latest" link would make the hash a lie.
    if (!asset.url.includes(recipe.version)) {
      throw new Error(`catalog: "${id}" ${platform} URL does not name ${recipe.version}`);
    }
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error(`catalog: "${id}" ${platform} needs a lower-case hex SHA-256`);
    }
    if (asset.format === 'tar.gz') {
      const inner = asset.extract ?? '';
      if (
        !inner ||
        inner.startsWith('/') ||
        inner.split(/[\\/]/).some((part) => part === '..' || part === '')
      ) {
        throw new Error(`catalog: "${id}" ${platform} needs a relative path inside the archive`);
      }
    } else if (asset.extract !== undefined) {
      throw new Error(`catalog: "${id}" ${platform} names a path in a file that is no archive`);
    }
  }
}
