/**
 * Settings, in the sidebar.
 *
 * The owner's correction (2026-09-22): the list of settings **replaces the conversation
 * list** while you are in Settings — it is not a second column inside the page. The
 * sidebar is where a list of places belongs, and a page that carries its own list beside
 * the sidebar's list is two navigations arguing.
 *
 * So every destination under Settings — the tabs, the management pages, the tools — is a
 * row here, in three labelled groups, drawn with the sidebar's own `SidebarGroup` and
 * `SidebarRow`. Leaving is the rail above it: New chat, Search, Tasks, Schedules.
 */
import { NavLink } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import {
  navigation,
  routeOf,
  termKey,
  visibleEntries,
  webDestinations,
} from '../navigation/manifest.js';
import { IconAgents, IconDevices, IconKnowledge, IconModels } from '../ui/icons.js';
import { SidebarGroup, SidebarRow } from '../ui/index.js';

/**
 * Every destination that lives under Settings **and exists on the web**. `this_device` is
 * a desktop and phone page: it is in the manifest's tab list and has no web route, so
 * asking for one would throw.
 */
export const SETTINGS_IDS: readonly string[] = [
  'settings',
  ...navigation.settingsTabs,
  ...navigation.settingsManagement,
  ...navigation.settingsTools,
].filter((id) => webDestinations.some((d) => d.id === id));

/**
 * Which settings destination this path is, or `null` for anywhere else. Longest route
 * first, so `/settings/models` is Models and not the Settings index.
 */
export function settingsIdFromPath(pathname: string): string | null {
  const matches = SETTINGS_IDS.map((id) => [id, routeOf(id).split('/:')[0] ?? ''] as const)
    .filter(([, base]) => pathname === base || pathname.startsWith(`${base}/`))
    .sort((a, b) => b[1].length - a[1].length);
  return matches[0]?.[0] ?? null;
}

/** The management pages keep the icon they had, so nothing feels moved away. */
function rowIcon(id: string) {
  const Icon =
    id === 'agent_manager'
      ? IconAgents
      : id === 'models'
        ? IconModels
        : id === 'device_connections'
          ? IconDevices
          : id === 'knowledge'
            ? IconKnowledge
            : null;
  return Icon ? <Icon size={16} /> : null;
}

export function SettingsNav({
  current,
  onNavigate,
}: {
  current: string;
  onNavigate?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const role = user?.role ?? 'member';
  // The Settings index opens on Account, so Account is the row that reads as current.
  const here = current === 'settings' ? 'account' : current;
  const groups: Array<{ id: string; label?: string; ids: readonly string[] }> = [
    { id: 'settings-tabs', ids: navigation.settingsTabs },
    {
      id: 'settings-management',
      label: t('settings.management'),
      ids: navigation.settingsManagement,
    },
    { id: 'settings-tools', label: t('settings.tools'), ids: navigation.settingsTools },
  ];
  return (
    <div data-testid="settings-nav">
      {groups.map((group) => {
        const entries = visibleEntries(group.ids, role);
        if (entries.length === 0) return null;
        return (
          <SidebarGroup
            key={group.id}
            testId={group.id}
            {...(group.label ? { label: group.label } : {})}
          >
            {entries.map((d) => (
              <SidebarRow
                key={d.id}
                label={t(termKey(d.id))}
                {...(rowIcon(d.id) ? { icon: rowIcon(d.id) } : {})}
                render={({ className, children }) => (
                  <NavLink
                    to={routeOf(d.id)}
                    onClick={onNavigate}
                    data-nav-id={d.id}
                    className={className}
                    aria-current={here === d.id ? 'page' : undefined}
                  >
                    {children}
                  </NavLink>
                )}
              />
            ))}
          </SidebarGroup>
        );
      })}
    </div>
  );
}
