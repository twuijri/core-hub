/**
 * The curated catalog of agents Majlis can run (ADR 0006).
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
import { geminiCli } from './gemini-cli.js';
import { hermes } from './hermes.js';
import { opencode } from './opencode.js';
import type { CatalogEntry } from './types.js';

export * from './types.js';

/** Hermes stays first: ADR 0006 pins it to the top of the registry. */
export const CATALOG: readonly CatalogEntry[] = [hermes, claudeCode, codex, geminiCli, opencode];

export const HERMES_ENTRY = hermes;

/** Every entry the hub can install on demand (everything except the bundled runtime). */
export const INSTALLABLE = CATALOG.filter((entry) => entry.install.kind === 'npm');

/** Entries driven by one adapter kind, for that adapter's own detection. */
export function entriesFor(adapter: CatalogEntry['adapter']): CatalogEntry[] {
  return CATALOG.filter((entry) => entry.adapter === adapter);
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/** Guard: ids are unique and usable as a directory name and as a contract `slug`. */
export function assertCatalogIsWellFormed(catalog: readonly CatalogEntry[] = CATALOG): void {
  const seen = new Set<string>();
  for (const entry of catalog) {
    if (!/^[a-z0-9-]{2,40}$/.test(entry.id)) {
      throw new Error(`catalog: "${entry.id}" is not a usable id (^[a-z0-9-]{2,40}$)`);
    }
    if (seen.has(entry.id)) throw new Error(`catalog: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (entry.install.kind === 'npm' && !/^\d+\.\d+\.\d+/.test(entry.install.version)) {
      throw new Error(
        `catalog: "${entry.id}" must pin an exact version, got "${entry.install.version}"`,
      );
    }
    if (!entry.licence) throw new Error(`catalog: "${entry.id}" has no licence`);
  }
}
