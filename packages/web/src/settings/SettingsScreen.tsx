// One settings screen (NAVIGATION §2): tabs across the top, the Tools section at the bottom.
// Each tab and each tool is its own destination; this component renders whichever is open.
//
// The tabs are the kit's `TabsNav` — real links, because each tab has its own URL and a
// fake tab would break the back button. The management pages are kit cards.
import { NavLink } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import {
  destinationsById,
  navigation,
  routeOf,
  termKey,
  visibleEntries,
} from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import { phaseOf } from '../screens/PlaceholderScreen.js';
import {
  CardHeader,
  EmptyState,
  Notice,
  Separator,
  TabsNav,
  buttonClass,
  cardClass,
} from '../ui/index.js';
import { IconAgents, IconDevices, IconKnowledge, IconModels, IconSettings } from '../ui/icons.js';
import { AccountTab } from './AccountTab.js';
import { DisplayTab } from './DisplayTab.js';
import { ThemeTool } from './ThemeTool.js';

/** The management pages keep the icon they had in the sidebar, so nothing feels moved away. */
function managementIcon(id: string) {
  const Icon =
    id === 'agent_manager'
      ? IconAgents
      : id === 'models'
        ? IconModels
        : id === 'device_connections'
          ? IconDevices
          : IconKnowledge;
  return <Icon size={16} />;
}

export function SettingsScreen({ id }: { id: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const role = user?.role ?? 'member';
  const tabs = visibleEntries(navigation.settingsTabs, role);
  const management = visibleEntries(navigation.settingsManagement, role);
  const tools = visibleEntries(navigation.settingsTools, role);
  const current = id === 'settings' ? 'account' : id;
  const destination = destinationsById.get(id);
  const isTool = navigation.settingsTools.includes(id);
  const title = t(termKey(id));

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      {!isTool && (
        <TabsNav label={t('nav.settings')} testId="settings-tabs">
          {tabs.map((d) => (
            <NavLink
              key={d.id}
              to={routeOf(d.id)}
              data-nav-id={d.id}
              className="mj-tab"
              data-active={current === d.id ? 'true' : undefined}
            >
              {t(termKey(d.id))}
            </NavLink>
          ))}
        </TabsNav>
      )}
      {destination?.global && <Notice className="mb-3">{t('settings.global_note')}</Notice>}
      <section aria-labelledby="settings-section">
        <h2 id="settings-section" className="mb-3 text-lg font-semibold">
          {t(termKey(current))}
        </h2>
        {current === 'account' && <AccountTab />}
        {current === 'display' && <DisplayTab />}
        {current === 'theme' && <ThemeTool />}
        {current !== 'account' && current !== 'display' && current !== 'theme' && (
          <EmptyState
            icon={<IconSettings size={20} />}
            title={t(termKey(current))}
            body={t('placeholder.later', {
              name: t(termKey(current)),
              phase: phaseOf(destination?.module),
            })}
          />
        )}
      </section>
      {!isTool && (
        <section className="mt-8" aria-labelledby="settings-management">
          <Separator className="mb-4" decorative={false} />
          <h2 id="settings-management" className="mb-1 text-sm font-medium text-muted">
            {t('settings.management')}
          </h2>
          <p className="mb-3 text-xs text-faint">{t('settings.management_hint')}</p>
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="settings-management">
            {management.map((d) => (
              <li key={d.id}>
                <NavLink
                  to={routeOf(d.id)}
                  data-nav-id={d.id}
                  className={cardClass('flat', 'sm', true)}
                >
                  <CardHeader
                    title={t(termKey(d.id))}
                    subtitle={t(`settings.about.${d.id}`)}
                    media={
                      <span className="settings-tile" aria-hidden>
                        {managementIcon(d.id)}
                      </span>
                    }
                  />
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!isTool && (
        <section className="mt-6" aria-labelledby="settings-tools">
          <Separator className="mb-4" decorative={false} />
          <h2 id="settings-tools" className="mb-2 text-sm font-medium text-muted">
            {t('settings.tools')}
          </h2>
          <ul className="flex flex-wrap gap-2" data-testid="settings-tools">
            {tools.map((d) => (
              <li key={d.id}>
                <NavLink
                  to={routeOf(d.id)}
                  data-nav-id={d.id}
                  className={buttonClass('secondary', 'md')}
                >
                  <span className="mj-btn-label">{t(termKey(d.id))}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {isTool && (
        <p className="mt-6">
          <NavLink to={routeOf('settings')} className="link text-sm underline">
            {t('settings.back')}
          </NavLink>
        </p>
      )}
    </AppShell>
  );
}
