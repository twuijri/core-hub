/**
 * Where a profile's Hermes files live (ADR 0014 §1: a workspace is the Hermes profile named by
 * its slug, and the hub's default workspace is Hermes's `default`, the root home itself).
 *
 * Hermes resolves the same way (`hermes_cli/profiles.py` §get_profile_dir): `default` is the
 * home, any other name is `<home>/profiles/<name>`. The agent pages — skills, MCP servers,
 * memory, channels — act on the profile the person has selected, so they read and write here
 * and ask Hermes's API with `?profile=` set to the same name.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

/** Hermes's name for the root home's profile. */
export const HERMES_DEFAULT_PROFILE = 'default';

export interface ProfileScope {
  slug: string;
  isDefault: boolean;
}

/** The Hermes profile a workspace is. */
export function hermesProfileName(scope: ProfileScope): string {
  return scope.isDefault ? HERMES_DEFAULT_PROFILE : scope.slug;
}

/**
 * The profile's home under Hermes's root home, or `null` when Hermes has no such profile —
 * a workspace made before the mirror existed, or while no Hermes could create one. `null`
 * is the honest answer: the root home's files are not this profile's files.
 */
export function profileHome(root: string, scope: ProfileScope): string | null {
  if (scope.isDefault) return root;
  const home = path.join(root, 'profiles', scope.slug);
  try {
    return statSync(home).isDirectory() ? home : null;
  } catch {
    return null;
  }
}
