// The web parity test of docs/clients/README.md: the client against docs/clients/navigation.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ar from '../src/i18n/ar.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import {
  agentMenu,
  agentPageFromPath,
  canOpen,
  legacyRedirect,
  navigation,
  routeOf,
  termKey,
  visibleEntries,
  webDestinations,
} from '../src/navigation/manifest.js';
import { LOGIN_PATH, SETUP_PATH, routes } from '../src/navigation/routes.js';
import { archivedFor, scopeFromParams } from '../src/sessions/SessionList.js';
import { segmentFromPath } from '../src/shell/Sidebar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(path.join(here, '../../../docs/clients/navigation.json'), 'utf8'),
) as typeof navigation;

describe('navigation parity (web)', () => {
  it('reads the repository manifest, not a copy', () => {
    expect(navigation.version).toBe(raw.version);
    expect(navigation.destinations.map((d) => d.id)).toEqual(raw.destinations.map((d) => d.id));
  });

  it('1. every destination on this surface has a screen, 2. every screen has a destination', () => {
    const wanted = new Set(webDestinations.map((d) => d.id));
    const have = new Set(routes.map((r) => r.id));
    expect([...have].sort()).toEqual([...wanted].sort());
    // Not on web: this_device (desktop/phones only) has no route and no screen.
    expect(have.has('this_device')).toBe(false);
  });

  it('routes come from surfaceRoutes.web and are unique', () => {
    for (const route of routes) expect(route.path).toBe(navigation.surfaceRoutes.web?.[route.id]);
    expect(new Set(routes.map((r) => r.path)).size).toBe(routes.length);
  });

  it("2b. the pre-auth screens are the manifest's, and they are not destinations", () => {
    // Sign-in and first-run setup (ADR 0011) are reachable before anyone is signed in and have
    // no entry anywhere; their paths still come from the manifest, never from a literal here.
    expect(Object.keys(raw.preAuth).filter((id) => !id.startsWith('$'))).toEqual([
      'login',
      'setup',
    ]);
    expect(LOGIN_PATH).toBe(raw.preAuth.login?.routes.web);
    expect(SETUP_PATH).toBe(raw.preAuth.setup?.routes.web);
    const destinationIds = new Set(navigation.destinations.map((d) => d.id));
    expect(destinationIds.has('login')).toBe(false);
    expect(destinationIds.has('setup')).toBe(false);
    // No destination route collides with a pre-auth one.
    expect(routes.map((r) => r.path)).not.toContain(LOGIN_PATH);
    expect(routes.map((r) => r.path)).not.toContain(SETUP_PATH);
  });

  it('3. one primary entry per destination: the lists match the manifest in order (owner sees all)', () => {
    const ids = (list: readonly string[]) => visibleEntries(list, 'owner').map((d) => d.id);
    expect(ids(navigation.rail)).toEqual(raw.rail);
    expect(ids(navigation.segments)).toEqual(raw.segments);
    expect(ids(navigation.footer)).toEqual(raw.footer);
    expect(ids(navigation.settingsTabs)).toEqual(
      raw.settingsTabs.filter((id) => id !== 'this_device'),
    );
    expect(ids(navigation.settingsManagement)).toEqual(raw.settingsManagement);
    expect(ids(navigation.settingsTools)).toEqual(raw.settingsTools);
    expect(ids(navigation.agentLevel)).toEqual(raw.agentLevel);
  });

  it('4. entry label equals screen title: locale entries mirror terms for every key the manifest uses', () => {
    for (const d of navigation.destinations) {
      const term = raw.terms[d.title];
      expect(term, d.title).toBeDefined();
      expect(termKey(d.id)).toBe(`nav.${d.title}`);
      expect((en.nav as Record<string, string>)[d.title]).toBe(term?.en);
      expect((ar.nav as Record<string, string>)[d.title]).toBe(term?.ar);
    }
    for (const [key, term] of Object.entries(raw.terms)) {
      expect((en.nav as Record<string, string>)[key], key).toBe(term.en);
      expect((ar.nav as Record<string, string>)[key], key).toBe(term.ar);
    }
  });

  it('5. secondary entries only where allowed: chat is reached from search, global_agent from search', () => {
    expect(raw.secondaryEntries.chat).toEqual(['search']);
    expect(raw.secondaryEntries.global_agent).toEqual(['search']);
    expect(segmentFromPath('/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA')).toBe('chat');
    // Search is not a segment: opening a session from it keeps the selected one (rule §1).
    expect(segmentFromPath(routeOf('search'))).toBeNull();
  });

  it('History is gone: the conversation list is the history (owner, 2026-09-22)', () => {
    const ids = navigation.destinations.map((d) => d.id);
    expect(ids).not.toContain('history');
    expect(raw.terms.history).toBeUndefined();
    expect(navigation.segments).toEqual(['chat', 'rooms']);
    // Tasks and Schedules took the rail places the management pages left; Agents came back
    // to the rail, above Tasks, on 2026-09-24.
    expect(navigation.rail).toEqual(['new_chat', 'search', 'agent_manager', 'tasks', 'schedules']);
    expect(Object.keys(raw.surfaceRoutes.web ?? {})).not.toContain('history');
    // What it offered is a filter on the list, carried in the URL.
    expect(scopeFromParams(new URLSearchParams(''))).toBe('active');
    expect(scopeFromParams(new URLSearchParams('?sessions=archived'))).toBe('archived');
    expect(scopeFromParams(new URLSearchParams('?sessions=all'))).toBe('all');
    expect(scopeFromParams(new URLSearchParams('?sessions=nonsense'))).toBe('active');
    expect(archivedFor('active')).toBe('false');
    expect(archivedFor('archived')).toBe('true');
    expect(archivedFor('all')).toBe('all');
  });

  it('6. roles: admin entries are hidden from members', () => {
    // Agents is a rail entry directly above Tasks (owner, 2026-09-24), for owners and admins.
    expect(visibleEntries(navigation.rail, 'owner').map((d) => d.id)).toEqual([
      'new_chat',
      'search',
      'agent_manager',
      'tasks',
      'schedules',
    ]);
    expect(visibleEntries(navigation.rail, 'admin').map((d) => d.id)).toContain('agent_manager');
    expect(visibleEntries(navigation.rail, 'member').map((d) => d.id)).toEqual([
      'new_chat',
      'search',
      'tasks',
      'schedules',
    ]);
    // …and it left Settings → Management.
    expect(navigation.settingsManagement).not.toContain('agent_manager');
    // The router refuses what the menu hides.
    expect(canOpen('agent_manager', 'member')).toBe(false);
    expect(canOpen('agent_memory', 'member')).toBe(false);
    expect(canOpen('agent_manager', 'admin')).toBe(true);
    expect(canOpen('users', 'member')).toBe(false);
    expect(canOpen('models', 'member')).toBe(true);
    const memberTabs = visibleEntries(navigation.settingsTabs, 'member').map((d) => d.id);
    expect(memberTabs).not.toContain('users');
    expect(memberTabs).not.toContain('webhooks');
  });

  it('the Agents page and the agent level live under /agents; the old /settings/agents URLs move', () => {
    expect(routeOf('agent_manager')).toBe('/agents');
    for (const id of navigation.agentLevel)
      expect(routeOf(id)).toMatch(/^\/agents\/:agentId\/[a-z]+$/);
    expect(agentPageFromPath('/agents/01J8QK3ZR2W7M5N4P6T8V9X0AG/memory')).toEqual({
      id: 'agent_memory',
      agentId: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
    });
    expect(agentPageFromPath('/agents')).toBeNull();
    expect(agentPageFromPath('/agents/x/y/memory')).toBeNull();
    expect(agentPageFromPath('/tasks')).toBeNull();
    expect(legacyRedirect('/settings/agents')).toBe('/agents');
    expect(legacyRedirect('/settings/agents/abc/skills')).toBe('/agents/abc/skills');
    expect(legacyRedirect('/settings/agentsx')).toBeNull();
    expect(legacyRedirect('/settings/models')).toBeNull();
    expect(raw.agentShell.back).toBe('back_to_agents');
    expect((ar.nav as Record<string, string>).back_to_agents).toBe('رجوع إلى الوكلاء');
    expect((ar.nav as Record<string, string>).agent_manager).toBe('الوكلاء');
  });

  it('7. agent level is capability-driven', () => {
    expect(agentMenu(['skills', 'memory', 'settings'], 'admin').map((d) => d.id)).toEqual([
      'agent_skills',
      'agent_memory',
      'agent_settings',
    ]);
    expect(agentMenu([], 'admin')).toEqual([]);
    expect(agentMenu(['skills'], 'member')).toEqual([]);
  });
});
