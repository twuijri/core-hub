/**
 * A workspace is a profile of the agent runtime (ADR 0014): creating one here creates the
 * runtime's profile of the same name, and a profile the runtime already has appears here.
 *
 * `auth` owns workspaces and knows nothing of Hermes; the runtime side is a port that
 * `modules/index.ts` fills from `agents`. With no port — no Hermes on this host, or a
 * gateway reached from elsewhere — a workspace is the hub's own filter, as before.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { workspaces } from './schema.js';
import type { WorkspaceRow } from './serialize.js';

/** The runtime's name for the hub's default workspace, whatever the owner called it. */
export const RUNTIME_DEFAULT_PROFILE = 'default';

/** How a new profile starts: the runtime's fresh profile, or a copy of another one. */
export type ProfileOrigin = { kind: 'blank' } | { kind: 'clone'; source: string };

export interface ProfileMirror {
  /** The runtime's named profiles (never `default`), deleted ones left out. */
  list(): Promise<string[]>;
  /**
   * Creates the runtime's profile. Throws `ProfileMirrorError` with the runtime's own words
   * when it refuses (an existing name, a bad source).
   */
  create(name: string, origin: ProfileOrigin): Promise<void>;
}

export class ProfileMirrorError extends Error {}

let mirrorFactory: ((app: FastifyInstance) => ProfileMirror | null) | null = null;

/** Wired once, from `modules/index.ts`. Returns the previous factory (tests restore it). */
export function registerProfileMirror(
  factory: ((app: FastifyInstance) => ProfileMirror | null) | null,
): ((app: FastifyInstance) => ProfileMirror | null) | null {
  const previous = mirrorFactory;
  mirrorFactory = factory;
  return previous;
}

/**
 * The port for this app, or none. A hub composed without the runtime's module (a test hub
 * with `auth` alone) has none: the factory's failure to find it is "no mirror", never a 500.
 */
export function profileMirrorFor(app: FastifyInstance): ProfileMirror | null {
  if (!mirrorFactory) return null;
  try {
    return mirrorFactory(app);
  } catch {
    return null;
  }
}

/** The runtime's name for a workspace: its slug, except the default one. */
export function runtimeProfileName(row: Pick<WorkspaceRow, 'slug' | 'isDefault'>): string {
  return row.isDefault ? RUNTIME_DEFAULT_PROFILE : row.slug;
}

/** A hub slug (`^[a-z0-9][a-z0-9-]{0,39}$`) is narrower than a Hermes name. */
const HUB_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface AdoptResult {
  adopted: string[];
  /** Runtime profiles whose names a hub slug cannot carry (`_`, or longer than 40). */
  unnamed: string[];
}

/**
 * Adds a workspace for every runtime profile the hub does not know. A slug already used by
 * any workspace — archived ones included, so archiving here is not undone by the next
 * listing — is left alone.
 */
export function adoptProfiles(
  db: ModuleDb,
  ownerId: string,
  names: readonly string[],
): AdoptResult {
  const result: AdoptResult = { adopted: [], unnamed: [] };
  for (const name of names) {
    if (name === RUNTIME_DEFAULT_PROFILE) continue;
    if (!HUB_SLUG.test(name)) {
      result.unnamed.push(name);
      continue;
    }
    const taken = db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, name))
      .get();
    if (taken) continue;
    db.insert(workspaces).values({ ownerId, slug: name, name, settings: {} }).run();
    result.adopted.push(name);
  }
  return result;
}
