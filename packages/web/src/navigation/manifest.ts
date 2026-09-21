// The navigation contract, read from the repository (docs/clients/README.md: never a second
// hand-maintained copy). Vite bundles the JSON at build time.
import manifest from '../../../../docs/clients/navigation.json' with { type: 'json' };

export type Surface = 'web' | 'desktop' | 'android' | 'ios';
export type EntryKind =
  'rail' | 'segment' | 'footer' | 'settings-tab' | 'settings-tool' | 'agent' | 'secondary-only';
export type Role = 'member' | 'admin' | 'owner';

export interface Destination {
  id: string;
  title: string;
  module?: string;
  level: 'app' | 'settings' | 'agent';
  entry: { kind: EntryKind; reachedFrom?: string[] };
  roles?: Role[];
  surfaces?: Surface[];
  capability?: string;
  global?: boolean;
  tabs?: string[];
  actions?: string[];
  note?: string;
}

/** A screen shown before anyone is signed in: sign-in and first-run setup (ADR 0011). */
export interface PreAuthScreen {
  title: string;
  routes: Partial<Record<Surface, string>>;
}

export interface NavigationManifest {
  version: number;
  terms: Record<string, { en: string; ar: string }>;
  destinations: Destination[];
  rail: string[];
  segments: string[];
  footer: string[];
  settingsTabs: string[];
  settingsTools: string[];
  agentLevel: string[];
  secondaryEntries: Record<string, string[]>;
  preAuth: Record<string, PreAuthScreen>;
  surfaceRoutes: Record<string, Record<string, string>>;
}

export const navigation = manifest as unknown as NavigationManifest;
export const SURFACE: Surface = 'web';

export const destinationsById: ReadonlyMap<string, Destination> = new Map(
  navigation.destinations.map((d) => [d.id, d]),
);

export function onThisSurface(destination: Destination): boolean {
  return !destination.surfaces || destination.surfaces.includes(SURFACE);
}

/** Destinations this client must implement (docs/clients/README.md rule 1). */
export const webDestinations: readonly Destination[] =
  navigation.destinations.filter(onThisSurface);

/** The URL of a destination on the web (from `surfaceRoutes.web` in the manifest). */
export function routeOf(id: string): string {
  const route = navigation.surfaceRoutes.web?.[id];
  if (!route) throw new Error(`navigation.json has no web route for "${id}"`);
  return route;
}

/**
 * The URL of a pre-auth screen on the web (`preAuth.<id>.routes.web`). These screens have no
 * navigation entry by design: nothing links to them from a signed-in session.
 */
export function preAuthRouteOf(id: string): string {
  const route = navigation.preAuth?.[id]?.routes.web;
  if (!route) throw new Error(`navigation.json has no web route for pre-auth screen "${id}"`);
  return route;
}

/** The i18n key of a destination's title (= its entry label, NAVIGATION rule). */
export function termKey(id: string): string {
  const destination = destinationsById.get(id);
  if (!destination) throw new Error(`unknown destination "${id}"`);
  return `nav.${destination.title}`;
}

export function roleAllows(destination: Destination, role: string): boolean {
  const roles = destination.roles ?? ['member'];
  if (roles.includes('member')) return true;
  if (roles.includes('admin')) return role === 'admin' || role === 'owner';
  return role === 'owner';
}

/** Entries of a list the signed-in person may see (rule 6). */
export function visibleEntries(ids: readonly string[], role: string): Destination[] {
  return ids
    .map((id) => destinationsById.get(id))
    .filter((d): d is Destination => !!d && onThisSurface(d) && roleAllows(d, role));
}

/** Agent-level entries render only for the capabilities the registry declares (rule 7). */
export function agentMenu(capabilities: readonly string[], role: string): Destination[] {
  return visibleEntries(navigation.agentLevel, role).filter(
    (d) => !!d.capability && capabilities.includes(d.capability),
  );
}
