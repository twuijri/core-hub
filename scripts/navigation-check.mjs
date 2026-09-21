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

// surfaceRoutes: a URL (web) or screen id per destination that exists on that surface — the
// client's router is built from it, so it must be complete, exact and unique.
for (const [surface, routes] of Object.entries(manifest.surfaceRoutes ?? {})) {
  if (surface.startsWith('$')) continue;
  if (!SURFACES.has(surface)) {
    fail(`surfaceRoutes: unknown surface "${surface}"`);
    continue;
  }
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

if (failures > 0) {
  console.error(
    `nav:check  FAILED with ${failures} problem(s) in ${path.relative(repoRoot, manifestPath)}`,
  );
  process.exit(1);
}
const surfaces = Object.keys(manifest.surfaceRoutes ?? {}).filter((s) => !s.startsWith('$'));
console.log(
  `nav:check  OK — ${destinations.length} destinations, ${Object.keys(terms).length} terms, ar/en complete, routes for ${surfaces.join(', ') || 'no surface yet'}`,
);
