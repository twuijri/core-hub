/**
 * Settings is one place with a list down its side, not a strip of tabs with the rest of
 * the pages sitting in the middle of a page (owner decision, 2026-09-22). Every
 * destination under Settings — the tabs, the management pages, the tools — is a row in
 * that list, so entering Settings shows everything Settings holds, and opening one of
 * them never hides the others.
 *
 * The list is assembled from the sidebar's own pieces (`SidebarPanel`, `SidebarGroup`,
 * `SidebarRow`), so a settings row and a sidebar row are the same row.
 *
 * On a phone there is no room for a column beside the page: the list *is* the Settings
 * index, and a page opened from it offers the way back instead. That is the fallback the
 * stylesheet makes, so no screen has to know the width.
 */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { navigation, routeOf, termKey, visibleEntries } from '../navigation/manifest.js';
import { IconAgents, IconDevices, IconKnowledge, IconModels } from '../ui/icons.js';
import { SidebarGroup, SidebarPanel, SidebarRow } from '../ui/index.js';
import { SettingsBack } from './SettingsBack.js';

/** The management pages keep the icon they had in the sidebar, so nothing feels moved. */
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

/** The Settings index: `/settings` itself, and the first tab it opens on. */
function isIndex(current: string): boolean {
  return current === 'settings' || current === 'account';
}

export function SettingsLayout({ current, children }: { current: string; children: ReactNode }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const role = user?.role ?? 'member';
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
    <div className="mj-settings" data-index={isIndex(current) ? 'true' : undefined}>
      <SidebarPanel
        label={t('nav.settings')}
        testId="settings-nav"
        data-index={isIndex(current) ? 'true' : undefined}
      >
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
                  render={({ className, children: row }) => (
                    <NavLink
                      to={routeOf(d.id)}
                      data-nav-id={d.id}
                      className={className}
                      aria-current={current === d.id ? 'page' : undefined}
                    >
                      {row}
                    </NavLink>
                  )}
                />
              ))}
            </SidebarGroup>
          );
        })}
      </SidebarPanel>
      <div className="mj-settings-body">
        {!isIndex(current) && <SettingsBack className="mj-settings-back" />}
        {children}
      </div>
    </div>
  );
}
