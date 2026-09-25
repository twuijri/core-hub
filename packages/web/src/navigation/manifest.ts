// The navigation contract, read from the repository (docs/clients/README.md: never a second
// hand-maintained copy). Vite bundles the JSON at build time.
import manifest from '../../../../docs/clients/navigation.json' with { type: 'json' };
import { desktopBridge } from '../desktop/desktop.js';

export type Surface = 'web' | 'desktop' | 'android' | 'ios';
export type EntryKind =
  | 'rail'
  | 'segment'
  | 'footer'
  | 'settings-tab'
  | 'settings-management'
  | 'settings-tool'
  | 'agent'
  | 'secondary-only';
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
  /** Pages configured once — models, devices, knowledge — inside Settings. */
  settingsManagement: string[];
  settingsTools: string[];
  agentLevel: string[];
  secondaryEntries: Record<string, string[]>;
  preAuth: Record<string, PreAuthScreen>;
  surfaceRoutes: Record<string, Record<string, string>>;
  /** What an agent's pages put in the sidebar: a back row (a term) to `returnsTo`. */
  agentShell: { back: string; returnsTo: string };
  /** Old path prefixes each surface still redirects, old → new; the rest of the path is kept. */
  legacyRoutes: Record<string, Record<string, string>>;
}

export const navigation = manifest as unknown as NavigationManifest;

/**
 * Which surface this bundle is drawing. The desktop app wraps this very client and says
 * so through its bridge (`desktop/desktop.ts`); everywhere else it is the web.
 */
export function detectSurface(): Surface {
  return desktopBridge() ? 'desktop' : 'web';
}
export const SURFACE: Surface = detectSurface();

/**
 * A surface's routes. A surface that draws this same client (the desktop app) names the one
 * it `$extends` and lists only what it adds; destinations that are not on it are dropped.
 */
export function surfaceRoutesOf(surface: Surface): Record<string, string> {
  const own = navigation.surfaceRoutes[surface] ?? {};
  const base = own.$extends ? surfaceRoutesOf(own.$extends as Surface) : {};
  const merged: Record<string, string> = {};
  for (const [id, route] of Object.entries({ ...base, ...own })) {
    if (id.startsWith('$')) continue;
    const destination = navigation.destinations.find((d) => d.id === id);
    if (destination?.surfaces && !destination.surfaces.includes(surface)) continue;
    merged[id] = route;
  }
  return merged;
}
const ROUTES = surfaceRoutesOf(SURFACE);

export const destinationsById: ReadonlyMap<string, Destination> = new Map(
  navigation.destinations.map((d) => [d.id, d]),
);

export function onThisSurface(destination: Destination): boolean {
  return !destination.surfaces || destination.surfaces.includes(SURFACE);
}

/** Destinations this client must implement (docs/clients/README.md rule 1). */
export const webDestinations: readonly Destination[] =
  navigation.destinations.filter(onThisSurface);

/** The URL of a destination on this surface (from `surfaceRoutes` in the manifest). */
export function routeOf(id: string): string {
  const route = ROUTES[id];
  if (!route) throw new Error(`navigation.json has no ${SURFACE} route for "${id}"`);
  return route;
}

/**
 * The URL of a pre-auth screen on the web (`preAuth.<id>.routes.web`). These screens have no
 * navigation entry by design: nothing links to them from a signed-in session.
 */
export function preAuthRouteOf(id: string): string {
  const routes = navigation.preAuth?.[id]?.routes;
  const route = routes?.[SURFACE] ?? routes?.web;
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

/** Whether this role may open a destination at all (the router refuses what the menu hides). */
export function canOpen(id: string, role: string): boolean {
  const destination = destinationsById.get(id);
  return !!destination && roleAllows(destination, role);
}

/** The URL of an agent-level page for one agent. */
export function agentRoute(id: string, agentId: string): string {
  return routeOf(id).replace(':agentId', encodeURIComponent(agentId));
}

/**
 * Which agent page this path is — `{ id, agentId }` — or `null` outside the agent level. The
 * sidebar reads it to become that agent's list (NAVIGATION §4).
 */
export function agentPageFromPath(pathname: string): { id: string; agentId: string } | null {
  for (const id of navigation.agentLevel) {
    const route = ROUTES[id];
    if (!route) continue;
    const [before, after] = route.split(':agentId');
    if (before === undefined || after === undefined || !pathname.startsWith(before)) continue;
    const rest = pathname.slice(before.length);
    if (!rest.endsWith(after)) continue;
    const agentId = rest.slice(0, rest.length - after.length);
    if (agentId && !agentId.includes('/')) return { id, agentId: decodeURIComponent(agentId) };
  }
  return null;
}

/**
 * Where an old URL lives now (`legacyRoutes.web`), or `null` when the path is not an old one.
 * `/settings/agents/01J…/memory` → `/agents/01J…/memory`.
 */
export function legacyRedirect(pathname: string): string | null {
  for (const [from, to] of Object.entries(navigation.legacyRoutes?.web ?? {})) {
    if (from.startsWith('$')) continue;
    if (pathname === from) return to;
    if (pathname.startsWith(`${from}/`)) return `${to}${pathname.slice(from.length)}`;
  }
  return null;
}
