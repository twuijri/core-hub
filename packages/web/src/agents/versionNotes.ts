/**
 * What a card says about an agent's version (proposed update policy, 2026-09-25).
 *
 * The catalog's pin is the version Core Hub was tested with (`install.pinned_version`).
 * The hub asks the registry every six hours and may install a newer release; when the
 * installed version, or the update on offer, is past the pin, the card says so in plain
 * words — «أحدث من النسخة المختبرة» — rather than hiding it.
 */
import type { Agent } from '../types.js';

export interface VersionNotes {
  /** The version an update would install, or null when there is none. */
  update: string | null;
  /** The update on offer is past the tested pin. */
  updateUntested: boolean;
  /** What is installed now is past the tested pin. */
  newerThanTested: boolean;
  /** The tested pin, or null for an agent the hub does not install. */
  tested: string | null;
}

export function versionNotes(install: Agent['install']): VersionNotes {
  const tested = install.pinned_version ?? null;
  const update = install.update_available ? (install.latest_version ?? null) : null;
  return {
    update,
    updateUntested: !!update && !!tested && update !== tested,
    newerThanTested: install.newer_than_tested === true,
    tested,
  };
}
