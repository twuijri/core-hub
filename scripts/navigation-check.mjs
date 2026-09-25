#!/usr/bin/env node
// `pnpm nav:check`: docs/clients/navigation.json is the machine-readable navigation contract.
// This validates the manifest itself; each client's parity test compares its screens to it.
// Rules (docs/clients/NAVIGATION.md): one primary entry per destination, entry label = screen
// title (same term key), every term has ar + en, every list item is a known destination.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'docs', 'clients', 'navigation.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  error  ${msg}`);
};

const ENTRY_KINDS = new Set([
  'rail',
  'segment',
  'footer',
  'settings-tab',
  'settings-management',
  'settings-tool',
  'agent',
  'secondary-only',
]);
const LEVELS = new Set(['app', 'settings', 'agent']);
const ROLES = new Set(['member', 'admin', 'owner']);
const SURFACES = new Set(['web', 'desktop', 'android', 'ios']);

const terms = manifest.terms ?? {};
for (const [key, value] of Object.entries(terms)) {
  for (const language of ['ar', 'en']) {
    if (typeof value?.[language] !== 'string' || value[language].trim() === '')
      fail(`term "${key}" is missing ${language}`);
  }
}

const destinations = manifest.destinations ?? [];
const byId = new Map();
for (const destination of destinations) {
  const { id } = destination;
  if (!id || byId.has(id)) fail(`destination id "${id}" is missing or duplicated`);
  byId.set(id, destination);
  if (!terms[destination.title])
    fail(`destination "${id}": title term "${destination.title}" is not in terms`);
  if (!LEVELS.has(destination.level))
    fail(`destination "${id}": level must be one of ${[...LEVELS].join(', ')}`);
  if (!ENTRY_KINDS.has(destination.entry?.kind))
    fail(`destination "${id}": entry.kind "${destination.entry?.kind}" unknown`);
  if (destination.entry?.label !== undefined && destination.entry.label !== destination.title) {
    fail(
      `destination "${id}": entry label "${destination.entry.label}" must equal its title "${destination.title}"`,
    );
  }
  for (const role of destination.roles ?? [])
    if (!ROLES.has(role)) fail(`destination "${id}": unknown role "${role}"`);
  for (const surface of destination.surfaces ?? [])
    if (!SURFACES.has(surface)) fail(`destination "${id}": unknown surface "${surface}"`);
  if (!destination.module && destination.level !== 'settings')
    fail(`destination "${id}": module is required`);
  if (destination.level === 'agent' && !destination.capability)
    fail(`destination "${id}": agent-level destinations need a capability flag`);
}

const lists = {
  rail: 'rail',
  segments: 'segment',
  footer: 'footer',
  settingsTabs: 'settings-tab',
  settingsManagement: 'settings-management',
  settingsTools: 'settings-tool',
  agentLevel: 'agent',
};
const primaryEntries = new Map();
for (const [listName, kind] of Object.entries(lists)) {
  const items = manifest[listName] ?? [];
  const seen = new Set();
  for (const id of items) {
    if (!byId.has(id)) {
      fail(`${listName}: "${id}" is not a destination`);
      continue;
    }
    if (seen.has(id)) fail(`${listName}: "${id}" listed twice`);
    seen.add(id);
    const destination = byId.get(id);
    if (destination.entry.kind !== kind)
      fail(`${listName}: "${id}" has entry.kind "${destination.entry.kind}", expected "${kind}"`);
    primaryEntries.set(id, (primaryEntries.get(id) ?? 0) + 1);
  }
}
for (const [id, destination] of byId) {
  const count = primaryEntries.get(id) ?? 0;
  if (destination.entry.kind === 'secondary-only') {
    if (count !== 0) fail(`destination "${id}" is secondary-only but appears in a primary list`);
    if (!destination.entry.reachedFrom?.length)
      fail(`destination "${id}": secondary-only needs entry.reachedFrom`);
  } else if (count !== 1) {
    fail(`destination "${id}" must have exactly one primary entry, found ${count}`);
  }
}
for (const [a, b] of Object.entries(manifest.secondaryEntries ?? {})) {
  if (!byId.has(a)) fail(`secondaryEntries: "${a}" is not a destination`);
  for (const target of b)
    if (!byId.has(target)) fail(`secondaryEntries: "${a}" -> "${target}" is not a destination`);
}

// A surface that draws another surface's client (the desktop app draws the web client) says
// `"$extends": "<surface>"` and lists only what it adds; its routes are the base's routes for
// destinations that exist on it, plus its own. Resolved here exactly as the client resolves it.
function resolvedRoutes(surface, seen = new Set()) {
  const own = manifest.surfaceRoutes?.[surface] ?? {};
  if (seen.has(surface)) {
    fail(`surfaceRoutes.${surface}: "$extends" loops back to itself`);
    return {};
  }
  seen.add(surface);
  const baseName = own.$extends;
  if (baseName !== undefined && !(SURFACES.has(baseName) && manifest.surfaceRoutes?.[baseName]))
    fail(`surfaceRoutes.${surface}: "$extends" names "${baseName}", which has no routes`);
  const base = baseName && manifest.surfaceRoutes?.[baseName] ? resolvedRoutes(baseName, seen) : {};
  const merged = {};
  for (const [id, route] of Object.entries(base)) {
    const destination = byId.get(id);
    if (destination?.surfaces && !destination.surfaces.includes(surface)) continue;
    merged[id] = route;
  }
  for (const [id, route] of Object.entries(own)) if (!id.startsWith('$')) merged[id] = route;
  return merged;
}

// preAuth: the screens a client shows before anyone is signed in (sign-in, first-run setup).
// They are not destinations — no entry, no role, no place in any list — but the clients still
// build their routes from the manifest, so the names and paths live here and not in code.
const preAuth = manifest.preAuth ?? {};
const preAuthRoutes = new Map();
for (const [id, screen] of Object.entries(preAuth)) {
  if (id.startsWith('$')) continue;
  if (byId.has(id)) fail(`preAuth: "${id}" is also a destination; it must be one or the other`);
  if (!terms[screen?.title]) fail(`preAuth "${id}": title term "${screen?.title}" is not in terms`);
  for (const [surface, route] of Object.entries(screen?.routes ?? {})) {
    if (!SURFACES.has(surface)) {
      fail(`preAuth "${id}": unknown surface "${surface}"`);
      continue;
    }
    if (typeof route !== 'string' || !route.startsWith('/'))
      fail(`preAuth "${id}": route on ${surface} must be an absolute path`);
    const key = `${surface} ${route}`;
    if (preAuthRoutes.has(key))
      fail(
        `preAuth: route "${route}" on ${surface} is used by "${preAuthRoutes.get(key)}" and "${id}"`,
      );
    preAuthRoutes.set(key, id);
    const clash = Object.entries(
      manifest.surfaceRoutes?.[surface] ? resolvedRoutes(surface) : {},
    ).find(([, value]) => value === route);
    if (clash)
      fail(`preAuth "${id}": route "${route}" already belongs to destination "${clash[0]}"`);
  }
}

// surfaceRoutes: a URL (web) or screen id per destination that exists on that surface — the
// client's router is built from it, so it must be complete, exact and unique.
for (const surface of Object.keys(manifest.surfaceRoutes ?? {})) {
  if (surface.startsWith('$')) continue;
  if (!SURFACES.has(surface)) {
    fail(`surfaceRoutes: unknown surface "${surface}"`);
    continue;
  }
  const routes = resolvedRoutes(surface);
  const seen = new Map();
  for (const [id, route] of Object.entries(routes)) {
    const destination = byId.get(id);
    if (!destination) {
      fail(`surfaceRoutes.${surface}: "${id}" is not a destination`);
      continue;
    }
    if (destination.surfaces && !destination.surfaces.includes(surface))
      fail(`surfaceRoutes.${surface}: "${id}" does not exist on ${surface}`);
    if (typeof route !== 'string' || route.trim() === '')
      fail(`surfaceRoutes.${surface}: "${id}" has an empty route`);
    else if (seen.has(route))
      fail(
        `surfaceRoutes.${surface}: route "${route}" is used by "${seen.get(route)}" and "${id}"`,
      );
    seen.set(route, id);
  }
  for (const [id, destination] of byId) {
    if (destination.surfaces && !destination.surfaces.includes(surface)) continue;
    if (!(id in routes)) fail(`surfaceRoutes.${surface}: destination "${id}" has no route`);
  }
}

// agentShell: what an agent's pages put in the sidebar (owner, 2026-09-24) — a back row whose
// label is a term, returning to the page the agent cards live on.
const agentShell = manifest.agentShell;
if (agentShell) {
  if (!terms[agentShell.back]) fail(`agentShell.back: term "${agentShell.back}" is not in terms`);
  if (!byId.has(agentShell.returnsTo))
    fail(`agentShell.returnsTo: "${agentShell.returnsTo}" is not a destination`);
}

// legacyRoutes: old path prefixes a surface still redirects. An old prefix must not be the
// start of any live route (it would shadow it), and the new one must be where routes now live.
const under = (route, prefix) => route === prefix || route.startsWith(`${prefix}/`);
for (const [surface, map] of Object.entries(manifest.legacyRoutes ?? {})) {
  if (surface.startsWith('$')) continue;
  const live = Object.values(manifest.surfaceRoutes?.[surface] ? resolvedRoutes(surface) : {});
  for (const [from, to] of Object.entries(map ?? {})) {
    if (!from.startsWith('/') || !String(to).startsWith('/'))
      fail(`legacyRoutes.${surface}: "${from}" -> "${to}" must be absolute paths`);
    const shadowed = live.find((route) => under(route, from));
    if (shadowed) fail(`legacyRoutes.${surface}: "${from}" is still the start of "${shadowed}"`);
    if (!live.some((route) => under(route, to)))
      fail(`legacyRoutes.${surface}: "${to}" is not where any ${surface} route lives`);
  }
}

if (failures > 0) {
  console.error(
    `nav:check  FAILED with ${failures} problem(s) in ${path.relative(repoRoot, manifestPath)}`,
  );
  process.exit(1);
}
const surfaces = Object.keys(manifest.surfaceRoutes ?? {}).filter((s) => !s.startsWith('$'));
const preAuthIds = Object.keys(preAuth).filter((id) => !id.startsWith('$'));
console.log(
  `nav:check  OK — ${destinations.length} destinations, ${preAuthIds.length} pre-auth screens (${preAuthIds.join(', ')}), ${Object.keys(terms).length} terms, ar/en complete, routes for ${surfaces.join(', ') || 'no surface yet'}`,
);
